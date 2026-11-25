// Rooms tab: a profile for every room (unit) and common area in a building.
//
// The room list and profiles live in the rooms / room_aliases / room_events /
// unit_types tables (supabase/rooms/01-rooms.sql). Work orders are never
// changed by any of this: a room's page finds its tasks by matching the room
// text typed on each task against the room's name, plus any other spellings
// matched to it ("Apt 204" → 204). The database does that matching
// (room_summary, room_tasks, room_unmatched), so what each person sees still
// follows the task rules (Staff, for example, only see their own kinds of list).
//
// The screens, all drawn into one element:
//   "list"      — every room, with open items and last turn; add rooms here
//   "room"      — one room's profile: details, last turn, equipment, open
//                 items, full history (CSV / PDF), other spellings, change log
//   "review"    — room names typed on tasks that aren't on the list yet: match
//                 each to a room, add it as a room, or mark it "not a room"
//   "equipment" — the building's equipment by type and age, what's past its
//                 expected life and roughly what replacing it would cost;
//                 click a type for the rooms it's in (RM.eqTypeId)
//
// Equipment (supabase/rooms/02-equipment.sql): each item has a type, install
// year (empty = "Year needed", e.g. when added from a unit type's standard
// equipment) and optional brand / model / serial / warranty / notes. Replaced
// items stay on the room's page, marked replaced.
//
// Used in two places: the Rooms tab (Admins, Editors, Viewers, the
// Executive) and the Staff screen's "Rooms" switch (techs, front desk).

var RM = {
  el: null,          // where it's drawn
  mode: "office",    // "office" (Rooms tab) or "staff" (Staff screen)
  codes: [],         // buildings it may show
  code: null,        // building being shown
  view: "list",      // "list" | "room" | "review"
  roomId: null,      // room whose profile is open
  rooms: [],
  aliases: [],
  summary: {},       // room id -> { open_count, total, last_turned, last_activity }
  unitTypes: [],
  equipTypes: [],    // the company's equipment types
  templates: [],     // unit_type_equipment rows: a unit type's standard equipment
  buildingEquip: null, // the building's equipment in service (Equipment view)
  eqTypeId: null,    // the type opened in the Equipment view
  eqForm: null,      // { mode: "add" | "edit" | "replace", id } on a room's page
  unmatchedCount: 0,
  search: "",
  filter: "all",     // "all" | "unit" | "common"
  showArchived: false,
  adding: false,
  canWork: false,    // add and edit rooms (Admins, Editors, Staff, the Executive)
  canTypes: false,   // edit the unit-type list (Admins, Editors, the Executive)
  loadSeq: 0,
  profile: null      // the open room's tasks, notes, photos and change log
};

// ── The ways in ──────────────────────────────────────────────────────────────

// The Rooms tab: the same buildings as the Work Orders lists.
function openRoomsTab() {
  var panel = document.getElementById("roomsPanel");
  var codes = listBuildings().map(function(p) { return p.code; });
  if (!codes.length) { panel.innerHTML = '<div class="tk-empty">No buildings to show.</div>'; return; }
  // The community picked in the header wins; otherwise stay on the building
  // already showing (e.g. under "All communities").
  var keep = codes.indexOf(activeCommunity) !== -1 ? activeCommunity
    : RM.el === panel && codes.indexOf(RM.code) !== -1 ? RM.code : codes[0];
  rmOpen(panel, "office", codes, keep);
}

// Shown once there's a building whose lists are on StoneAnchor (or always for
// Admins and the Executive, same as the Work Orders lists).
function updateRoomsTabVisibility() {
  var tab = document.getElementById("tabRooms");
  if (tab) tab.style.display = listBuildings().length ? "" : "none";
}

// The Staff screen's "Lists · Rooms" switch. Remembered per browser.
function staffView() {
  try { return localStorage.getItem("staffView") === "rooms" ? "rooms" : "lists"; } catch (e) { return "lists"; }
}

function setStaffView(view) {
  try { localStorage.setItem("staffView", view); } catch (e) {}
  showStaffView();
}

function showStaffView() {
  var view = staffView();
  document.querySelectorAll("#staffSwitch [data-staff-view]").forEach(function(b) {
    b.classList.toggle("active", b.getAttribute("data-staff-view") === view);
  });
  document.getElementById("staffTasks").style.display = view === "lists" ? "" : "none";
  document.getElementById("staffRooms").style.display = view === "rooms" ? "" : "none";
  if (view === "rooms") {
    var codes = visibleProperties().map(function(p) { return p.code; });
    var code = (typeof TK !== "undefined" && TK.code) || codes[0];
    if (RM.el && RM.mode === "staff" && RM.code === code) return;
    rmOpen(document.getElementById("staffRooms"), "staff", codes, code);
  }
}

// The Staff screen's building picker changed (staffSwitchBuilding in js/tasks.js).
function rmBuildingChanged(code) {
  if (RM.mode === "staff" && RM.el && RM.code !== code) rmSwitchBuilding(code);
}

function rmOpen(el, mode, codes, code) {
  var role = currentProfile ? currentProfile.role : "";
  RM.el = el;
  RM.mode = mode;
  RM.codes = codes;
  RM.canWork = isExecutive() || role === "admin" || role === "editor" || role === "staff";
  RM.canTypes = isExecutive() || role === "admin" || role === "editor";
  if (RM.code !== code) { RM.view = "list"; RM.roomId = null; RM.adding = false; }
  RM.code = code;
  rmLoad();
}

function rmSwitchBuilding(code) {
  RM.code = code;
  RM.view = "list";
  RM.roomId = null;
  RM.adding = false;
  RM.search = "";
  rmLoad();
}

// ── Small helpers ────────────────────────────────────────────────────────────

function rmProp() {
  return ALL_PROPERTIES.find(function(p) { return p.code === RM.code; }) || {};
}

function rmTimeZone() {
  return rmProp().timeZone || "America/Denver";
}

// "Nov 5, 2026, 2:14 PM" / "Nov 5, 2026" in the building's own time zone.
function rmStamp(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleString("en-US", { timeZone: rmTimeZone(), month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function rmDate(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleDateString("en-US", { timeZone: rmTimeZone(), month: "short", day: "numeric", year: "numeric" });
}

// "204" and "  apt  204 " → the same key, as room_key() does in the database.
function rmKey(s) {
  return String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
}

// 101, 102 … 110, then "Lobby" — numbers in number order.
function rmCompareNames(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function rmRoom(id) {
  return RM.rooms.find(function(r) { return r.id === id; });
}

function rmTypeName(id) {
  var t = RM.unitTypes.find(function(u) { return u.id === id; });
  return t ? t.name : "";
}

function rmActiveRooms() {
  return RM.rooms.filter(function(r) { return !r.archived_at; });
}

function rmFail(what, err) {
  console.error(err);
  alert(what + ": " + (err && err.message ? err.message : err));
}

// The list each task came from, as a short label.
var RM_KIND_LABELS = { work_orders: "Work order", pm: "PM", room_turns: "Room turn", compliance: "Compliance", other: "Other" };

// ── Loading ──────────────────────────────────────────────────────────────────

async function rmLoad() {
  var seq = ++RM.loadSeq;
  if (!RM.rooms.length || RM.rooms[0].property_code !== RM.code) {
    RM.el.innerHTML = '<div class="rm"><div class="tk-muted" style="padding:24px 0">Loading rooms…</div></div>';
  }
  var prop = rmProp();
  var res = await Promise.all([
    sb.from("rooms").select("*").eq("property_code", RM.code),
    sb.from("room_aliases").select("*").eq("property_code", RM.code).is("archived_at", null),
    sb.rpc("room_summary", { p_code: RM.code }),
    sb.from("unit_types").select("*").eq("company_id", prop.companyId).order("sort_order"),
    sb.rpc("room_unmatched", { p_code: RM.code }),
    sb.from("equipment_types").select("*").eq("company_id", prop.companyId).order("sort_order"),
    sb.from("unit_type_equipment").select("*")
  ]);
  if (seq !== RM.loadSeq) return;
  var failed = res.find(function(r) { return r.error; });
  if (failed) {
    RM.el.innerHTML = '<div class="rm"><div class="tk-empty"><p>Couldn\'t load rooms: ' + escapeHtml(failed.error.message) + '</p>' +
      '<button type="button" class="config-btn" data-rm="retry">Try again</button></div></div>';
    rmWire();
    return;
  }
  RM.rooms = res[0].data;
  RM.aliases = res[1].data;
  RM.summary = {};
  res[2].data.forEach(function(s) { RM.summary[s.room_id] = s; });
  RM.unitTypes = res[3].data;
  RM.unmatched = res[4].data;
  RM.unmatchedCount = res[4].data.length;
  RM.equipTypes = res[5].data;
  // Only this company's unit types (the Executive can read every company's).
  var typeIds = RM.unitTypes.map(function(t) { return t.id; });
  RM.templates = res[6].data.filter(function(t) { return typeIds.indexOf(t.unit_type_id) !== -1; });
  RM.buildingEquip = null;
  if (RM.view === "room" && !rmRoom(RM.roomId)) RM.view = "list";
  rmRender();
  if (RM.view === "room") rmLoadProfile();
  if (RM.view === "equipment") rmLoadBuildingEquip();
}

// ── Drawing ──────────────────────────────────────────────────────────────────

function rmRender() {
  var body = RM.view === "room" ? rmRoomHtml() : RM.view === "review" ? rmReviewHtml()
    : RM.view === "equipment" ? rmEquipViewHtml() : rmListHtml();
  RM.el.innerHTML = '<div class="rm">' + rmHeaderHtml() + body + '</div>';
  rmWire();
  if (RM.view === "list" && RM.adding) {
    var box = RM.el.querySelector("[name='names']");
    if (box) box.focus();
    rmUpdateAddPreview();
  }
}

function rmHeaderHtml() {
  // On the Staff screen the building picker is in the screen's own header.
  var picker = RM.mode !== "staff" && RM.codes.length > 1
    ? '<select class="tk-building" data-rm="building" aria-label="Building">' + RM.codes.map(function(c) {
        return '<option value="' + escapeHtml(c) + '"' + (c === RM.code ? " selected" : "") + '>' + escapeHtml(communityLabel(c)) + '</option>';
      }).join("") + '</select>'
    : (RM.mode !== "staff" ? '<span class="rm-building-name">' + escapeHtml(communityLabel(RM.code)) + '</span>' : "");
  var section = RM.view === "equipment" ? "equipment" : "list";
  return '<div class="rm-head"><div class="rm-head-left"><h2 class="rm-title">Rooms</h2>' + picker +
      '<div class="wo-switch rm-filter rm-section-switch">' +
        '<button type="button" data-rm="section" data-value="list" class="' + (section === "list" ? "active" : "") + '">Room list</button>' +
        '<button type="button" data-rm="section" data-value="equipment" class="' + (section === "equipment" ? "active" : "") + '">Equipment</button>' +
      '</div></div>' +
    (RM.canTypes ? '<button type="button" class="tk-tool-btn" data-rm="types">Set up types</button>' : "") + '</div>';
}

// The room list.
function rmListHtml() {
  var active = rmActiveRooms();
  var archivedCount = RM.rooms.length - active.length;
  var q = rmKey(RM.search);
  var shown = (RM.showArchived ? RM.rooms : active).filter(function(r) {
    if (RM.filter !== "all" && r.kind !== RM.filter) return false;
    if (!q) return true;
    if (rmKey(r.name).indexOf(q) !== -1 || rmKey(rmTypeName(r.unit_type_id)).indexOf(q) !== -1) return true;
    return RM.aliases.some(function(a) { return a.room_id === r.id && rmKey(a.alias).indexOf(q) !== -1; });
  }).sort(function(a, b) {
    if (a.kind !== b.kind) return a.kind === "unit" ? -1 : 1;
    return rmCompareNames(a.name, b.name);
  });

  var units = active.filter(function(r) { return r.kind === "unit"; }).length;
  var html =
    '<div class="rm-toolbar">' +
      '<input type="search" class="config-input rm-search" data-rm="search" placeholder="Find a room…" value="' + escapeHtml(RM.search) + '" aria-label="Find a room" />' +
      '<div class="wo-switch rm-filter">' +
        [["all", "All"], ["unit", "Units"], ["common", "Common areas"]].map(function(f) {
          return '<button type="button" data-rm="filter" data-value="' + f[0] + '" class="' + (RM.filter === f[0] ? "active" : "") + '">' + f[1] + '</button>';
        }).join("") +
      '</div>' +
      '<div class="rm-toolbar-right">' +
        (RM.canWork && RM.unmatchedCount ? '<button type="button" class="tk-tool-btn rm-review-btn" data-rm="review">Review room names <span class="rm-count">' + RM.unmatchedCount + '</span></button>' : "") +
        (RM.canWork ? '<button type="button" class="config-btn" data-rm="add">+ Add rooms</button>' : "") +
      '</div>' +
    '</div>';

  if (RM.adding) html += rmAddFormHtml();

  html += '<div class="rm-counts tk-muted">' + units + ' unit' + (units === 1 ? "" : "s") + ' · ' +
    (active.length - units) + ' common area' + (active.length - units === 1 ? "" : "s") +
    (archivedCount ? ' · <button type="button" class="link-btn" data-rm="archived">' + (RM.showArchived ? "Hide" : "Show") + ' ' + archivedCount + ' archived</button>' : "") +
    '</div>';

  if (!RM.rooms.length) {
    return html + '<div class="tk-empty"><p><b>No rooms on the list yet.</b></p>' +
      (RM.canWork
        ? '<p>Add them with <b>+ Add rooms</b> — you can type a range like <b>101-124</b> to add many at once.' +
          (RM.unmatchedCount ? ' Or start from the <b>' + RM.unmatchedCount + '</b> room names already typed on work orders: <button type="button" class="link-btn" data-rm="review">Review room names</button>.' : "") + '</p>'
        : '<p>Someone who logs work orders can add them.</p>') +
      '</div>';
  }
  if (!shown.length) return html + '<div class="tk-empty"><p>No rooms match.</p></div>';

  html += '<div class="rm-table" role="table">' +
    '<div class="rm-row rm-row-head" role="row"><div>Room</div><div>Type</div><div class="rm-col-floor">Floor</div>' +
    '<div class="rm-col-num">Open</div><div class="rm-col-date">Last turned</div><div class="rm-col-date rm-col-activity">Last activity</div></div>';
  shown.forEach(function(r) {
    var s = RM.summary[r.id] || {};
    html += '<div class="rm-row rm-room-row' + (r.archived_at ? " rm-archived" : "") + '" role="row" data-rm="room" data-id="' + r.id + '" tabindex="0">' +
      '<div class="rm-name">' + escapeHtml(r.name) + (r.archived_at ? ' <span class="rm-chip">Archived</span>' : "") + '</div>' +
      '<div class="tk-muted">' + escapeHtml(r.kind === "common" ? "Common area" : rmTypeName(r.unit_type_id) || "—") + '</div>' +
      '<div class="rm-col-floor tk-muted">' + escapeHtml(r.floor || "—") + '</div>' +
      '<div class="rm-col-num">' + (s.open_count ? '<span class="rm-open">' + s.open_count + '</span>' : '<span class="tk-muted">0</span>') + '</div>' +
      '<div class="rm-col-date">' + (s.last_turned ? escapeHtml(rmDate(s.last_turned)) : '<span class="tk-muted">—</span>') + '</div>' +
      '<div class="rm-col-date rm-col-activity tk-muted">' + (s.last_activity ? escapeHtml(rmDate(s.last_activity)) : "—") + '</div>' +
    '</div>';
  });
  return html + '</div>';
}

function rmTypeOptions(selected, blank) {
  return (blank ? '<option value="">' + blank + '</option>' : "") +
    RM.unitTypes.filter(function(t) { return !t.archived || t.id === selected; }).map(function(t) {
      return '<option value="' + t.id + '"' + (t.id === selected ? " selected" : "") + '>' + escapeHtml(t.name) + '</option>';
    }).join("");
}

function rmAddFormHtml() {
  return '<form class="rm-add" data-rm="add-form" autocomplete="off">' +
    '<div class="rm-add-fields">' +
      '<label class="rm-field rm-field-wide">Room numbers or names' +
        '<input class="config-input" name="names" placeholder="e.g. 101-124, 201-224 or Lobby, Pool" required /></label>' +
      '<label class="rm-field">Kind<select class="config-input" name="kind">' +
        '<option value="unit">Unit</option><option value="common">Common area</option></select></label>' +
      '<label class="rm-field" data-rm="type-field">Unit type<select class="config-input" name="unit_type">' + rmTypeOptions(null, "—") + '</select></label>' +
      '<label class="rm-field rm-field-small">Floor<input class="config-input" name="floor" placeholder="optional" /></label>' +
    '</div>' +
    '<div class="rm-add-foot"><span class="rm-add-preview tk-muted"></span>' +
      '<span><button type="button" class="tk-tool-btn" data-rm="add-cancel">Cancel</button> ' +
      '<button type="submit" class="config-btn">Add</button></span></div>' +
  '</form>';
}

// "101-124, Lobby" → ["101", "102", … "124", "Lobby"]. A range keeps any
// letters in front ("A101-A110") and leading zeros ("001-012").
function rmParseNames(text) {
  var names = [], bad = [];
  String(text || "").split(/[,\n]+/).forEach(function(part) {
    part = part.trim().replace(/\s+/g, " ");
    if (!part) return;
    var m = part.match(/^(.*?)(\d+)\s*(?:-|–|—|\bto\b)\s*\1?(\d+)$/i);
    if (m && !/\d$/.test(m[1])) {
      var from = parseInt(m[2], 10), to = parseInt(m[3], 10);
      if (to < from || to - from > 499) { bad.push(part); return; }
      var width = m[2].length > 1 && m[2][0] === "0" ? m[2].length : 0;
      for (var n = from; n <= to; n++) {
        var s = String(n);
        while (s.length < width) s = "0" + s;
        names.push(m[1] + s);
      }
    } else {
      names.push(part);
    }
  });
  return { names: names, bad: bad };
}

// Every name and matched spelling already in use, so adding skips them.
function rmTakenKeys() {
  var taken = {};
  rmActiveRooms().forEach(function(r) { taken[rmKey(r.name)] = r.name; });
  RM.aliases.forEach(function(a) { if (a.room_id) taken[rmKey(a.alias)] = (rmRoom(a.room_id) || {}).name; });
  return taken;
}

function rmUpdateAddPreview() {
  var form = RM.el.querySelector("[data-rm='add-form']");
  if (!form) return;
  form.querySelector("[data-rm='type-field']").style.display = form.kind.value === "unit" ? "" : "none";
  var parsed = rmParseNames(form.names.value);
  var taken = rmTakenKeys();
  var fresh = parsed.names.filter(function(n) { return !taken[rmKey(n)]; });
  var already = parsed.names.length - fresh.length;
  var out = form.querySelector(".rm-add-preview");
  if (!parsed.names.length && !parsed.bad.length) { out.textContent = "Separate rooms with commas. A range like 101-124 adds every number in between."; return; }
  var bits = [];
  if (fresh.length) bits.push("Will add " + fresh.length + ": " + (fresh.length > 6 ? fresh.slice(0, 3).join(", ") + " … " + fresh.slice(-2).join(", ") : fresh.join(", ")));
  if (already) bits.push(already + " already on the list (skipped)");
  if (parsed.bad.length) bits.push("Can't read: " + parsed.bad.join(", "));
  out.textContent = bits.join(" · ");
}

async function rmSubmitAdd(form) {
  var parsed = rmParseNames(form.names.value);
  if (parsed.bad.length) { alert("Can't read “" + parsed.bad.join(", ") + "”. A range goes low to high, like 101-124 (at most 500 rooms at once)."); return; }
  var taken = rmTakenKeys();
  var seen = {};
  var fresh = parsed.names.filter(function(n) {
    var k = rmKey(n);
    if (taken[k] || seen[k]) return false;
    seen[k] = true;
    return true;
  });
  if (!fresh.length) { alert("Those are all on the list already."); return; }
  var kind = form.kind.value;
  var rows = fresh.map(function(n) {
    return { property_code: RM.code, name: n, kind: kind, unit_type_id: kind === "unit" ? (form.unit_type.value || null) : null, floor: form.floor.value.trim() };
  });
  var btn = form.querySelector("[type='submit']");
  btn.disabled = true;
  btn.textContent = "Adding…";
  var res = await sb.from("rooms").insert(rows);
  if (res.error) { btn.disabled = false; btn.textContent = "Add"; rmFail("Couldn't add those rooms", res.error); return; }
  RM.adding = false;
  rmLoad();
}

// ── One room's profile ───────────────────────────────────────────────────────

function rmOpenRoom(id) {
  RM.view = "room";
  RM.roomId = id;
  RM.profile = null;
  RM.eqForm = null;
  rmRender();
  rmLoadProfile();
  window.scrollTo(0, 0);
}

async function rmLoadProfile() {
  var id = RM.roomId;
  var seq = ++RM.loadSeq;
  var res = await Promise.all([
    sb.rpc("room_tasks", { p_room: id }),
    sb.from("room_events").select("*").eq("room_id", id).order("created_at", { ascending: false }),
    sb.from("room_equipment").select("*").eq("room_id", id).order("created_at")
  ]);
  if (seq !== RM.loadSeq || RM.roomId !== id) return;
  var failed = res.find(function(r) { return r.error; });
  if (failed) { rmFail("Couldn't load this room's history", failed.error); return; }
  var tasks = res[0].data;
  // Notes for every task (a few at a time, so the request stays short).
  var notes = {};
  var ids = tasks.map(function(t) { return t.id; });
  for (var i = 0; i < ids.length; i += 150) {
    var n = await sb.from("task_notes").select("task_id, body, author_name, created_at").in("task_id", ids.slice(i, i + 150)).order("created_at");
    if (n.error) break;
    n.data.forEach(function(x) { (notes[x.task_id] = notes[x.task_id] || []).push(x); });
  }
  // The last finished room turn, with its photos.
  var lastTurn = tasks.filter(function(t) { return t.list_kind === "room_turns" && t.completed_at && !t.cancelled_at; })
    .sort(function(a, b) { return a.completed_at < b.completed_at ? 1 : -1; })[0] || null;
  var photos = [];
  if (lastTurn) {
    var p = await sb.from("task_photos").select("storage_path, file_name").eq("task_id", lastTurn.id).order("created_at");
    if (!p.error && p.data.length) {
      var signed = await sb.storage.from("task-files").createSignedUrls(p.data.map(function(x) { return x.storage_path; }), 3600);
      if (!signed.error) photos = signed.data.map(function(s, k) { return { url: s.signedUrl, name: p.data[k].file_name }; }).filter(function(x) { return x.url; });
    }
  }
  if (seq !== RM.loadSeq || RM.roomId !== id) return;
  RM.profile = { tasks: tasks, notes: notes, events: res[1].data, equipment: res[2].data, lastTurn: lastTurn, photos: photos };
  rmRender();
}

function rmRoomHtml() {
  var r = rmRoom(RM.roomId);
  if (!r) return "";
  var P = RM.profile;
  var dis = RM.canWork ? "" : " disabled";
  var aliases = RM.aliases.filter(function(a) { return a.room_id === r.id; });
  var html =
    '<button type="button" class="link-btn rm-back" data-rm="back">← All rooms</button>' +
    '<div class="rm-profile-head">' +
      '<h3 class="rm-room-name">' + escapeHtml(r.name) + '</h3>' +
      '<span class="rm-chip">' + (r.kind === "common" ? "Common area" : escapeHtml(rmTypeName(r.unit_type_id) || "Unit")) + '</span>' +
      (r.floor ? '<span class="rm-chip">Floor ' + escapeHtml(r.floor) + '</span>' : "") +
      (r.archived_at ? '<span class="rm-chip rm-chip-warn">Archived ' + escapeHtml(rmDate(r.archived_at)) + '</span>' : "") +
    '</div>';

  if (!P) return html + '<div class="tk-muted" style="padding:20px 0">Loading this room\'s history…</div>';

  var live = P.tasks.filter(function(t) { return !t.cancelled_at; });
  var open = live.filter(function(t) { return !t.completed_at; });
  var yearAgo = new Date();
  yearAgo.setFullYear(yearAgo.getFullYear() - 1);
  var lastYear = live.filter(function(t) { return new Date(t.created_at) >= yearAgo; }).length;
  var LT = P.lastTurn;

  html += '<div class="rm-tiles">' +
    rmTile(open.length, "Open now") +
    rmTile(LT ? rmDate(LT.completed_at) : "—", "Last turned") +
    rmTile(lastYear, "Logged in the<br>past 12 months") +
    rmTile(live.length, "All time") +
  '</div>';

  html += '<div class="rm-columns">' +
    // Details
    '<form class="rm-card rm-details" data-rm="details-form" autocomplete="off">' +
      '<div class="rm-card-title">Details</div>' +
      '<label class="rm-field">Name<input class="config-input" name="name" value="' + escapeHtml(r.name) + '"' + dis + ' required /></label>' +
      '<div class="rm-field-pair">' +
        '<label class="rm-field">Kind<select class="config-input" name="kind"' + dis + '>' +
          '<option value="unit"' + (r.kind === "unit" ? " selected" : "") + '>Unit</option>' +
          '<option value="common"' + (r.kind === "common" ? " selected" : "") + '>Common area</option></select></label>' +
        '<label class="rm-field" data-rm="type-field"' + (r.kind === "common" ? ' style="display:none"' : "") + '>Unit type<select class="config-input" name="unit_type"' + dis + '>' + rmTypeOptions(r.unit_type_id, "—") + '</select></label>' +
        '<label class="rm-field">Floor<input class="config-input" name="floor" value="' + escapeHtml(r.floor) + '"' + dis + ' /></label>' +
      '</div>' +
      '<label class="rm-field">Notes<textarea class="config-input" name="notes" rows="3" placeholder="Anything worth knowing about this room"' + dis + '>' + escapeHtml(r.notes) + '</textarea></label>' +
      (RM.canWork
        ? '<div class="rm-card-foot"><button type="button" class="link-btn" data-rm="archive">' + (r.archived_at ? "Restore room" : "Archive room") + '</button>' +
          '<button type="submit" class="config-btn" data-rm="save" disabled>Save</button></div>'
        : "") +
    '</form>' +
    // Last turn
    '<div class="rm-card rm-last-turn">' +
      '<div class="rm-card-title">Last turn</div>' +
      (LT
        ? '<div class="rm-lt-when"><b>' + escapeHtml(rmStamp(LT.completed_at)) + '</b>' + (LT.completed_by_name ? ' · ' + escapeHtml(LT.completed_by_name) : "") + '</div>' +
          '<div class="rm-lt-title">' + escapeHtml(LT.title || "(no description)") + '</div>' +
          (LT.details ? '<div class="rm-lt-details">' + escapeHtml(LT.details) + '</div>' : "") +
          rmNotesHtml(P.notes[LT.id]) +
          (P.photos.length ? '<div class="rm-photos">' + P.photos.map(function(ph) {
            return '<a href="' + escapeHtml(ph.url) + '" target="_blank" rel="noopener" title="' + escapeHtml(ph.name) + '"><img src="' + escapeHtml(ph.url) + '" alt="' + escapeHtml(ph.name) + '" loading="lazy" /></a>';
          }).join("") + '</div>' : "")
        : '<p class="tk-muted">No finished room turn logged for this room yet. Turns come from the Room Turns list.</p>') +
    '</div>' +
  '</div>';

  html += rmEquipSectionHtml(r, P.equipment);

  // Open items
  if (open.length) {
    html += '<div class="rm-section"><div class="rm-section-title">Open now</div>' + rmTaskListHtml(open, P.notes) + '</div>';
  }

  // History
  html += '<div class="rm-section"><div class="rm-section-head"><div class="rm-section-title">Full history</div>' +
    (P.tasks.length ? '<div><button type="button" class="tk-tool-btn" data-rm="csv">Download CSV</button> <button type="button" class="tk-tool-btn" data-rm="pdf">Download PDF</button></div>' : "") + '</div>' +
    (P.tasks.length
      ? '<p class="tk-muted rm-section-note">Every work order, PM and room turn logged for this room — open, completed and cancelled. Click one to see its notes.</p>' + rmTaskListHtml(P.tasks, P.notes)
      : '<p class="tk-muted">Nothing logged for this room yet.</p>') +
  '</div>';

  // Other spellings
  html += '<div class="rm-section"><div class="rm-section-title">Also known as</div>' +
    '<p class="tk-muted rm-section-note">Work orders typed with any of these spellings show up on this room\'s page.</p>' +
    (aliases.length
      ? '<div class="rm-aliases">' + aliases.map(function(a) {
          return '<span class="rm-alias">' + escapeHtml(a.alias) +
            (RM.canWork ? '<button type="button" data-rm="unmatch" data-id="' + a.id + '" aria-label="Un-match ' + escapeHtml(a.alias) + '" title="Un-match">&times;</button>' : "") + '</span>';
        }).join("") + '</div>'
      : '<p class="tk-muted">No other spellings.</p>') +
    (RM.canWork
      ? '<form class="rm-alias-add" data-rm="alias-form" autocomplete="off"><input class="config-input" name="alias" list="rmUnmatchedOptions" placeholder="Add a spelling, e.g. Apt ' + escapeHtml(r.name) + '" />' +
        '<datalist id="rmUnmatchedOptions">' + (RM.unmatched || []).map(function(u) { return '<option value="' + escapeHtml(u.spelling) + '">'; }).join("") + '</datalist>' +
        '<button type="submit" class="tk-tool-btn">Add</button></form>'
      : "") +
  '</div>';

  // Change log
  html += '<details class="rm-section rm-log"><summary class="rm-section-title">Change log (' + P.events.length + ')</summary>' +
    (P.events.length ? '<ul>' + P.events.map(function(e) {
      return '<li><span class="tk-muted">' + escapeHtml(rmStamp(e.created_at)) + '</span> · <b>' + escapeHtml(e.actor_name || "") + '</b> ' + escapeHtml(rmEventText(e)) + '</li>';
    }).join("") + '</ul>' : '<p class="tk-muted">No changes yet.</p>') +
  '</details>';
  return html;
}

function rmTile(value, label) {
  return '<div class="rm-tile"><div class="rm-tile-value">' + escapeHtml(String(value)) + '</div><div class="rm-tile-label">' + label + '</div></div>';
}

function rmEventText(e) {
  switch (e.event_type) {
    case "created": return "added this room";
    case "edited": return "changed " + (e.detail || "details");
    case "archived": return "archived this room";
    case "restored": return "restored this room";
    case "matched": return "matched the spelling “" + (e.detail || "") + "”";
    case "unmatched": return "un-matched the spelling “" + (e.detail || "") + "”";
    case "equipment_added": return "added " + (e.detail || "equipment");
    case "equipment_replaced": return "marked " + (e.detail || "equipment") + " replaced";
    case "equipment_edited": return "updated " + (e.detail || "equipment");
    default: return e.event_type + (e.detail ? ": " + e.detail : "");
  }
}

function rmNotesHtml(notes) {
  if (!notes || !notes.length) return "";
  return '<ul class="rm-notes">' + notes.map(function(n) {
    return '<li><span class="tk-muted">' + escapeHtml(rmStamp(n.created_at)) + ' · ' + escapeHtml(n.author_name || "") + '</span><br>' + escapeHtml(n.body) + '</li>';
  }).join("") + '</ul>';
}

function rmTaskStatus(t) {
  if (t.cancelled_at) return { cls: "tk-badge-cancelled", label: "Cancelled", when: t.cancelled_at, by: t.cancelled_by_name };
  if (t.completed_at) return { cls: "tk-badge-done", label: "Completed", when: t.completed_at, by: t.completed_by_name };
  return { cls: "tk-badge-open", label: "Open", when: null, by: null };
}

function rmTaskListHtml(tasks, notes) {
  return '<div class="rm-tasks">' + tasks.map(function(t) {
    var st = rmTaskStatus(t);
    var n = (notes[t.id] || []).length;
    var showRoom = rmKey(t.room) !== rmKey((rmRoom(RM.roomId) || {}).name);
    return '<details class="rm-task">' +
      '<summary>' +
        '<span class="rm-task-date">' + escapeHtml(rmDate(t.created_at)) + '</span>' +
        '<span class="rm-task-title">' + escapeHtml(t.title || "(no description)") +
          '<span class="tk-list-chip">' + escapeHtml(t.list_name || RM_KIND_LABELS[t.list_kind] || "") + '</span>' +
          (showRoom ? '<span class="tk-muted rm-task-room">typed as “' + escapeHtml(t.room) + '”</span>' : "") +
          (n ? '<span class="tk-muted rm-task-room">' + n + ' note' + (n === 1 ? "" : "s") + '</span>' : "") + '</span>' +
        '<span class="tk-badge ' + st.cls + '">' + st.label + '</span>' +
      '</summary>' +
      '<div class="rm-task-body">' +
        '<div class="tk-muted">Logged ' + escapeHtml(rmStamp(t.created_at)) + (t.created_by_name ? ' by ' + escapeHtml(t.created_by_name) : "") +
          (st.when ? ' · ' + st.label + ' ' + escapeHtml(rmStamp(st.when)) + (st.by ? ' by ' + escapeHtml(st.by) : "") : "") +
          (t.cancel_reason ? ' — ' + escapeHtml(t.cancel_reason) : "") + '</div>' +
        (t.details ? '<div class="rm-task-details">' + escapeHtml(t.details) + '</div>' : "") +
        (n ? rmNotesHtml(notes[t.id]) : '<div class="tk-muted">No notes.</div>') +
      '</div>' +
    '</details>';
  }).join("") + '</div>';
}

async function rmSaveDetails(form) {
  var r = rmRoom(RM.roomId);
  var kind = form.kind.value;
  var change = {
    name: form.name.value.trim(),
    kind: kind,
    unit_type_id: kind === "unit" ? (form.unit_type.value || null) : null,
    floor: form.floor.value.trim(),
    notes: form.notes.value.trim()
  };
  if (!change.name) { alert("A room needs a name."); return; }
  var btn = form.querySelector("[data-rm='save']");
  btn.disabled = true;
  btn.textContent = "Saving…";
  var res = await sb.from("rooms").update(change).eq("id", r.id);
  btn.textContent = "Save";
  if (res.error) { btn.disabled = false; rmFail("Couldn't save", res.error); return; }
  rmLoad();
}

async function rmToggleArchive() {
  var r = rmRoom(RM.roomId);
  if (!r.archived_at && !confirm("Archive " + r.name + "? It comes off the room list and the Room box suggestions, but keeps its history and can be restored any time.")) return;
  var res = await sb.from("rooms").update({ archived_at: r.archived_at ? null : new Date().toISOString() }).eq("id", r.id);
  if (res.error) { rmFail(r.archived_at ? "Couldn't restore" : "Couldn't archive", res.error); return; }
  if (!r.archived_at) RM.showArchived = true;
  rmLoad();
}

async function rmAddAlias(form) {
  var alias = form.alias.value.trim().replace(/\s+/g, " ");
  if (!alias) return;
  var taken = rmTakenKeys()[rmKey(alias)];
  if (taken) { alert("“" + alias + "” already points to room " + taken + "."); return; }
  var res = await sb.from("room_aliases").insert({ property_code: RM.code, alias: alias, room_id: RM.roomId });
  if (res.error) { rmFail("Couldn't add that spelling", res.error); return; }
  rmLoad();
}

async function rmUnmatch(aliasId) {
  var a = RM.aliases.find(function(x) { return x.id === aliasId; });
  if (!a || !confirm("Un-match “" + a.alias + "”? Work orders typed that way will leave this room's page and go back on the review list.")) return;
  var res = await sb.from("room_aliases").update({ archived_at: new Date().toISOString() }).eq("id", aliasId);
  if (res.error) { rmFail("Couldn't un-match", res.error); return; }
  rmLoad();
}

// ── History downloads (same columns as the Room history report in Lists) ────

function rmHistoryLines() {
  var P = RM.profile;
  return P.tasks.map(function(t) {
    var st = rmTaskStatus(t);
    return {
      created: rmStamp(t.created_at), createdBy: t.created_by_name || "", list: t.list_name || "", typedAs: t.room,
      workOrder: t.title || "", details: t.details || "", status: st.label,
      closed: t.cancelled_at ? rmStamp(t.cancelled_at) + " — " + (t.cancel_reason || "") : rmStamp(t.completed_at),
      closedBy: st.by || "",
      notes: (P.notes[t.id] || []).map(function(n) { return rmStamp(n.created_at) + " (" + (n.author_name || "") + "): " + n.body; }).join("\n")
    };
  });
}

function rmHistoryFileName(ext) {
  var r = rmRoom(RM.roomId);
  return "room-history_" + RM.code + "_" + r.name.replace(/[^A-Za-z0-9]+/g, "-") + "_" + new Date().toLocaleDateString("en-CA", { timeZone: rmTimeZone() }) + "." + ext;
}

function rmHistoryCsv() {
  var head = ["Created", "Created by", "List", "Typed as", "Work order", "Description", "Status", "Completed / cancelled", "By", "Notes"];
  var lines = [head.map(csvField).join(",")].concat(rmHistoryLines().map(function(x) {
    return [x.created, x.createdBy, x.list, x.typedAs, x.workOrder, x.details, x.status, x.closed, x.closedBy, x.notes].map(csvField).join(",");
  }));
  var a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([lines.join("\r\n")], { type: "text/csv" }));
  a.download = rmHistoryFileName("csv");
  a.click();
  setTimeout(function() { URL.revokeObjectURL(a.href); }, 1000);
}

function rmHistoryPdf() {
  var r = rmRoom(RM.roomId);
  var live = RM.profile.tasks.filter(function(t) { return !t.cancelled_at; }).length;
  var doc = new window.jspdf.jsPDF({ orientation: "landscape", unit: "pt", format: "letter" });
  doc.setFontSize(16);
  doc.text(rmProp().name + " — " + (r.kind === "common" ? "Common area " : "Room ") + r.name, 40, 44);
  doc.setFontSize(10);
  doc.text(live + " request" + (live === 1 ? "" : "s") + " · All time · Printed " + rmStamp(new Date().toISOString()) + " (" + rmTimeZone() + ")", 40, 62);
  doc.autoTable({
    startY: 76,
    head: [["Created", "Work order", "Status", "Completed / cancelled", "Notes"]],
    body: rmHistoryLines().map(function(x) {
      return [x.created + "\n" + x.createdBy, x.workOrder + (x.details ? "\n" + x.details : "") + "\n(" + x.list + (rmKey(x.typedAs) !== rmKey(r.name) ? ", typed as “" + x.typedAs + "”" : "") + ")",
        x.status, x.closed + (x.closedBy ? "\n" + x.closedBy : ""), x.notes];
    }),
    styles: { fontSize: 8, cellPadding: 4, valign: "top" },
    headStyles: { fillColor: [148, 73, 47] },
    columnStyles: { 0: { cellWidth: 110 }, 1: { cellWidth: 200 }, 2: { cellWidth: 60 }, 3: { cellWidth: 120 } }
  });
  doc.save(rmHistoryFileName("pdf"));
}

// ── Review room names ────────────────────────────────────────────────────────

function rmReviewHtml() {
  var rows = RM.unmatched || [];
  var roomOptions = rmActiveRooms().slice().sort(function(a, b) { return rmCompareNames(a.name, b.name); }).map(function(r) {
    return '<option value="' + r.id + '">' + escapeHtml(r.name) + '</option>';
  }).join("");
  var html = '<button type="button" class="link-btn rm-back" data-rm="back">← All rooms</button>' +
    '<h3 class="rm-room-name">Review room names</h3>' +
    '<p class="tk-muted rm-section-note">These names were typed on work orders but aren\'t on the room list. For each one: <b>match</b> it to a room (e.g. “Apt 204” is room 204), ' +
    '<b>add</b> it as a new room, or mark it <b>not a room</b> (e.g. “General”). Work orders are never changed — this only decides which room\'s page they show up on.</p>';
  if (!rows.length) return html + '<div class="tk-empty"><p>All caught up — every room name typed on a work order is on the list.</p></div>';

  html += '<div class="rm-bulk">' +
    '<label class="rm-check-all"><input type="checkbox" data-rm="check-all" /> Select all</label>' +
    '<span class="tk-muted" data-rm="checked-count">0 selected</span>' +
    '<span class="rm-bulk-actions">Add selected as ' +
      '<select class="config-input" data-rm="bulk-type">' + rmTypeOptions(null, "Units (no type yet)") + '<option value="__common">Common areas</option></select> ' +
      '<button type="button" class="config-btn" data-rm="bulk-add" disabled>Add</button> ' +
      '<button type="button" class="tk-tool-btn" data-rm="bulk-ignore" disabled>Not rooms</button></span>' +
  '</div>';

  html += '<div class="rm-review">' + rows.map(function(u, i) {
    return '<div class="rm-review-row" data-i="' + i + '">' +
      '<label class="rm-review-name"><input type="checkbox" data-rm="check" data-i="' + i + '" /> <b>' + escapeHtml(u.spelling) + '</b></label>' +
      '<span class="tk-muted rm-review-uses">' + u.uses + ' time' + (u.uses === 1 ? "" : "s") + ' · last ' + escapeHtml(rmDate(u.last_used)) + '</span>' +
      '<span class="rm-review-actions">' +
        (roomOptions ? '<select class="config-input" data-rm="match-select" data-i="' + i + '"><option value="">Same as room…</option>' + roomOptions + '</select>' : "") +
        '<button type="button" class="tk-tool-btn" data-rm="review-add" data-i="' + i + '">Add as room</button>' +
        '<button type="button" class="tk-tool-btn" data-rm="review-ignore" data-i="' + i + '">Not a room</button>' +
      '</span>' +
    '</div>';
  }).join("") + '</div>';
  return html;
}

function rmCheckedRows() {
  var out = [];
  RM.el.querySelectorAll("[data-rm='check']:checked").forEach(function(c) { out.push(RM.unmatched[+c.getAttribute("data-i")]); });
  return out;
}

function rmUpdateChecked() {
  var n = rmCheckedRows().length;
  var label = RM.el.querySelector("[data-rm='checked-count']");
  if (label) label.textContent = n + " selected";
  RM.el.querySelectorAll("[data-rm='bulk-add'], [data-rm='bulk-ignore']").forEach(function(b) { b.disabled = !n; });
}

async function rmReviewAdd(spellings, kind, typeId) {
  var rows = spellings.map(function(s) {
    return { property_code: RM.code, name: s, kind: kind, unit_type_id: kind === "unit" ? (typeId || null) : null };
  });
  var res = await sb.from("rooms").insert(rows);
  if (res.error) { rmFail("Couldn't add", res.error); return; }
  rmLoad();
}

async function rmReviewIgnore(spellings) {
  var res = await sb.from("room_aliases").insert(spellings.map(function(s) { return { property_code: RM.code, alias: s, room_id: null }; }));
  if (res.error) { rmFail("Couldn't mark those", res.error); return; }
  rmLoad();
}

async function rmReviewMatch(spelling, roomId) {
  var res = await sb.from("room_aliases").insert({ property_code: RM.code, alias: spelling, room_id: roomId });
  if (res.error) { rmFail("Couldn't match", res.error); return; }
  rmLoad();
}

// ── Equipment: helpers ───────────────────────────────────────────────────────

function rmEqType(id) {
  return RM.equipTypes.find(function(t) { return t.id === id; }) || { name: "Equipment" };
}

function rmEqTypeName(id) {
  return rmEqType(id).name;
}

function rmAge(item) {
  return item.install_year == null ? null : new Date().getFullYear() - item.install_year;
}

// At or past the expected life set for its type.
function rmPastLife(item) {
  var life = rmEqType(item.equipment_type_id).expected_life_years;
  var age = rmAge(item);
  return !!life && age != null && age >= life;
}

function rmMoney(n) {
  return "$" + Math.round(n).toLocaleString("en-US");
}

function rmYearCell(item) {
  return item.install_year == null ? '<span class="rm-year-needed">Year needed</span>' : String(item.install_year);
}

function rmAgeCell(item) {
  var age = rmAge(item);
  if (age == null) return '<span class="tk-muted">—</span>';
  var text = age < 1 ? "Under 1 yr" : age + (age === 1 ? " yr" : " yrs");
  if (!rmPastLife(item)) return text;
  return '<span class="rm-past-life" title="Expected life: ' + rmEqType(item.equipment_type_id).expected_life_years + ' years">' + text + ' ⚠</span>';
}

function rmEqDetails(item) {
  var bits = [];
  var bm = [item.brand, item.model].filter(Boolean).join(" ");
  if (bm) bits.push(escapeHtml(bm));
  if (item.serial) bits.push("S/N " + escapeHtml(item.serial));
  if (item.warranty_until) bits.push("Warranty to " + escapeHtml(formatDateOnly(item.warranty_until)));
  var html = bits.length ? bits.join(" · ") : '<span class="tk-muted">—</span>';
  if (item.notes) html += '<div class="tk-muted rm-eq-notes">' + escapeHtml(item.notes) + '</div>';
  return html;
}

// Sorted like the equipment-types list (Refrigerator, Range, …).
function rmEqSort(a, b) {
  var ta = rmEqType(a.equipment_type_id), tb = rmEqType(b.equipment_type_id);
  return (ta.sort_order || 0) - (tb.sort_order || 0) || rmCompareNames(ta.name, tb.name);
}

// What a room's unit type usually has that the room doesn't (yet).
function rmTemplateMissing(room, inService) {
  if (room.kind !== "unit" || !room.unit_type_id) return [];
  var out = [];
  RM.templates.filter(function(t) { return t.unit_type_id === room.unit_type_id; }).forEach(function(t) {
    var et = RM.equipTypes.find(function(x) { return x.id === t.equipment_type_id; });
    if (!et || et.archived) return;
    var have = inService.filter(function(i) { return i.equipment_type_id === t.equipment_type_id; }).length;
    for (var k = have; k < t.quantity; k++) out.push(et.name);
  });
  return out;
}

// ── Equipment on a room's page ───────────────────────────────────────────────

function rmEquipSectionHtml(room, items) {
  var inService = items.filter(function(i) { return !i.replaced_at; }).sort(rmEqSort);
  var replaced = items.filter(function(i) { return i.replaced_at; }).sort(function(a, b) { return a.replaced_at < b.replaced_at ? 1 : -1; });
  var F = RM.eqForm;
  var html = '<div class="rm-section rm-equip"><div class="rm-section-head"><div class="rm-section-title">Equipment</div>' +
    (RM.canWork && !F ? '<button type="button" class="tk-tool-btn" data-rm="eq-add">+ Add equipment</button>' : "") + '</div>';

  var missing = rmTemplateMissing(room, inService);
  if (RM.canWork && missing.length && !F) {
    html += '<div class="rm-eq-template">A <b>' + escapeHtml(rmTypeName(room.unit_type_id)) + '</b> usually also has: ' + escapeHtml(missing.join(", ")) + '. ' +
      '<button type="button" class="tk-tool-btn" data-rm="eq-template">Add ' + (missing.length === 1 ? "it" : "them") + '</button> ' +
      '<span class="tk-muted">Install years can be filled in afterwards.</span></div>';
  }
  if (F && F.mode === "add") html += rmEquipFormHtml(null);

  if (!inService.length && !(F && F.mode === "add")) {
    html += '<p class="tk-muted">No equipment listed for this room yet.</p>';
  } else if (inService.length) {
    html += '<div class="rm-eq-table"><div class="rm-eq-row rm-row-head"><div>Item</div><div>Installed</div><div>Age</div><div>Details</div><div></div></div>';
    inService.forEach(function(i) {
      var editing = F && F.id === i.id;
      html += '<div class="rm-eq-row' + (rmPastLife(i) ? " rm-eq-old" : "") + '">' +
        '<div class="rm-name">' + escapeHtml(rmEqTypeName(i.equipment_type_id)) + '</div>' +
        '<div>' + rmYearCell(i) + '</div>' +
        '<div>' + rmAgeCell(i) + '</div>' +
        '<div class="rm-eq-details">' + rmEqDetails(i) + '</div>' +
        '<div class="rm-eq-actions">' + (RM.canWork && !F
          ? '<button type="button" class="link-btn" data-rm="eq-edit" data-id="' + i.id + '">Edit</button>' +
            '<button type="button" class="link-btn" data-rm="eq-replace" data-id="' + i.id + '">Replace</button>'
          : "") + '</div>' +
      '</div>';
      if (editing) html += rmEquipFormHtml(i);
    });
    html += '</div>';
  }

  if (replaced.length) {
    html += '<details class="rm-eq-replaced"><summary class="tk-muted">Replaced or removed (' + replaced.length + ')</summary>' +
      replaced.map(function(i) {
        return '<div class="rm-eq-row rm-archived"><div>' + escapeHtml(rmEqTypeName(i.equipment_type_id)) + '</div>' +
          '<div>' + rmYearCell(i) + '</div>' +
          '<div class="tk-muted">Out ' + escapeHtml(rmDate(i.replaced_at)) + '</div>' +
          '<div class="rm-eq-details">' + rmEqDetails(i) + (i.replaced_by_name ? '<div class="tk-muted rm-eq-notes">Marked by ' + escapeHtml(i.replaced_by_name) + '</div>' : "") + '</div><div></div></div>';
      }).join("") + '</details>';
  }
  return html + '</div>';
}

// The add / edit / replace form. `item` is the one being edited or replaced.
function rmEquipFormHtml(item) {
  var F = RM.eqForm;
  var editing = F.mode === "edit";
  var v = editing ? item : { equipment_type_id: item ? item.equipment_type_id : "", install_year: F.mode === "replace" ? new Date().getFullYear() : "",
    brand: "", model: "", serial: "", warranty_until: "", notes: "" };
  var typeOpts = RM.equipTypes.filter(function(t) { return !t.archived || t.id === v.equipment_type_id; }).map(function(t) {
    return '<option value="' + t.id + '"' + (t.id === v.equipment_type_id ? " selected" : "") + '>' + escapeHtml(t.name) + '</option>';
  }).join("");
  var title = F.mode === "replace" ? "Replace " + escapeHtml(rmEqTypeName(item.equipment_type_id)) + (item.install_year ? " (" + item.install_year + ")" : "") +
      ' — enter the new one. The old one stays on record, marked replaced.'
    : editing ? "Edit " + escapeHtml(rmEqTypeName(item.equipment_type_id)) : "Add equipment";
  return '<form class="rm-eq-form" data-rm="eq-form" autocomplete="off">' +
    '<div class="rm-eq-form-title">' + title + '</div>' +
    '<div class="rm-add-fields">' +
      '<label class="rm-field">Item<select class="config-input" name="type" required>' + (v.equipment_type_id ? "" : '<option value="">Choose…</option>') + typeOpts + '</select></label>' +
      '<label class="rm-field rm-field-small">Install year<input class="config-input" name="year" type="number" min="1900" max="' + (new Date().getFullYear() + 1) +
        '" value="' + escapeHtml(v.install_year == null ? "" : String(v.install_year)) + '"' + (editing ? ' placeholder="Year needed"' : " required") + ' /></label>' +
      '<label class="rm-field">Brand<input class="config-input" name="brand" value="' + escapeHtml(v.brand) + '" placeholder="optional" /></label>' +
      '<label class="rm-field">Model<input class="config-input" name="model" value="' + escapeHtml(v.model) + '" placeholder="optional" /></label>' +
      '<label class="rm-field">Serial number<input class="config-input" name="serial" value="' + escapeHtml(v.serial) + '" placeholder="optional" /></label>' +
      '<label class="rm-field">Warranty until<input class="config-input" name="warranty" type="date" value="' + escapeHtml(v.warranty_until || "") + '" /></label>' +
    '</div>' +
    '<label class="rm-field">Notes<input class="config-input" name="notes" value="' + escapeHtml(v.notes) + '" placeholder="optional" /></label>' +
    '<div class="rm-add-foot"><span></span><span><button type="button" class="tk-tool-btn" data-rm="eq-cancel">Cancel</button> ' +
      '<button type="submit" class="config-btn">' + (F.mode === "replace" ? "Replace" : "Save") + '</button></span></div>' +
  '</form>';
}

function rmEquipFormValues(form) {
  var year = form.year.value.trim();
  return {
    equipment_type_id: form.type.value,
    install_year: year ? parseInt(year, 10) : null,
    brand: form.brand.value.trim(),
    model: form.model.value.trim(),
    serial: form.serial.value.trim(),
    warranty_until: form.warranty.value || null,
    notes: form.notes.value.trim()
  };
}

async function rmSaveEquip(form) {
  var F = RM.eqForm;
  var vals = rmEquipFormValues(form);
  if (!vals.equipment_type_id) { alert("Choose what the item is."); return; }
  if (F.mode !== "edit" && vals.install_year == null) { alert("Enter the year it was installed (your best guess is fine)."); return; }
  var btn = form.querySelector("[type='submit']");
  btn.disabled = true;
  var res;
  if (F.mode === "edit") {
    res = await sb.from("room_equipment").update(vals).eq("id", F.id);
  } else {
    vals.room_id = RM.roomId;
    vals.property_code = RM.code;
    res = await sb.from("room_equipment").insert(vals);
    if (!res.error && F.mode === "replace") {
      res = await sb.from("room_equipment").update({ replaced_at: new Date().toISOString() }).eq("id", F.id);
      if (res.error) { btn.disabled = false; rmFail("The new one was added, but the old one couldn't be marked replaced", res.error); RM.eqForm = null; rmLoadProfile(); return; }
    }
  }
  if (res.error) { btn.disabled = false; rmFail("Couldn't save", res.error); return; }
  RM.eqForm = null;
  rmLoadProfile();
}

async function rmApplyTemplate(unitTypeId, roomId) {
  var res = await sb.rpc("apply_unit_type_equipment", { p_code: RM.code, p_unit_type: unitTypeId, p_room: roomId || null });
  if (res.error) { rmFail("Couldn't add the standard equipment", res.error); return null; }
  return res.data;
}

// ── The building's Equipment view ────────────────────────────────────────────

async function rmLoadBuildingEquip() {
  var code = RM.code;
  var rows = [];
  for (var from = 0; ; from += 1000) {
    var res = await sb.from("room_equipment").select("*").eq("property_code", code).is("replaced_at", null).order("id").range(from, from + 999);
    if (res.error) { rmFail("Couldn't load equipment", res.error); return; }
    rows = rows.concat(res.data);
    if (res.data.length < 1000) break;
  }
  if (RM.code !== code) return;
  // Equipment in archived rooms doesn't count.
  var active = {};
  rmActiveRooms().forEach(function(r) { active[r.id] = true; });
  RM.buildingEquip = rows.filter(function(i) { return active[i.room_id]; });
  if (RM.view === "equipment") rmRender();
}

var RM_AGE_BANDS = [["0–5", 0, 5], ["6–10", 6, 10], ["11–15", 11, 15], ["16+", 16, 999]];

function rmEquipViewHtml() {
  if (!RM.buildingEquip) return '<div class="tk-muted" style="padding:20px 0">Loading equipment…</div>';
  if (RM.eqTypeId) return rmEquipTypeHtml();
  var items = RM.buildingEquip;
  var byType = {};
  items.forEach(function(i) { (byType[i.equipment_type_id] = byType[i.equipment_type_id] || []).push(i); });
  var past = items.filter(rmPastLife);
  var needYear = items.filter(function(i) { return i.install_year == null; });
  var cost = 0, uncosted = 0;
  past.forEach(function(i) { var c = rmEqType(i.equipment_type_id).replacement_cost; if (c != null) cost += Number(c); else uncosted++; });

  var html = '<div class="rm-tiles">' +
    rmTile(items.length, "Items in service") +
    rmTile(past.length, "At or past<br>expected life") +
    rmTile(past.length ? rmMoney(cost) + (uncosted ? "+" : "") : "$0", "To replace those<br>(typical cost)") +
    rmTile(needYear.length, "Install year<br>needed") +
  '</div>';
  if (uncosted) {
    html += '<p class="tk-muted rm-section-note">' + uncosted + ' of the items past their expected life have no typical replacement cost yet' +
      (RM.canTypes ? ' — add one under <b>Set up types</b>.' : '.') + '</p>';
  }
  if (!items.length) {
    return html + '<div class="tk-empty"><p><b>No equipment listed in this building yet.</b></p><p>Add it on each room\'s page' +
      (RM.canTypes ? ', or set up each unit type\'s standard equipment under <b>Set up types</b> and add it to every room of that type at once' : "") + '.</p></div>';
  }

  html += '<div class="rm-section"><div class="rm-section-head"><div class="rm-section-title">By type and age (years)</div>' +
    '<button type="button" class="tk-tool-btn" data-rm="eq-csv">Download CSV</button></div>' +
    '<p class="tk-muted rm-section-note">Click a type to see which rooms it\'s in, oldest first.</p>' +
    '<div class="rm-eq-sum"><div class="rm-eq-sum-row rm-row-head"><div>Item</div><div>In service</div>' +
      RM_AGE_BANDS.map(function(b) { return '<div class="rm-col-band">' + b[0] + '</div>'; }).join("") +
      '<div>Year needed</div><div>Past life</div><div>To replace</div></div>';
  RM.equipTypes.slice().sort(function(a, b) { return a.sort_order - b.sort_order; }).forEach(function(t) {
    var list = byType[t.id];
    if (!list) return;
    var pastT = list.filter(rmPastLife);
    html += '<div class="rm-eq-sum-row rm-room-row" data-rm="eq-type" data-id="' + t.id + '" tabindex="0">' +
      '<div class="rm-name">' + escapeHtml(t.name) + (t.expected_life_years ? '<span class="tk-muted rm-life"> · lasts ~' + t.expected_life_years + ' yrs</span>' : "") + '</div>' +
      '<div>' + list.length + '</div>' +
      RM_AGE_BANDS.map(function(b) {
        var n = list.filter(function(i) { var a = rmAge(i); return a != null && a >= b[1] && a <= b[2]; }).length;
        return '<div class="rm-col-band">' + (n || '<span class="tk-muted">0</span>') + '</div>';
      }).join("") +
      '<div>' + (list.filter(function(i) { return i.install_year == null; }).length || '<span class="tk-muted">0</span>') + '</div>' +
      '<div>' + (pastT.length ? '<span class="rm-past-life">' + pastT.length + '</span>' : '<span class="tk-muted">0</span>') + '</div>' +
      '<div>' + (pastT.length ? (t.replacement_cost != null ? rmMoney(pastT.length * t.replacement_cost) : '<span class="tk-muted">no cost set</span>') : '<span class="tk-muted">—</span>') + '</div>' +
    '</div>';
  });
  return html + '</div></div>';
}

// One type: which rooms it's in, oldest first ("Year needed" last).
function rmEquipTypeHtml() {
  var t = rmEqType(RM.eqTypeId);
  var list = RM.buildingEquip.filter(function(i) { return i.equipment_type_id === RM.eqTypeId; }).sort(function(a, b) {
    if (a.install_year == null) return b.install_year == null ? 0 : 1;
    if (b.install_year == null) return -1;
    return a.install_year - b.install_year;
  });
  var html = '<button type="button" class="link-btn rm-back" data-rm="eq-back">← All equipment</button>' +
    '<h3 class="rm-room-name">' + escapeHtml(t.name) + ' <span class="tk-muted rm-life">' + list.length + ' in service' +
      (t.expected_life_years ? ' · expected life ' + t.expected_life_years + ' years' : "") +
      (t.replacement_cost != null ? ' · typical cost ' + rmMoney(t.replacement_cost) : "") + '</span></h3>' +
    '<div class="rm-eq-table rm-eq-bytype"><div class="rm-eq-row rm-row-head"><div>Room</div><div>Installed</div><div>Age</div><div>Details</div><div></div></div>';
  list.forEach(function(i) {
    var room = rmRoom(i.room_id) || {};
    html += '<div class="rm-eq-row rm-room-row' + (rmPastLife(i) ? " rm-eq-old" : "") + '" data-rm="room" data-id="' + i.room_id + '" tabindex="0">' +
      '<div class="rm-name">' + escapeHtml(room.name || "") + '</div><div>' + rmYearCell(i) + '</div><div>' + rmAgeCell(i) + '</div>' +
      '<div class="rm-eq-details">' + rmEqDetails(i) + '</div><div></div></div>';
  });
  return html + '</div>';
}

function rmEquipCsv() {
  var head = ["Room", "Kind", "Unit type", "Floor", "Item", "Installed", "Age (years)", "Expected life (years)", "At or past expected life",
    "Typical replacement cost", "Brand", "Model", "Serial", "Warranty until", "Notes"];
  var rows = RM.buildingEquip.slice().sort(function(a, b) {
    var ra = rmRoom(a.room_id) || {}, rb = rmRoom(b.room_id) || {};
    return rmCompareNames(ra.name || "", rb.name || "") || rmEqSort(a, b);
  }).map(function(i) {
    var r = rmRoom(i.room_id) || {};
    var t = rmEqType(i.equipment_type_id);
    return [r.name, r.kind === "common" ? "Common area" : "Unit", rmTypeName(r.unit_type_id), r.floor, t.name,
      i.install_year == null ? "Year needed" : i.install_year, rmAge(i) == null ? "" : rmAge(i), t.expected_life_years || "",
      rmPastLife(i) ? "Yes" : "", t.replacement_cost == null ? "" : t.replacement_cost,
      i.brand, i.model, i.serial, i.warranty_until || "", i.notes].map(csvField).join(",");
  });
  var a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([[head.map(csvField).join(",")].concat(rows).join("\r\n")], { type: "text/csv" }));
  a.download = "equipment_" + RM.code + "_" + new Date().toLocaleDateString("en-CA", { timeZone: rmTimeZone() }) + ".csv";
  a.click();
  setTimeout(function() { URL.revokeObjectURL(a.href); }, 1000);
}

// ── Set up types: unit types (with their standard equipment) and equipment types

function rmOpenTypes() {
  var modal = document.createElement("div");
  modal.className = "tk-modal";
  modal.setAttribute("data-rm-modal", "types");
  RM.el.querySelector(".rm").appendChild(modal);
  rmRenderTypes();
  modal.addEventListener("click", async function(e) {
    if (e.target === modal || e.target.closest("[data-rmt='close']")) { modal.remove(); rmLoad(); return; }
    var b = e.target.closest("[data-rmt]");
    if (!b) return;
    var what = b.getAttribute("data-rmt"), id = b.getAttribute("data-id"), res;
    if (what === "ut-archive" || what === "et-archive") {
      var table = what === "ut-archive" ? "unit_types" : "equipment_types";
      var list = what === "ut-archive" ? RM.unitTypes : RM.equipTypes;
      var t = list.find(function(x) { return x.id === id; });
      res = await sb.from(table).update({ archived: !t.archived }).eq("id", id);
      if (res.error) { rmFail("Couldn't change that", res.error); return; }
      t.archived = !t.archived;
      rmRenderTypes();
    } else if (what === "std-remove") {
      var ut = b.getAttribute("data-ut");
      res = await sb.from("unit_type_equipment").delete().eq("unit_type_id", ut).eq("equipment_type_id", id);
      if (res.error) { rmFail("Couldn't remove that", res.error); return; }
      RM.templates = RM.templates.filter(function(x) { return !(x.unit_type_id === ut && x.equipment_type_id === id); });
      rmRenderTypes();
    } else if (what === "std-apply") {
      var rooms = rmActiveRooms().filter(function(r) { return r.unit_type_id === id; }).length;
      if (!confirm("Add the standard equipment to all " + rooms + " " + rmTypeName(id) + " room" + (rooms === 1 ? "" : "s") + " in " + communityLabel(RM.code) +
        "? Only what's missing is added (nothing is removed or changed), with the install year marked “Year needed”.")) return;
      b.disabled = true;
      var n = await rmApplyTemplate(id, null);
      b.disabled = false;
      if (n != null) alert(n ? "Added " + n + " item" + (n === 1 ? "" : "s") + "." : "Nothing was missing — every room already has its standard equipment.");
    }
  });
  modal.addEventListener("change", async function(e) {
    var el = e.target.closest("[data-rmt]");
    if (!el) return;
    var what = el.getAttribute("data-rmt"), id = el.getAttribute("data-id"), res;
    if (what === "ut-name") {
      var u = RM.unitTypes.find(function(x) { return x.id === id; });
      var name = el.value.trim();
      if (!name || name === u.name) { el.value = u.name; return; }
      res = await sb.from("unit_types").update({ name: name }).eq("id", id);
      if (res.error) { el.value = u.name; rmFail("Couldn't rename", res.error); return; }
      u.name = name;
    } else if (what === "et-name" || what === "et-life" || what === "et-cost") {
      var t = RM.equipTypes.find(function(x) { return x.id === id; });
      var change = {};
      if (what === "et-name") { if (!el.value.trim()) { el.value = t.name; return; } change.name = el.value.trim(); }
      if (what === "et-life") change.expected_life_years = el.value === "" ? null : parseInt(el.value, 10);
      if (what === "et-cost") change.replacement_cost = el.value === "" ? null : Number(String(el.value).replace(/[$,]/g, ""));
      res = await sb.from("equipment_types").update(change).eq("id", id);
      if (res.error) { rmFail("Couldn't save that", res.error); rmRenderTypes(); return; }
      Object.assign(t, change);
    } else if (what === "std-qty") {
      var ut = el.getAttribute("data-ut");
      var q = Math.max(1, Math.min(20, parseInt(el.value, 10) || 1));
      res = await sb.from("unit_type_equipment").update({ quantity: q }).eq("unit_type_id", ut).eq("equipment_type_id", id);
      if (res.error) { rmFail("Couldn't save that", res.error); return; }
      RM.templates.forEach(function(x) { if (x.unit_type_id === ut && x.equipment_type_id === id) x.quantity = q; });
    } else if (what === "std-add" && el.value) {
      var row = { unit_type_id: id, equipment_type_id: el.value, quantity: 1 };
      res = await sb.from("unit_type_equipment").insert(row);
      if (res.error) { rmFail("Couldn't add that", res.error); return; }
      RM.templates.push(row);
      rmRenderTypes();
    }
  });
  modal.addEventListener("submit", async function(e) {
    e.preventDefault();
    var f = e.target, kind = f.getAttribute("data-rmt"), name = f.newname.value.trim();
    if (!name) return;
    var list = kind === "ut-new" ? RM.unitTypes : RM.equipTypes;
    var order = list.reduce(function(m, u) { return Math.max(m, u.sort_order); }, 0) + 1;
    var row = { company_id: rmProp().companyId, name: name, sort_order: order };
    if (kind === "et-new") {
      if (f.life.value) row.expected_life_years = parseInt(f.life.value, 10);
      if (f.cost.value) row.replacement_cost = Number(String(f.cost.value).replace(/[$,]/g, ""));
    }
    var res = await sb.from(kind === "ut-new" ? "unit_types" : "equipment_types").insert(row).select().single();
    if (res.error) { rmFail("Couldn't add", res.error); return; }
    list.push(res.data);
    rmRenderTypes();
    var box = modal.querySelector("[data-rmt='" + kind + "'] [name='newname']");
    if (box) box.focus();
  });
}

function rmRenderTypes() {
  var modal = RM.el.querySelector("[data-rm-modal='types']");
  if (!modal) return;
  var activeEquip = RM.equipTypes.filter(function(t) { return !t.archived; });
  var unitHtml = RM.unitTypes.map(function(u) {
    var std = RM.templates.filter(function(x) { return x.unit_type_id === u.id; });
    var have = std.map(function(x) { return x.equipment_type_id; });
    var rooms = rmActiveRooms().filter(function(r) { return r.unit_type_id === u.id; }).length;
    return '<div class="rm-ut' + (u.archived ? " rm-archived" : "") + '">' +
      '<div class="rm-type-row"><input class="config-input" data-rmt="ut-name" data-id="' + u.id + '" value="' + escapeHtml(u.name) + '"' + (u.archived ? " disabled" : "") + ' aria-label="Unit type name" />' +
        '<button type="button" class="tk-tool-btn" data-rmt="ut-archive" data-id="' + u.id + '">' + (u.archived ? "Restore" : "Archive") + '</button></div>' +
      (u.archived ? "" :
        '<div class="rm-std"><span class="tk-muted">Standard equipment:</span> ' +
          std.map(function(x) {
            return '<span class="rm-alias">' + escapeHtml(rmEqTypeName(x.equipment_type_id)) +
              ' ×<input type="number" min="1" max="20" class="rm-qty" data-rmt="std-qty" data-ut="' + u.id + '" data-id="' + x.equipment_type_id + '" value="' + x.quantity + '" aria-label="How many" />' +
              '<button type="button" data-rmt="std-remove" data-ut="' + u.id + '" data-id="' + x.equipment_type_id + '" aria-label="Remove">&times;</button></span>';
          }).join("") +
          '<select class="config-input rm-std-add" data-rmt="std-add" data-id="' + u.id + '"><option value="">+ Add item…</option>' +
            activeEquip.filter(function(t) { return have.indexOf(t.id) === -1; }).map(function(t) { return '<option value="' + t.id + '">' + escapeHtml(t.name) + '</option>'; }).join("") +
          '</select>' +
          (std.length && rooms ? '<button type="button" class="tk-tool-btn" data-rmt="std-apply" data-id="' + u.id + '">Add to the ' + rooms + ' ' + escapeHtml(u.name) + ' room' + (rooms === 1 ? "" : "s") + ' here</button>' : "") +
        '</div>') +
    '</div>';
  }).join("");

  var equipHtml = '<div class="rm-et-row rm-row-head"><div>Item</div><div>Expected life (yrs)</div><div>Typical cost ($)</div><div></div></div>' +
    RM.equipTypes.map(function(t) {
      var dis = t.archived ? " disabled" : "";
      return '<div class="rm-et-row' + (t.archived ? " rm-archived" : "") + '">' +
        '<input class="config-input" data-rmt="et-name" data-id="' + t.id + '" value="' + escapeHtml(t.name) + '"' + dis + ' aria-label="Name" />' +
        '<input class="config-input" type="number" min="1" max="100" data-rmt="et-life" data-id="' + t.id + '" value="' + (t.expected_life_years == null ? "" : t.expected_life_years) + '"' + dis + ' aria-label="Expected life in years" />' +
        '<input class="config-input" type="number" min="0" step="1" data-rmt="et-cost" data-id="' + t.id + '" value="' + (t.replacement_cost == null ? "" : Math.round(t.replacement_cost)) + '" placeholder="—"' + dis + ' aria-label="Typical replacement cost" />' +
        '<button type="button" class="tk-tool-btn" data-rmt="et-archive" data-id="' + t.id + '">' + (t.archived ? "Restore" : "Archive") + '</button></div>';
    }).join("");

  modal.innerHTML = '<div class="tk-modal-box rm-types" role="dialog" aria-label="Set up types">' +
    '<div class="tk-modal-head"><h3>Set up types</h3><button type="button" class="tk-pane-close" data-rmt="close" aria-label="Close">&times;</button></div>' +
    '<p class="tk-muted">These lists are shared by every building in the company. Changes save as you type. Archiving hides a choice; rooms and equipment that already use it keep it.</p>' +
    '<div class="rm-card-title rm-types-heading">Unit types and their standard equipment</div>' +
    '<p class="tk-muted">Standard equipment can be added to every room of that type in this building at once (only what\'s missing), with the install year left as “Year needed”.</p>' +
    '<div class="rm-types-list">' + unitHtml + '</div>' +
    '<form class="rm-alias-add" data-rmt="ut-new"><input class="config-input" name="newname" placeholder="Add a unit type, e.g. 1 Bedroom ADA" /><button type="submit" class="tk-tool-btn">Add</button></form>' +
    '<div class="rm-card-title rm-types-heading">Equipment types</div>' +
    '<p class="tk-muted">Anything at or past its expected life is flagged, and the typical cost turns that into a rough replacement budget.</p>' +
    '<div class="rm-types-list">' + equipHtml + '</div>' +
    '<form class="rm-alias-add rm-et-new" data-rmt="et-new"><input class="config-input" name="newname" placeholder="Add an item, e.g. Ceiling fan" />' +
      '<input class="config-input" type="number" min="1" max="100" name="life" placeholder="Life (yrs)" />' +
      '<input class="config-input" type="number" min="0" name="cost" placeholder="Cost ($)" />' +
      '<button type="submit" class="tk-tool-btn">Add</button></form>' +
  '</div>';
}

// ── Clicks, typing and forms ─────────────────────────────────────────────────

function rmWire() {
  var root = RM.el.querySelector(".rm");
  if (!root) return;
  root.addEventListener("click", function(e) {
    var t = e.target.closest("[data-rm]");
    if (!t) return;
    var what = t.getAttribute("data-rm");
    var i = t.getAttribute("data-i");
    if (what === "retry") rmLoad();
    else if (what === "room") { if (RM.view !== "equipment") RM.eqTypeId = null; rmOpenRoom(t.getAttribute("data-id")); }
    else if (what === "back") { RM.view = RM.eqTypeId ? "equipment" : "list"; RM.roomId = null; rmRender(); }
    else if (what === "review") { RM.view = "review"; rmRender(); window.scrollTo(0, 0); }
    else if (what === "add") { RM.adding = !RM.adding; rmRender(); }
    else if (what === "add-cancel") { RM.adding = false; rmRender(); }
    else if (what === "filter") { RM.filter = t.getAttribute("data-value"); rmRender(); }
    else if (what === "archived") { RM.showArchived = !RM.showArchived; rmRender(); }
    else if (what === "types") rmOpenTypes();
    else if (what === "section") {
      RM.view = t.getAttribute("data-value") === "equipment" ? "equipment" : "list";
      RM.eqTypeId = null;
      rmRender();
      if (RM.view === "equipment") rmLoadBuildingEquip();
    }
    else if (what === "eq-type") { RM.eqTypeId = t.getAttribute("data-id"); rmRender(); window.scrollTo(0, 0); }
    else if (what === "eq-back") { RM.eqTypeId = null; rmRender(); }
    else if (what === "eq-csv") rmEquipCsv();
    else if (what === "eq-add") { RM.eqForm = { mode: "add" }; rmRender(); }
    else if (what === "eq-edit") { RM.eqForm = { mode: "edit", id: t.getAttribute("data-id") }; rmRender(); }
    else if (what === "eq-replace") { RM.eqForm = { mode: "replace", id: t.getAttribute("data-id") }; rmRender(); }
    else if (what === "eq-cancel") { RM.eqForm = null; rmRender(); }
    else if (what === "eq-template") {
      t.disabled = true;
      rmApplyTemplate(rmRoom(RM.roomId).unit_type_id, RM.roomId).then(function() { rmLoadProfile(); });
    }
    else if (what === "archive") rmToggleArchive();
    else if (what === "unmatch") rmUnmatch(t.getAttribute("data-id"));
    else if (what === "csv") rmHistoryCsv();
    else if (what === "pdf") rmHistoryPdf();
    else if (what === "review-add") rmReviewAdd([RM.unmatched[+i].spelling], "unit", null);
    else if (what === "review-ignore") rmReviewIgnore([RM.unmatched[+i].spelling]);
    else if (what === "bulk-ignore") rmReviewIgnore(rmCheckedRows().map(function(u) { return u.spelling; }));
    else if (what === "bulk-add") {
      var type = RM.el.querySelector("[data-rm='bulk-type']").value;
      rmReviewAdd(rmCheckedRows().map(function(u) { return u.spelling; }), type === "__common" ? "common" : "unit", type === "__common" ? null : type);
    }
  });
  root.addEventListener("keydown", function(e) {
    var row = e.target.closest("[data-rm='room'], [data-rm='eq-type']");
    if (row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); row.click(); }
  });
  root.addEventListener("input", function(e) {
    if (e.target.matches("[data-rm='search']")) {
      RM.search = e.target.value;
      var pos = e.target.selectionStart;
      rmRender();
      var box = RM.el.querySelector("[data-rm='search']");
      box.focus();
      box.setSelectionRange(pos, pos);
    }
    if (e.target.closest("[data-rm='add-form']")) rmUpdateAddPreview();
    var details = e.target.closest("[data-rm='details-form']");
    if (details) { var s = details.querySelector("[data-rm='save']"); if (s) s.disabled = false; }
  });
  root.addEventListener("change", function(e) {
    if (e.target.matches("[data-rm='building']")) { rememberCommunity(e.target.value); rmSwitchBuilding(e.target.value); return; }
    if (e.target.closest("[data-rm='add-form']")) rmUpdateAddPreview();
    var details = e.target.closest("[data-rm='details-form']");
    if (details) {
      var s = details.querySelector("[data-rm='save']");
      if (s) s.disabled = false;
      details.querySelector("[data-rm='type-field']").style.display = details.kind.value === "unit" ? "" : "none";
    }
    if (e.target.matches("[data-rm='check']")) rmUpdateChecked();
    if (e.target.matches("[data-rm='check-all']")) {
      RM.el.querySelectorAll("[data-rm='check']").forEach(function(c) { c.checked = e.target.checked; });
      rmUpdateChecked();
    }
    if (e.target.matches("[data-rm='match-select']") && e.target.value) {
      rmReviewMatch(RM.unmatched[+e.target.getAttribute("data-i")].spelling, e.target.value);
    }
  });
  root.addEventListener("submit", function(e) {
    e.preventDefault();
    var f = e.target.getAttribute("data-rm");
    if (f === "add-form") rmSubmitAdd(e.target);
    else if (f === "details-form") rmSaveDetails(e.target);
    else if (f === "alias-form") rmAddAlias(e.target);
    else if (f === "eq-form") rmSaveEquip(e.target);
  });
}
