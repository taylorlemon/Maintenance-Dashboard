// Housekeeping tab (H1): cleaning schedules, the day board and "My rooms".
//
// Tables (supabase/housekeeping/01-housekeeping.sql): cleaning_types,
// cleaning_schedules ("204: weekly on Tuesdays, Standard clean, usually
// Maria") and cleanings (one per room per day it's due, or added by hand).
// A day's cleanings are made from the schedules the first time anyone opens
// that day (ensure_cleanings). Start / Done / Skip / Cancel times are stamped
// by the database; a mis-tap can be undone.
//
// Screens, all drawn into one element:
//   "board"     — the day board: every cleaning that day, grouped by
//                 housekeeper; reassign, start, finish, skip, add a one-off.
//                 Its "Day · Week" switch shows a whole Monday–Sunday week
//                 instead: housekeepers down the side, days across the top.
//   "schedules" — every room's cleaning schedule; add, change, stop
//   "mine"      — My rooms today, big buttons (Staff screen only)
//   "reports"   — by housekeeper / cleaning type / skip reason over a period,
//                 a weekly trend and an Excel download (the office only)
//
// Used in two places: the Housekeeping tab (switch row: Board ·
// Schedules) and the Staff screen's "Housekeeping" view (its own switch row:
// My rooms · Board · Schedules). Admins, Editors and Staff change things;
// Viewers look only. Cleaning types are edited under ⚙ Admin-level "Set up
// types" here (Admins and Editors).

var HK = {
  el: null, mode: "office", codes: [], code: null,
  view: "board",
  date: null,          // "YYYY-MM-DD", the building's calendar day shown
  rooms: [], types: [], workers: [], cleanings: [], schedules: [],
  showCancelled: false,
  adding: false,       // the "+ Add a cleaning" / "+ Add schedules" form is open
  editId: null,        // schedule being edited
  repDays: 30,         // Reports: how many days back (including today)
  boardMode: null,     // "day" or "week" (remembered per browser; see hkBoardMode)
  repRows: null,       // Reports: the cleanings in that period
  canWork: false, canTypes: false,
  loadSeq: 0,
  timer: null
};

var HK_SKIP_REASONS = ["Resident declined", "Resident away", "Do not disturb", "Room not ready", "Other"];
var HK_DAYS = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
var HK_EVERY = [[1, "Every week"], [2, "Every 2 weeks"], [4, "Every 4 weeks"]];

// ── The ways in ──────────────────────────────────────────────────────────────

function openHousekeepingTab(section) {
  var panel = document.getElementById("housekeepingPanel");
  var codes = listBuildings().map(function(p) { return p.code; });
  if (!codes.length) { panel.innerHTML = '<div class="tk-empty">No buildings to show.</div>'; return; }
  var keep = codes.indexOf(activeCommunity) !== -1 ? activeCommunity
    : HK.el === panel && codes.indexOf(HK.code) !== -1 ? HK.code : codes[0];
  hkOpen(panel, "office", codes, keep, section);
}

// The Staff screen's "Housekeeping" view.
function openStaffHousekeeping() {
  var codes = visibleProperties().map(function(p) { return p.code; });
  var code = (typeof TK !== "undefined" && TK.code) || codes[0];
  if (HK.el && HK.mode === "staff" && HK.code === code) { hkLoad(); return; }
  hkOpen(document.getElementById("staffHousekeeping"), "staff", codes, code, "mine");
}

function hkBuildingChanged(code) {
  if (HK.mode === "staff" && HK.el && HK.code !== code) { HK.code = code; HK.adding = false; HK.editId = null; hkLoad(); }
}

function hkOpen(el, mode, codes, code, section) {
  var role = currentProfile ? currentProfile.role : "";
  HK.el = el;
  HK.mode = mode;
  HK.codes = codes;
  HK.canWork = isExecutive() || role === "admin" || role === "editor" || role === "staff";
  HK.canTypes = isExecutive() || role === "admin" || role === "editor";
  if (HK.code !== code) { HK.date = null; HK.adding = false; HK.editId = null; }
  HK.code = code;
  if (section) HK.view = section;
  if (mode === "office" && HK.view === "mine") HK.view = "board";
  if (mode === "staff" && HK.view === "reports") HK.view = "mine";   // Reports are for the office
  if (!HK.date) HK.date = hkToday();
  hkLoad();
  hkStartTimer();
}

// Housekeeping's switch row picked a section while already here.
function hkShowSection(section) {
  HK.view = section;
  HK.adding = false;
  HK.editId = null;
  hkLoad();
}

// Others' changes show up within a minute on an open day board or My rooms.
function hkStartTimer() {
  if (HK.timer) clearInterval(HK.timer);
  HK.timer = setInterval(function() {
    if (!HK.el || !HK.el.offsetParent || document.hidden) return;
    if (HK.view === "schedules" || HK.view === "reports" || HK.adding || HK.el.querySelector(".tk-modal")) return;
    hkLoad(true);
  }, 60000);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function hkProp() {
  return ALL_PROPERTIES.find(function(p) { return p.code === HK.code; }) || {};
}

function hkTz() {
  return hkProp().timeZone || "America/Denver";
}

function hkToday() {
  return new Date().toLocaleDateString("en-CA", { timeZone: hkTz() });
}

function hkAddDays(ymd, n) {
  var d = new Date(ymd + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function hkWeekday(ymd) {   // 1 = Monday … 7 = Sunday
  var d = new Date(ymd + "T12:00:00Z").getUTCDay();
  return d === 0 ? 7 : d;
}

// The first `weekday` on or after a day.
function hkNextWeekday(fromYmd, weekday) {
  var d = fromYmd;
  for (var i = 0; i < 7 && hkWeekday(d) !== weekday; i++) d = hkAddDays(d, 1);
  return d;
}

function hkDateLabel(ymd) {
  return new Date(ymd + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "short", day: "numeric", year: "numeric" });
}

function hkTime(ts) {
  return ts ? new Date(ts).toLocaleTimeString("en-US", { timeZone: hkTz(), hour: "numeric", minute: "2-digit" }) : "";
}

function hkRoom(id) { return HK.rooms.find(function(r) { return r.id === id; }) || { name: "?" }; }
function hkType(id) { return HK.types.find(function(t) { return t.id === id; }) || { name: "Cleaning" }; }
function hkWorkerName(id) {
  if (!id) return "Unassigned";
  var w = HK.workers.find(function(x) { return x.id === id; });
  return w ? w.name : "Someone no longer here";
}
function hkMyId() { return capexSession && capexSession.user ? capexSession.user.id : null; }

function hkStatus(c) {
  if (c.cancelled_at) return "cancelled";
  if (c.finished_at) return "done";
  if (c.skipped_at) return "skipped";
  if (c.started_at) return "started";
  return "todo";
}

function hkMinutes(c) {
  if (!c.started_at || !c.finished_at) return null;
  return Math.max(0, Math.round((new Date(c.finished_at) - new Date(c.started_at)) / 60000));
}

function hkStatusLine(c) {
  var st = hkStatus(c);
  if (st === "done") {
    var m = hkMinutes(c), target = hkType(c.cleaning_type_id).target_minutes;
    var over = m != null && target && m > target;
    return '<span class="hk-st hk-st-done">✓ Done ' + hkTime(c.finished_at) + (m != null ? ' · <span class="' + (over ? "hk-over" : "") + '">' + m + ' min</span>' : "") + '</span>';
  }
  // A past day's cleaning nobody finished or skipped was missed.
  if ((st === "started" || st === "todo") && c.clean_date < hkToday()) {
    return '<span class="hk-st hk-over">Missed' + (st === "started" ? " · started " + hkTime(c.started_at) + ", not finished" : "") + '</span>';
  }
  if (st === "started") return '<span class="hk-st hk-st-started">▶ Started ' + hkTime(c.started_at) + '</span>';
  if (st === "skipped") return '<span class="hk-st hk-st-skipped">Skipped · ' + escapeHtml(c.skip_reason || "") + '</span>';
  if (st === "cancelled") return '<span class="hk-st">Cancelled · ' + escapeHtml(c.cancel_reason || "") + '</span>';
  return '<span class="hk-st hk-st-todo">○ Not started</span>';
}

function hkFail(what, err) {
  console.error(err);
  alert(what + ": " + (err && err.message ? err.message : err));
}

// ── Loading ──────────────────────────────────────────────────────────────────

async function hkLoad(quiet) {
  var seq = ++HK.loadSeq;
  if (!quiet && !HK.el.querySelector(".hk")) HK.el.innerHTML = '<div class="hk"><div class="tk-muted" style="padding:24px 0">Loading housekeeping…</div></div>';
  var prop = hkProp();
  var base = await Promise.all([
    sb.from("rooms").select("id, name, kind, unit_type_id, floor").eq("property_code", HK.code).is("archived_at", null),
    sb.from("cleaning_types").select("*").eq("company_id", prop.companyId).order("sort_order"),
    sb.rpc("building_workers", { p_code: HK.code }),
    sb.from("unit_types").select("id, name").eq("company_id", prop.companyId).order("sort_order")
  ]);
  var failed = base.find(function(r) { return r.error; });
  if (failed) return hkLoadFailed(seq, failed.error);
  var day = null, scheds = null, rep = null;
  if (HK.view === "reports") {
    rep = await hkFetchReportRows();
    if (rep.error) return hkLoadFailed(seq, rep.error);
  } else if (HK.view === "schedules") {
    scheds = await sb.from("cleaning_schedules").select("*").eq("property_code", HK.code).is("archived_at", null);
    if (scheds.error) return hkLoadFailed(seq, scheds.error);
  } else {
    var week = HK.view === "board" && hkBoardMode() === "week";
    var days = week ? hkWeekDays() : [HK.date];
    var made = await Promise.all(days.map(function(d) { return sb.rpc("ensure_cleanings", { p_code: HK.code, p_date: d }); }));
    var bad = made.find(function(m) { return m.error; });
    if (bad) return hkLoadFailed(seq, bad.error);
    day = await sb.from("cleanings").select("*").eq("property_code", HK.code).gte("clean_date", days[0]).lte("clean_date", days[days.length - 1]);
    if (day.error) return hkLoadFailed(seq, day.error);
  }
  if (seq !== HK.loadSeq) return;
  HK.rooms = base[0].data.sort(function(a, b) { return rmCompareNames(a.name, b.name); });
  HK.types = base[1].data;
  HK.workers = base[2].data;
  HK.unitTypes = base[3].data;
  if (day) HK.cleanings = day.data;
  if (scheds) HK.schedules = scheds.data;
  if (rep) HK.repRows = rep.rows;
  hkRender();
}

// Reports: fill in any past days in the period from the schedules first (so
// a day nobody opened still shows what was due), then every cleaning in it.
async function hkFetchReportRows() {
  var to = hkToday(), from = hkAddDays(to, -(HK.repDays - 1));
  var made = await sb.rpc("ensure_cleanings_range", { p_code: HK.code, p_from: from, p_to: to });
  if (made.error) return { error: made.error };
  var rows = [];
  for (var off = 0; ; off += 1000) {
    var res = await sb.from("cleanings").select("*").eq("property_code", HK.code)
      .gte("clean_date", from).lte("clean_date", to).order("id").range(off, off + 999);
    if (res.error) return { error: res.error };
    rows = rows.concat(res.data);
    if (res.data.length < 1000) break;
  }
  return { rows: rows, from: from, to: to };
}

function hkLoadFailed(seq, err) {
  if (seq !== HK.loadSeq) return;
  HK.el.innerHTML = '<div class="hk"><div class="tk-empty"><p>Couldn\'t load housekeeping: ' + escapeHtml(err.message) + '</p>' +
    '<button type="button" class="config-btn" data-hk="retry">Try again</button></div></div>';
  hkWire();
}

// ── Drawing ──────────────────────────────────────────────────────────────────

function hkRender() {
  var body = HK.view === "schedules" ? hkSchedulesHtml() : HK.view === "mine" ? hkMineHtml()
    : HK.view === "reports" ? hkReportsHtml() : hkBoardHtml();
  HK.el.innerHTML = '<div class="hk">' + hkHeaderHtml() + body + '</div>';
  hkWire();
  if (HK.mode === "office") renderNav();
}

function hkHeaderHtml() {
  var picker = HK.mode !== "staff" && HK.codes.length > 1
    ? '<select class="tk-building" data-hk="building" aria-label="Building">' + HK.codes.map(function(c) {
        return '<option value="' + escapeHtml(c) + '"' + (c === HK.code ? " selected" : "") + '>' + escapeHtml(communityLabel(c)) + '</option>';
      }).join("") + '</select>'
    : (HK.mode !== "staff" ? '<span class="rm-building-name">' + escapeHtml(communityLabel(HK.code)) + '</span>' : "");
  // The Staff screen has no switch row under the tabs, so it gets its own.
  var sw = HK.mode !== "staff" ? "" : '<div class="wo-switch rm-filter">' +
    [["mine", "My rooms"], ["board", "Board"], ["schedules", "Schedules"]].map(function(s) {
      return '<button type="button" data-hk="view" data-value="' + s[0] + '" class="' + (HK.view === s[0] ? "active" : "") + '">' + s[1] + '</button>';
    }).join("") + '</div>';
  var title = HK.view === "schedules" ? "Schedules" : HK.view === "mine" ? "My rooms" : HK.view === "reports" ? "Reports" : hkBoardMode() === "week" ? "Week board" : "Day board";
  return '<div class="rm-head"><div class="rm-head-left"><h2 class="rm-title">' + title + '</h2>' + picker + sw + '</div>' +
    (HK.canTypes ? '<button type="button" class="tk-tool-btn" data-hk="types">Cleaning types</button>' : "") + '</div>';
}

// "day" or "week" on the Day board (My rooms is always one day).
function hkBoardMode() {
  if (!HK.boardMode) {
    try { HK.boardMode = localStorage.getItem("hkBoardMode") === "week" ? "week" : "day"; } catch (e) { HK.boardMode = "day"; }
  }
  return HK.boardMode;
}

function hkSetBoardMode(mode) {
  HK.boardMode = mode;
  try { localStorage.setItem("hkBoardMode", mode); } catch (e) {}
  hkLoad();
}

// Monday–Sunday of the week HK.date is in.
function hkWeekDays() {
  var mon = hkAddDays(HK.date, 1 - hkWeekday(HK.date));
  var out = [];
  for (var i = 0; i < 7; i++) out.push(hkAddDays(mon, i));
  return out;
}

function hkShortDate(ymd) {
  return new Date(ymd + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
}

function hkDateBar() {
  var today = hkToday();
  var week = HK.view === "board" && hkBoardMode() === "week";
  var step = week ? 7 : 1;
  var days = week ? hkWeekDays() : null;
  var isNow = week ? days.indexOf(today) !== -1 : HK.date === today;
  return '<div class="hk-datebar">' +
    (HK.view === "board" ? '<div class="wo-switch rm-filter hk-mode">' +
      '<button type="button" data-hk="mode" data-value="day" class="' + (week ? "" : "active") + '">Day</button>' +
      '<button type="button" data-hk="mode" data-value="week" class="' + (week ? "active" : "") + '">Week</button></div>' : "") +
    '<button type="button" class="tk-tool-btn" data-hk="day" data-value="' + (-step) + '" aria-label="' + (week ? "Previous week" : "Previous day") + '">‹</button>' +
    '<input type="date" class="config-input hk-date" data-hk="date" value="' + HK.date + '" aria-label="Day" />' +
    '<button type="button" class="tk-tool-btn" data-hk="day" data-value="' + step + '" aria-label="' + (week ? "Next week" : "Next day") + '">›</button>' +
    (!isNow ? '<button type="button" class="link-btn" data-hk="today">' + (week ? "This week" : "Today") + '</button>' : '<span class="tk-muted">' + (week ? "This week" : "Today") + '</span>') +
    '<span class="hk-day-name">' + escapeHtml(week ? "Week of " + hkShortDate(days[0]) + " – " + hkShortDate(days[6]) + ", " + days[6].slice(0, 4) : hkDateLabel(HK.date)) + '</span>' +
  '</div>';
}

// ── The week view ────────────────────────────────────────────────────────────
// Housekeepers down the side, Monday–Sunday across the top. Each square
// lists that person's rooms that day as small tags coloured by where they're
// up to (click one to open it); a day's heading or count opens that day.

function hkTagClass(c) {
  var st = hkStatus(c);
  if ((st === "todo" || st === "started") && c.clean_date < hkToday()) return "missed";
  return st;
}

function hkWeekHtml() {
  var days = hkWeekDays(), today = hkToday();
  var all = HK.cleanings.filter(function(c) { return HK.showCancelled || !c.cancelled_at; });
  var live = HK.cleanings.filter(function(c) { return !c.cancelled_at; });
  var cancelled = HK.cleanings.length - live.length;
  var finished = function(list) { return list.filter(function(c) { var st = hkStatus(c); return st === "done" || st === "skipped"; }).length; };
  var html = hkDateBar() +
    '<div class="hk-summary"><b>' + live.length + '</b> cleaning' + (live.length === 1 ? "" : "s") + ' this week · ' +
      '<span class="hk-st-done">' + live.filter(function(c) { return hkStatus(c) === "done"; }).length + ' done</span> · ' +
      '<span class="hk-st-skipped">' + live.filter(function(c) { return hkStatus(c) === "skipped"; }).length + ' skipped</span> · ' +
      '<span class="hk-over">' + live.filter(function(c) { return hkTagClass(c) === "missed"; }).length + ' missed</span>' +
      (cancelled ? ' · <button type="button" class="link-btn" data-hk="cancelled">' + (HK.showCancelled ? "Hide" : "Show") + ' ' + cancelled + ' cancelled</button>' : "") +
      '<span class="hk-legend"><span class="hk-tag hk-tag-todo">Not started</span><span class="hk-tag hk-tag-started">In progress</span>' +
      '<span class="hk-tag hk-tag-done">Done</span><span class="hk-tag hk-tag-skipped">Skipped</span><span class="hk-tag hk-tag-missed">Missed</span></span>' +
    '</div>';
  if (!all.length) {
    return html + '<div class="tk-empty"><p><b>No cleanings this week.</b></p><p>' +
      (HK.rooms.length ? 'Set up repeating cleanings under <b>Schedules</b>.' : 'Add the building\'s rooms under <b>Maintenance → Rooms</b> first.') + '</p></div>';
  }
  var people = {};
  all.forEach(function(c) { people[c.housekeeper_id || ""] = 1; });
  var keys = Object.keys(people).sort(function(a, b) {
    if (!a) return 1; if (!b) return -1;
    return hkWorkerName(a).localeCompare(hkWorkerName(b));
  });
  var cell = function(list) {
    return list.sort(function(a, b) { return rmCompareNames(hkRoom(a.room_id).name, hkRoom(b.room_id).name); }).map(function(c) {
      return '<button type="button" class="hk-tag hk-tag-' + hkTagClass(c) + '" data-hk="open" data-id="' + c.id + '" title="' +
        escapeHtml(hkRoom(c.room_id).name + " · " + hkType(c.cleaning_type_id).name) + '">' + escapeHtml(hkRoom(c.room_id).name) + '</button>';
    }).join("");
  };
  html += '<div class="hk-week-wrap"><table class="hk-week"><thead><tr><th class="hk-week-who">Housekeeper</th>' +
    days.map(function(d) {
      var n = live.filter(function(c) { return c.clean_date === d; });
      return '<th class="' + (d === today ? "hk-week-today" : "") + '"><button type="button" class="hk-week-day" data-hk="goto-day" data-value="' + d + '">' +
        new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short" }) + ' <span>' + hkShortDate(d) + '</span></button>' +
        '<div class="hk-week-count">' + finished(n) + ' / ' + n.length + '</div></th>';
    }).join("") + '<th>Week</th></tr></thead><tbody>' +
    keys.map(function(k) {
      var mine = all.filter(function(c) { return (c.housekeeper_id || "") === k; });
      var mineLive = mine.filter(function(c) { return !c.cancelled_at; });
      return '<tr' + (k ? "" : ' class="hk-week-unassigned"') + '><th class="hk-week-who">' + escapeHtml(hkWorkerName(k)) + '</th>' +
        days.map(function(d) {
          var list = mine.filter(function(c) { return c.clean_date === d; });
          var n = list.filter(function(c) { return !c.cancelled_at; });
          return '<td class="' + (d === today ? "hk-week-today" : "") + '">' + (list.length
            ? '<button type="button" class="hk-week-count" data-hk="goto-day" data-value="' + d + '">' + finished(n) + ' / ' + n.length + '</button>' + cell(list)
            : "") + '</td>';
        }).join("") +
        '<td class="hk-week-total"><b>' + mineLive.length + '</b><div class="tk-muted">' + finished(mineLive) + ' finished</div></td></tr>';
    }).join("") +
    '</tbody></table></div>' +
    '<p class="tk-muted rm-section-note">Click a room to open it, or a day to see that day\'s full board. Counts are finished (done or skipped) out of the day\'s cleanings.</p>';
  return html;
}

// ── The day board ────────────────────────────────────────────────────────────

function hkBoardHtml() {
  if (hkBoardMode() === "week") return hkWeekHtml();
  var all = HK.cleanings;
  var live = all.filter(function(c) { return !c.cancelled_at; });
  var count = function(st) { return live.filter(function(c) { return hkStatus(c) === st; }).length; };
  var cancelled = all.length - live.length;
  var html = hkDateBar() +
    '<div class="hk-summary"><b>' + live.length + '</b> cleaning' + (live.length === 1 ? "" : "s") +
      ' · <span class="hk-st-done">' + count("done") + ' done</span> · <span class="hk-st-started">' + count("started") + ' in progress</span>' +
      ' · <span class="hk-st-skipped">' + count("skipped") + ' skipped</span> · ' +
      (HK.date < hkToday() ? '<span class="hk-over">' + (count("todo") + count("started")) + ' missed</span>' : count("todo") + ' to go') +
      (cancelled ? ' · <button type="button" class="link-btn" data-hk="cancelled">' + (HK.showCancelled ? "Hide" : "Show") + ' ' + cancelled + ' cancelled</button>' : "") +
      (HK.canWork ? '<button type="button" class="config-btn hk-add-btn" data-hk="add">+ Add a cleaning</button>' : "") +
    '</div>';
  if (HK.adding) html += hkAddCleaningForm();

  var shown = HK.showCancelled ? all : live;
  if (!shown.length) {
    return html + '<div class="tk-empty"><p><b>No cleanings on this day.</b></p><p>' +
      (HK.rooms.length ? 'Set up repeating cleanings under <b>Schedules</b>, or add a one-off with <b>+ Add a cleaning</b>.'
        : 'Housekeeping works from the room list — add the building\'s rooms under <b>Maintenance → Rooms</b> first.') + '</p></div>';
  }
  // One column per housekeeper with cleanings that day, Unassigned last.
  var groups = {};
  shown.forEach(function(c) { var k = c.housekeeper_id || ""; (groups[k] = groups[k] || []).push(c); });
  var keys = Object.keys(groups).sort(function(a, b) {
    if (!a) return 1; if (!b) return -1;
    return hkWorkerName(a).localeCompare(hkWorkerName(b));
  });
  html += '<div class="hk-board">' + keys.map(function(k) {
    var list = groups[k].sort(function(a, b) { return rmCompareNames(hkRoom(a.room_id).name, hkRoom(b.room_id).name); });
    var done = list.filter(function(c) { return hkStatus(c) === "done" || hkStatus(c) === "skipped"; }).length;
    return '<div class="hk-col' + (k ? "" : " hk-col-unassigned") + '"><div class="hk-col-head"><b>' + escapeHtml(hkWorkerName(k)) + '</b>' +
      '<span class="tk-muted">' + done + ' / ' + list.filter(function(c) { return !c.cancelled_at; }).length + '</span></div>' +
      list.map(function(c) {
        return '<button type="button" class="hk-card hk-card-' + hkTagClass(c) + '" data-hk="open" data-id="' + c.id + '">' +
          '<span class="hk-card-room">' + escapeHtml(hkRoom(c.room_id).name) + '</span>' +
          '<span class="hk-card-type">' + escapeHtml(hkType(c.cleaning_type_id).name) + (c.schedule_id ? "" : " · one-off") + '</span>' +
          hkStatusLine(c) + '</button>';
      }).join("") + '</div>';
  }).join("") + '</div>';
  return html;
}

function hkWorkerOptions(selected, blank) {
  return '<option value="">' + (blank || "Unassigned") + '</option>' + HK.workers.map(function(w) {
    return '<option value="' + w.id + '"' + (w.id === selected ? " selected" : "") + '>' + escapeHtml(w.name) + '</option>';
  }).join("");
}

function hkTypeOptions(selected) {
  return HK.types.filter(function(t) { return !t.archived || t.id === selected; }).map(function(t) {
    return '<option value="' + t.id + '"' + (t.id === selected ? " selected" : "") + '>' + escapeHtml(t.name) + (t.target_minutes ? " (" + t.target_minutes + " min)" : "") + '</option>';
  }).join("");
}

function hkRoomDatalist() {
  return '<datalist id="hkRoomOptions">' + HK.rooms.map(function(r) { return '<option value="' + escapeHtml(r.name) + '">'; }).join("") + '</datalist>';
}

function hkAddCleaningForm() {
  return '<form class="rm-add" data-hk="add-form" autocomplete="off">' +
    '<div class="rm-add-fields">' +
      '<label class="rm-field">Room<input class="config-input" name="room" list="hkRoomOptions" placeholder="e.g. 204" required /></label>' + hkRoomDatalist() +
      '<label class="rm-field">Cleaning<select class="config-input" name="type">' + hkTypeOptions(null) + '</select></label>' +
      '<label class="rm-field">Housekeeper<select class="config-input" name="who">' + hkWorkerOptions(null) + '</select></label>' +
      '<label class="rm-field rm-field-wide">Note<input class="config-input" name="notes" placeholder="optional, e.g. resident asked for an extra clean" /></label>' +
    '</div>' +
    '<div class="rm-add-foot"><span class="tk-muted">A one-off cleaning for ' + escapeHtml(hkDateLabel(HK.date)) + '.</span>' +
      '<span><button type="button" class="tk-tool-btn" data-hk="add-cancel">Cancel</button> <button type="submit" class="config-btn">Add</button></span></div>' +
  '</form>';
}

function hkRoomByName(name) {
  var k = rmKey(name);
  return HK.rooms.find(function(r) { return rmKey(r.name) === k; });
}

async function hkAddCleaning(form) {
  var room = hkRoomByName(form.room.value);
  if (!room) { alert("“" + form.room.value + "” isn't on the room list. Add it under Maintenance → Rooms first."); return; }
  var res = await sb.from("cleanings").insert({
    property_code: HK.code, room_id: room.id, clean_date: HK.date, cleaning_type_id: form.type.value,
    housekeeper_id: form.who.value || null, notes: form.notes.value.trim()
  });
  if (res.error) { hkFail("Couldn't add the cleaning", res.error); return; }
  HK.adding = false;
  hkLoad();
}

// ── One cleaning: the details box ────────────────────────────────────────────

function hkCleaning(id) { return HK.cleanings.find(function(c) { return c.id === id; }); }

function hkOpenCleaning(id) {
  var c = hkCleaning(id);
  if (!c) return;
  var st = hkStatus(c);
  var dis = HK.canWork ? "" : " disabled";
  var target = hkType(c.cleaning_type_id).target_minutes;
  var stamps = [];
  if (c.started_at) stamps.push("Started " + hkTime(c.started_at) + (c.started_by_name ? " by " + escapeHtml(c.started_by_name) : ""));
  if (c.finished_at) stamps.push("Done " + hkTime(c.finished_at) + (c.finished_by_name ? " by " + escapeHtml(c.finished_by_name) : "") +
    (hkMinutes(c) != null ? " · " + hkMinutes(c) + " min" + (target ? " (target " + target + ")" : "") : ""));
  if (c.skipped_at) stamps.push("Skipped " + hkTime(c.skipped_at) + (c.skipped_by_name ? " by " + escapeHtml(c.skipped_by_name) : "") + " — " + escapeHtml(c.skip_reason || ""));
  if (c.cancelled_at) stamps.push("Cancelled " + hkTime(c.cancelled_at) + (c.cancelled_by_name ? " by " + escapeHtml(c.cancelled_by_name) : "") + " — " + escapeHtml(c.cancel_reason || ""));

  var modal = document.createElement("div");
  modal.className = "tk-modal";
  modal.innerHTML = '<div class="tk-modal-box tk-modal-small hk-detail" role="dialog" aria-label="Cleaning">' +
    '<div class="tk-modal-head"><h3>' + escapeHtml(hkRoom(c.room_id).name) + ' · ' + escapeHtml(hkType(c.cleaning_type_id).name) + '</h3>' +
      '<button type="button" class="tk-pane-close" data-hkd="close" aria-label="Close">&times;</button></div>' +
    '<p class="tk-muted">' + escapeHtml(hkDateLabel(c.clean_date)) + (c.schedule_id ? " · from its schedule" : " · one-off, added by " + escapeHtml(c.created_by_name || "")) + '</p>' +
    (stamps.length ? '<ul class="hk-stamps">' + stamps.map(function(s) { return '<li>' + s + '</li>'; }).join("") + '</ul>' : "") +
    '<label class="rm-field">Housekeeper<select class="config-input" data-hkd="who"' + dis + (st === "cancelled" ? " disabled" : "") + '>' + hkWorkerOptions(c.housekeeper_id) + '</select></label>' +
    '<label class="rm-field">Note<input class="config-input" data-hkd="notes" value="' + escapeHtml(c.notes) + '"' + dis + ' placeholder="optional" /></label>' +
    (HK.canWork ? '<div class="hk-actions">' + hkActionButtons(c, "hkd") + '</div>' +
      (st !== "cancelled" ? '<div class="hk-more"><button type="button" class="link-btn" data-hkd="problem">Report a problem in this room</button>' +
        (st === "todo" ? '<button type="button" class="link-btn" data-hkd="cancel">Cancel this cleaning</button>' : "") + '</div>' : "")
      : "") +
  '</div>';
  HK.el.querySelector(".hk").appendChild(modal);
  var close = function(reload) { modal.remove(); if (reload) hkLoad(true); };
  modal.addEventListener("click", function(e) {
    if (e.target === modal || e.target.closest("[data-hkd='close']")) { close(false); return; }
    var b = e.target.closest("[data-hkd]");
    if (!b) return;
    hkAct(c, b.getAttribute("data-hkd"), function() { close(true); });
  });
  modal.addEventListener("change", async function(e) {
    var f = e.target.getAttribute("data-hkd");
    if (f !== "who" && f !== "notes") return;
    var change = f === "who" ? { housekeeper_id: e.target.value || null } : { notes: e.target.value.trim() };
    var res = await sb.from("cleanings").update(change).eq("id", c.id);
    if (res.error) { hkFail("Couldn't save that", res.error); return; }
    Object.assign(c, change);
    hkRender();
    HK.el.querySelector(".hk").appendChild(modal);
  });
}

// The buttons for where a cleaning is up to. `attr` is the data attribute the
// buttons use ("hkd" in the details box, "hkm" on My rooms).
function hkActionButtons(c, attr) {
  var st = hkStatus(c);
  var b = function(what, label, cls) { return '<button type="button" class="' + (cls || "tk-tool-btn") + '" data-' + attr + '="' + what + '" data-id="' + c.id + '">' + label + '</button>'; };
  if (st === "todo") return b("start", "Start", "config-btn") + b("done", "Done") + b("skip", "Skip…");
  if (st === "started") return b("done", "Done", "config-btn") + b("unstart", "Undo start");
  if (st === "done") return b("undone", "Undo done");
  if (st === "skipped") return b("unskip", "Undo skip");
  if (st === "cancelled") return b("uncancel", "Undo cancel");
  return "";
}

// Start / Done / Skip / Undo / Cancel / Report a problem. The database stamps the times.
async function hkAct(c, what, after) {
  var now = new Date().toISOString();
  var change = null;
  if (what === "start") change = { started_at: now };
  else if (what === "done") change = { finished_at: now };
  else if (what === "unstart") change = { started_at: null };
  else if (what === "undone") change = { finished_at: null };
  else if (what === "unskip") change = { skipped_at: null };
  else if (what === "uncancel") change = { cancelled_at: null };
  else if (what === "skip") {
    var reason = hkAskReason("Why is " + hkRoom(c.room_id).name + " being skipped?", HK_SKIP_REASONS);
    if (!reason) return;
    change = { skipped_at: now, skip_reason: reason };
  } else if (what === "cancel") {
    var why = prompt("Why is this cleaning being cancelled? (It stays on record.)", c.schedule_id ? "Not needed this week" : "Added by mistake");
    if (!why || !why.trim()) return;
    change = { cancelled_at: now, cancel_reason: why.trim() };
  } else if (what === "problem") {
    await hkReportProblem(c);
    return;
  } else return;
  var res = await sb.from("cleanings").update(change).eq("id", c.id);
  if (res.error) { hkFail("Couldn't save that", res.error); return; }
  if (after) after(); else hkLoad(true);
}

// A small pick-a-reason prompt: the numbered choices, or type your own.
function hkAskReason(question, reasons) {
  var answer = prompt(question + "\n\n" + reasons.map(function(r, i) { return (i + 1) + ". " + r; }).join("\n") +
    "\n\nType a number, or your own reason:", "1");
  if (answer == null) return null;
  answer = answer.trim();
  var n = parseInt(answer, 10);
  if (String(n) === answer && reasons[n - 1]) {
    if (reasons[n - 1] !== "Other") return reasons[n - 1];
    var other = prompt("What's the reason?", "");
    return other && other.trim() ? other.trim() : null;
  }
  return answer || null;
}

// Logs a work order for the room on the building's Work Orders list.
async function hkReportProblem(c) {
  var room = hkRoom(c.room_id);
  var text = prompt("What's the problem in " + room.name + "? It goes straight onto maintenance's Work Orders list.", "");
  if (!text || !text.trim()) return;
  var list = await sb.from("task_lists").select("id").eq("property_code", HK.code).eq("kind", "work_orders").eq("archived", false).order("sort_order").limit(1);
  if (list.error || !list.data.length) { hkFail("Couldn't find this building's Work Orders list", list.error || "There isn't one yet."); return; }
  var res = await sb.from("tasks").insert({ property_code: HK.code, list_id: list.data[0].id, room: room.name, title: text.trim() });
  if (res.error) { hkFail("Couldn't log the work order", res.error); return; }
  alert("Work order logged for " + room.name + ": “" + text.trim() + "”.");
}

// ── My rooms (Staff screen) ──────────────────────────────────────────────────

function hkMineHtml() {
  var me = hkMyId();
  var mine = HK.cleanings.filter(function(c) { return c.housekeeper_id === me && !c.cancelled_at; })
    .sort(function(a, b) {
      // Rooms still to do first (in room order), finished ones at the bottom.
      var fa = hkStatus(a) === "done" || hkStatus(a) === "skipped", fb = hkStatus(b) === "done" || hkStatus(b) === "skipped";
      if (fa !== fb) return fa ? 1 : -1;
      return rmCompareNames(hkRoom(a.room_id).name, hkRoom(b.room_id).name);
    });
  var unassigned = HK.cleanings.filter(function(c) { return !c.housekeeper_id && !c.cancelled_at && hkStatus(c) === "todo"; }).length;
  var left = mine.filter(function(c) { return hkStatus(c) === "todo" || hkStatus(c) === "started"; }).length;
  var html = hkDateBar() +
    '<div class="hk-summary">' + (mine.length ? '<b>' + left + '</b> of ' + mine.length + ' room' + (mine.length === 1 ? "" : "s") + ' left' : "") +
      (unassigned ? ' · <button type="button" class="link-btn" data-hk="view" data-value="board">' + unassigned + ' unassigned on the day board</button>' : "") + '</div>';
  if (!mine.length) return html + '<div class="tk-empty"><p><b>No rooms assigned to you on this day.</b></p><p>Check the <button type="button" class="link-btn" data-hk="view" data-value="board">Board</button> for the whole building.</p></div>';
  return html + '<div class="hk-mine">' + mine.map(function(c) {
    var st = hkStatus(c);
    return '<div class="hk-mine-card hk-card-' + st + '">' +
      '<div class="hk-mine-top"><span class="hk-mine-room">' + escapeHtml(hkRoom(c.room_id).name) + '</span>' +
        '<span class="hk-card-type">' + escapeHtml(hkType(c.cleaning_type_id).name) + '</span></div>' +
      (c.notes ? '<div class="hk-mine-note">' + escapeHtml(c.notes) + '</div>' : "") +
      '<div>' + hkStatusLine(c) + '</div>' +
      (HK.canWork ? '<div class="hk-actions hk-actions-big">' + hkActionButtons(c, "hkm") +
        (st !== "cancelled" ? '<button type="button" class="tk-tool-btn" data-hkm="problem" data-id="' + c.id + '">Report a problem</button>' : "") + '</div>' : "") +
    '</div>';
  }).join("") + '</div>';
}

// ── Schedules ────────────────────────────────────────────────────────────────

function hkEveryLabel(n) {
  var e = HK_EVERY.find(function(x) { return x[0] === n; });
  return e ? e[1] : "Every " + n + " weeks";
}

function hkSchedulesHtml() {
  var list = HK.schedules.slice().sort(function(a, b) {
    return rmCompareNames(hkRoom(a.room_id).name, hkRoom(b.room_id).name) || a.weekday - b.weekday;
  });
  var html = '<div class="hk-summary"><b>' + list.length + '</b> repeating cleaning' + (list.length === 1 ? "" : "s") + ' across <b>' +
    Object.keys(list.reduce(function(m, s) { m[s.room_id] = 1; return m; }, {})).length + '</b> rooms' +
    (HK.canWork ? '<button type="button" class="config-btn hk-add-btn" data-hk="add">+ Add schedules</button>' : "") + '</div>';
  if (HK.adding) html += hkScheduleForm();
  if (!list.length) {
    return html + '<div class="tk-empty"><p><b>No repeating cleanings yet.</b></p><p>' +
      (HK.rooms.length ? 'Use <b>+ Add schedules</b> — you can set up many rooms at once, e.g. every 1 Bedroom on floor 2, weekly on Tuesdays.'
        : 'Add the building\'s rooms under <b>Maintenance → Rooms</b> first.') + '</p></div>';
  }
  html += '<div class="hk-sched-table"><div class="hk-sched-row rm-row-head"><div>Room</div><div>Cleaning</div><div>How often</div><div>Day</div><div>Usually</div><div></div></div>';
  list.forEach(function(s) {
    if (HK.editId === s.id) { html += hkScheduleEditRow(s); return; }
    html += '<div class="hk-sched-row"><div class="rm-name">' + escapeHtml(hkRoom(s.room_id).name) + '</div>' +
      '<div>' + escapeHtml(hkType(s.cleaning_type_id).name) + '</div>' +
      '<div>' + hkEveryLabel(s.interval_weeks) + '</div>' +
      '<div>' + HK_DAYS[s.weekday] + '</div>' +
      '<div>' + escapeHtml(hkWorkerName(s.housekeeper_id)) + '</div>' +
      '<div class="rm-eq-actions">' + (HK.canWork && !HK.editId
        ? '<button type="button" class="link-btn" data-hk="sched-edit" data-id="' + s.id + '">Edit</button>' +
          '<button type="button" class="link-btn" data-hk="sched-stop" data-id="' + s.id + '">Stop</button>' : "") + '</div>' +
      (s.notes ? '<div class="hk-sched-note tk-muted">' + escapeHtml(s.notes) + '</div>' : "") +
    '</div>';
  });
  return html + '</div>';
}

function hkDayOptions(selected) {
  return HK_DAYS.slice(1).map(function(d, i) { return '<option value="' + (i + 1) + '"' + (i + 1 === selected ? " selected" : "") + '>' + d + '</option>'; }).join("");
}

function hkEveryOptions(selected) {
  return HK_EVERY.map(function(e) { return '<option value="' + e[0] + '"' + (e[0] === selected ? " selected" : "") + '>' + e[1] + '</option>'; }).join("");
}

function hkScheduleForm() {
  var floors = {};
  HK.rooms.forEach(function(r) { if (r.floor) floors[r.floor] = 1; });
  return '<form class="rm-add" data-hk="sched-form" autocomplete="off">' +
    '<div class="hk-pick"><span class="tk-muted">Quick pick:</span>' +
      '<select class="config-input" data-hk="pick-type"><option value="">Any unit type</option>' + (HK.unitTypes || []).map(function(t) { return '<option value="' + t.id + '">' + escapeHtml(t.name) + '</option>'; }).join("") + '<option value="__common">Common areas</option></select>' +
      '<select class="config-input" data-hk="pick-floor"><option value="">Any floor</option>' + Object.keys(floors).sort(rmCompareNames).map(function(f) { return '<option>' + escapeHtml(f) + '</option>'; }).join("") + '</select>' +
      '<button type="button" class="tk-tool-btn" data-hk="pick">Fill in those rooms</button></div>' +
    '<div class="rm-add-fields">' +
      '<label class="rm-field rm-field-wide">Rooms<input class="config-input" name="rooms" placeholder="e.g. 201-224, Lobby" required /></label>' +
      '<label class="rm-field">Cleaning<select class="config-input" name="type">' + hkTypeOptions(null) + '</select></label>' +
      '<label class="rm-field">How often<select class="config-input" name="every">' + hkEveryOptions(1) + '</select></label>' +
      '<label class="rm-field">Day<select class="config-input" name="weekday">' + hkDayOptions(hkWeekday(hkToday())) + '</select></label>' +
      '<label class="rm-field">Starting<input class="config-input" type="date" name="start" value="' + hkToday() + '" /></label>' +
      '<label class="rm-field">Usually<select class="config-input" name="who">' + hkWorkerOptions(null, "No one yet") + '</select></label>' +
    '</div>' +
    '<div class="rm-add-foot"><span class="hk-sched-preview tk-muted"></span>' +
      '<span><button type="button" class="tk-tool-btn" data-hk="add-cancel">Cancel</button> <button type="submit" class="config-btn">Add</button></span></div>' +
  '</form>';
}

function hkScheduleEditRow(s) {
  return '<form class="hk-sched-row hk-sched-edit" data-hk="sched-edit-form" data-id="' + s.id + '">' +
    '<div class="rm-name">' + escapeHtml(hkRoom(s.room_id).name) + '</div>' +
    '<div><select class="config-input" name="type">' + hkTypeOptions(s.cleaning_type_id) + '</select></div>' +
    '<div><select class="config-input" name="every">' + hkEveryOptions(s.interval_weeks) + '</select></div>' +
    '<div><select class="config-input" name="weekday">' + hkDayOptions(s.weekday) + '</select></div>' +
    '<div><select class="config-input" name="who">' + hkWorkerOptions(s.housekeeper_id, "No one yet") + '</select></div>' +
    '<div class="rm-eq-actions"><button type="button" class="link-btn" data-hk="sched-edit-cancel">Cancel</button><button type="submit" class="config-btn">Save</button></div>' +
    '<div class="hk-sched-note"><input class="config-input" name="notes" value="' + escapeHtml(s.notes) + '" placeholder="Note (optional), e.g. resident prefers mornings" /></div>' +
  '</form>';
}

// "201-224, Lobby" → the matching rooms on the list (and any names not found).
function hkParseRooms(text) {
  var parsed = rmParseNames(text);
  var rooms = [], missing = [], seen = {};
  parsed.names.forEach(function(n) {
    var r = hkRoomByName(n);
    if (!r) { missing.push(n); return; }
    if (!seen[r.id]) { seen[r.id] = 1; rooms.push(r); }
  });
  return { rooms: rooms, missing: missing.concat(parsed.bad) };
}

function hkUpdateSchedPreview() {
  var f = HK.el.querySelector("[data-hk='sched-form']");
  if (!f) return;
  var p = hkParseRooms(f.rooms.value);
  var out = f.querySelector(".hk-sched-preview");
  var weekday = +f.weekday.value;
  var first = hkNextWeekday(f.start.value || hkToday(), weekday);
  var bits = [];
  if (p.rooms.length) bits.push(p.rooms.length + " room" + (p.rooms.length === 1 ? "" : "s") + ", " + hkEveryLabel(+f.every.value).toLowerCase() + " on " + HK_DAYS[weekday] + "s, first on " + hkDateLabel(first));
  if (p.missing.length) bits.push("Not on the room list: " + p.missing.slice(0, 6).join(", ") + (p.missing.length > 6 ? "…" : ""));
  out.textContent = bits.join(" · ") || "Type room numbers or a range, or use Quick pick.";
}

async function hkAddSchedules(f) {
  var p = hkParseRooms(f.rooms.value);
  if (!p.rooms.length) { alert("None of those rooms are on the room list."); return; }
  if (p.missing.length && !confirm("These aren't on the room list and will be left out: " + p.missing.join(", ") + ". Add the rest?")) return;
  var weekday = +f.weekday.value;
  var start = hkNextWeekday(f.start.value || hkToday(), weekday);
  var rows = p.rooms.map(function(r) {
    return { room_id: r.id, property_code: HK.code, cleaning_type_id: f.type.value, interval_weeks: +f.every.value,
      weekday: weekday, start_date: start, housekeeper_id: f.who.value || null };
  });
  var btn = f.querySelector("[type='submit']");
  btn.disabled = true;
  var res = await sb.from("cleaning_schedules").insert(rows);
  if (res.error) { btn.disabled = false; hkFail("Couldn't add the schedules", res.error); return; }
  HK.adding = false;
  hkLoad();
}

async function hkSaveSchedule(f) {
  var s = HK.schedules.find(function(x) { return x.id === f.getAttribute("data-id"); });
  var weekday = +f.weekday.value, every = +f.every.value;
  var change = { cleaning_type_id: f.type.value, housekeeper_id: f.who.value || null, notes: f.notes.value.trim(), weekday: weekday, interval_weeks: every };
  // A new day or frequency starts counting from the next such day.
  if (weekday !== s.weekday || every !== s.interval_weeks) change.start_date = hkNextWeekday(hkToday(), weekday);
  var res = await sb.from("cleaning_schedules").update(change).eq("id", s.id);
  if (res.error) { hkFail("Couldn't save", res.error); return; }
  HK.editId = null;
  hkLoad();
}

async function hkStopSchedule(id) {
  var s = HK.schedules.find(function(x) { return x.id === id; });
  if (!confirm("Stop the " + hkEveryLabel(s.interval_weeks).toLowerCase() + " " + hkType(s.cleaning_type_id).name + " for " + hkRoom(s.room_id).name +
    " on " + HK_DAYS[s.weekday] + "s? Upcoming cleanings nobody has started are cancelled; past ones stay on record.")) return;
  var res = await sb.from("cleaning_schedules").update({ archived_at: new Date().toISOString() }).eq("id", id);
  if (res.error) { hkFail("Couldn't stop it", res.error); return; }
  hkLoad();
}

// ── Reports (H2) ─────────────────────────────────────────────────────────────
// For the chosen period: each housekeeper's cleanings (done, skipped, missed,
// minutes against the target), each cleaning type, skip reasons and a weekly
// trend, plus an Excel download. Cancelled cleanings don't count. "Missed" =
// a past day's cleaning nobody finished or skipped. A cleaning counts for the
// housekeeper it was assigned to, whoever tapped the button.

var HK_REP_PERIODS = [[7, "7 days"], [30, "30 days"], [90, "90 days"], [365, "12 months"]];

function hkRepStats(rows) {
  var today = hkToday();
  var s = { total: 0, done: 0, skipped: 0, missed: 0, timed: 0, minutes: 0, onTarget: 0, days: {} };
  rows.forEach(function(c) {
    if (c.cancelled_at || c.clean_date > today) return;
    var st = hkStatus(c);
    var past = c.clean_date < today;
    if (st === "todo" || st === "started") { if (past) { s.missed++; s.total++; } return; }   // today's unfinished ones aren't counted yet
    s.total++;
    if (st === "skipped") { s.skipped++; return; }
    s.done++;
    s.days[c.clean_date] = 1;
    var m = hkMinutes(c);
    if (m != null) {
      s.timed++;
      s.minutes += m;
      var target = hkType(c.cleaning_type_id).target_minutes;
      if (target && m <= target) s.onTarget++;
    }
  });
  s.daysWorked = Object.keys(s.days).length;
  s.avgMin = s.timed ? s.minutes / s.timed : null;
  s.onTargetPct = s.timed ? s.onTarget / s.timed : null;
  s.perDay = s.daysWorked ? s.done / s.daysWorked : null;
  s.doneRate = s.total ? s.done / s.total : null;
  return s;
}

function hkPct(v) { return v == null ? "—" : Math.round(v * 100) + "%"; }
function hkNum(v, d) { return v == null ? "—" : (Math.round(v * Math.pow(10, d || 0)) / Math.pow(10, d || 0)).toFixed(d || 0); }

function hkRepGroups(rows, keyOf) {
  var g = {};
  rows.forEach(function(c) { var k = keyOf(c); (g[k] = g[k] || []).push(c); });
  return g;
}

function hkReportsHtml() {
  var rows = HK.repRows || [];
  var to = hkToday(), from = hkAddDays(to, -(HK.repDays - 1));
  var all = hkRepStats(rows);
  var html = '<div class="hk-rep-bar"><div class="wo-switch rm-filter">' + HK_REP_PERIODS.map(function(p) {
      return '<button type="button" data-hk="rep-days" data-value="' + p[0] + '" class="' + (p[0] === HK.repDays ? "active" : "") + '">' + p[1] + '</button>';
    }).join("") + '</div>' +
    '<span class="tk-muted">' + escapeHtml(formatDateOnly(from)) + ' – ' + escapeHtml(formatDateOnly(to)) + '</span>' +
    (rows.length ? '<button type="button" class="tk-tool-btn hk-rep-xlsx" data-hk="rep-xlsx">Download Excel</button>' : "") + '</div>';

  if (!all.total) {
    return html + '<div class="tk-empty"><p><b>Nothing to report for this period yet.</b></p><p>Reports fill in as cleanings are done, skipped or missed. Set up repeating cleanings under <b>Schedules</b>.</p></div>';
  }

  html += '<div class="rm-tiles">' +
    rmTile(all.done, "Cleanings done") +
    rmTile(all.avgMin == null ? "—" : hkNum(all.avgMin) + " min", "Average time" + (all.onTargetPct == null ? "" : "<br>" + hkPct(all.onTargetPct) + " on target")) +
    rmTile(all.skipped, "Skipped") +
    rmTile(all.missed, "Missed") +
  '</div>';

  // By housekeeper, most done first, with a bar.
  var byWho = hkRepGroups(rows, function(c) { return c.housekeeper_id || ""; });
  var people = Object.keys(byWho).map(function(k) { return { key: k, name: hkWorkerName(k), s: hkRepStats(byWho[k]) }; })
    .filter(function(p) { return p.s.total; })
    .sort(function(a, b) { return b.s.done - a.s.done || a.name.localeCompare(b.name); });
  var maxDone = Math.max.apply(null, people.map(function(p) { return p.s.done; }).concat([1]));
  html += '<div class="rm-section"><div class="rm-section-title">By housekeeper</div>' +
    '<div class="hk-rep-table hk-rep-who"><div class="hk-rep-row rm-row-head"><div>Housekeeper</div><div></div><div>Done</div><div>Per day<br>worked</div><div>Avg<br>min</div><div>On<br>target</div><div>Skipped</div><div>Missed</div></div>' +
    people.map(function(p) {
      return '<div class="hk-rep-row"><div class="rm-name">' + escapeHtml(p.name) + '</div>' +
        '<div class="rm-top-bar"><span style="width:' + Math.max(3, Math.round(p.s.done / maxDone * 100)) + '%"></span></div>' +
        '<div><b>' + p.s.done + '</b></div><div>' + hkNum(p.s.perDay, 1) + '</div><div>' + hkNum(p.s.avgMin) + '</div>' +
        '<div>' + hkPct(p.s.onTargetPct) + '</div><div>' + (p.s.skipped || '<span class="tk-muted">0</span>') + '</div>' +
        '<div>' + (p.s.missed ? '<span class="hk-over">' + p.s.missed + '</span>' : '<span class="tk-muted">0</span>') + '</div></div>';
    }).join("") + '</div>' +
    '<p class="tk-muted rm-section-note">Per day worked = cleanings done ÷ days they finished at least one. On target = finished within the cleaning type\'s target time (only cleanings that were started and finished have a time).</p>' +
  '</div>';

  // Weekly trend, one line per housekeeper (30 days and longer).
  if (HK.repDays >= 30) html += hkTrendHtml(rows, people, from, to);

  // By cleaning type.
  var byType = hkRepGroups(rows, function(c) { return c.cleaning_type_id; });
  html += '<div class="hk-rep-cols"><div class="rm-section"><div class="rm-section-title">By cleaning type</div>' +
    '<div class="hk-rep-table"><div class="hk-rep-row hk-rep-type rm-row-head"><div>Cleaning</div><div>Done</div><div>Avg<br>min</div><div>Target</div><div>On<br>target</div></div>' +
    Object.keys(byType).map(function(k) { return { t: hkType(k), s: hkRepStats(byType[k]) }; })
      .filter(function(x) { return x.s.total; })
      .sort(function(a, b) { return b.s.done - a.s.done; })
      .map(function(x) {
        return '<div class="hk-rep-row hk-rep-type"><div class="rm-name">' + escapeHtml(x.t.name) + '</div><div><b>' + x.s.done + '</b></div>' +
          '<div' + (x.s.avgMin != null && x.t.target_minutes && x.s.avgMin > x.t.target_minutes ? ' class="hk-over"' : "") + '>' + hkNum(x.s.avgMin) + '</div>' +
          '<div>' + (x.t.target_minutes || "—") + '</div><div>' + hkPct(x.s.onTargetPct) + '</div></div>';
      }).join("") + '</div></div>';

  // Skip reasons.
  var reasons = {};
  rows.forEach(function(c) { if (c.skipped_at && !c.cancelled_at) reasons[c.skip_reason || "(no reason)"] = (reasons[c.skip_reason || "(no reason)"] || 0) + 1; });
  var rk = Object.keys(reasons).sort(function(a, b) { return reasons[b] - reasons[a]; });
  html += '<div class="rm-section"><div class="rm-section-title">Why cleanings were skipped</div>' +
    (rk.length ? '<div class="hk-rep-table">' + rk.map(function(r) {
      return '<div class="hk-rep-row hk-rep-reason"><div>' + escapeHtml(r) + '</div><div><b>' + reasons[r] + '</b></div></div>';
    }).join("") + '</div>' : '<p class="tk-muted">No skipped cleanings in this period.</p>') +
  '</div></div>';
  return html;
}

// Weeks (Monday–Sunday) in the period, and a small line chart of cleanings
// done per week for each housekeeper.
function hkTrendHtml(rows, people, from, to) {
  var weeks = [];
  var start = hkAddDays(from, 1 - hkWeekday(from));
  for (var d = start; d <= to; d = hkAddDays(d, 7)) weeks.push(d);
  if (weeks.length < 2) return "";
  var css = getComputedStyle(document.documentElement);
  var series = people.filter(function(p) { return p.key; }).map(function(p, i) {
    var counts = weeks.map(function(w) {
      var end = hkAddDays(w, 7);
      return rows.filter(function(c) { return (c.housekeeper_id || "") === p.key && c.finished_at && !c.cancelled_at && c.clean_date >= w && c.clean_date < end; }).length;
    });
    return { name: p.name, color: css.getPropertyValue("--person-" + (i % 6 + 1)).trim(), counts: counts };
  });
  if (!series.length) return "";
  var W = 760, H = 220, L = 34, R = 12, T = 12, B = 30;
  var max = Math.max.apply(null, series.map(function(s) { return Math.max.apply(null, s.counts); }).concat([1]));
  var yMax = Math.ceil(max / 5) * 5 || 5;
  var x = function(i) { return L + (weeks.length === 1 ? 0 : i * (W - L - R) / (weeks.length - 1)); };
  var y = function(v) { return T + (H - T - B) * (1 - v / yMax); };
  var grid = "";
  for (var g = 0; g <= 5; g++) {
    var v = yMax / 5 * g;
    grid += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(v) + '" y2="' + y(v) + '" class="hk-grid" />' +
      '<text x="' + (L - 6) + '" y="' + (y(v) + 3) + '" class="hk-axis" text-anchor="end">' + Math.round(v) + '</text>';
  }
  var step = Math.max(1, Math.ceil(weeks.length / 8));
  var labels = weeks.map(function(w, i) {
    if ((weeks.length - 1 - i) % step) return "";
    // The first and last labels hug the edges so they aren't cut off.
    var anchor = i === weeks.length - 1 ? "end" : i === 0 ? "start" : "middle";
    return '<text x="' + x(i) + '" y="' + (H - 8) + '" class="hk-axis" text-anchor="' + anchor + '">' + escapeHtml(new Date(w + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" })) + '</text>';
  }).join("");
  var lines = series.map(function(s) {
    return '<polyline fill="none" stroke="' + s.color + '" stroke-width="2.5" points="' + s.counts.map(function(c, i) { return x(i) + "," + y(c); }).join(" ") + '" />' +
      s.counts.map(function(c, i) { return '<circle cx="' + x(i) + '" cy="' + y(c) + '" r="3" fill="' + s.color + '"><title>' + escapeHtml(s.name) + ': ' + c + '</title></circle>'; }).join("");
  }).join("");
  return '<div class="rm-section"><div class="rm-section-title">Cleanings done per week</div>' +
    '<div class="hk-trend-wrap"><svg class="hk-trend" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Cleanings done per week, by housekeeper">' + grid + labels + lines + '</svg></div>' +
    '<div class="compare-legend">' + series.map(function(s) { return '<span><span class="compare-dot" style="background:' + s.color + '"></span>' + escapeHtml(s.name) + '</span>'; }).join("") + '</div>' +
    '<p class="tk-muted rm-section-note">Weeks run Monday–Sunday; the first and last weeks may be partial.</p></div>';
}

// Excel: the summary tables plus every cleaning in the period.
function hkReportXlsx() {
  var rows = HK.repRows || [];
  var to = hkToday(), from = hkAddDays(to, -(HK.repDays - 1));
  var byWho = hkRepGroups(rows, function(c) { return c.housekeeper_id || ""; });
  var whoRows = Object.keys(byWho).map(function(k) { return { name: hkWorkerName(k), s: hkRepStats(byWho[k]) }; })
    .filter(function(p) { return p.s.total; }).sort(function(a, b) { return b.s.done - a.s.done; })
    .map(function(p) { return [p.name, p.s.done, p.s.daysWorked, p.s.perDay == null ? null : Math.round(p.s.perDay * 10) / 10,
      p.s.avgMin == null ? null : Math.round(p.s.avgMin), p.s.onTargetPct == null ? null : Math.round(p.s.onTargetPct * 100), p.s.skipped, p.s.missed]; });
  var byType = hkRepGroups(rows, function(c) { return c.cleaning_type_id; });
  var typeRows = Object.keys(byType).map(function(k) { return { t: hkType(k), s: hkRepStats(byType[k]) }; })
    .filter(function(x) { return x.s.total; })
    .map(function(x) { return [x.t.name, x.s.done, x.s.avgMin == null ? null : Math.round(x.s.avgMin), x.t.target_minutes, x.s.onTargetPct == null ? null : Math.round(x.s.onTargetPct * 100), x.s.skipped, x.s.missed]; });
  var reasons = {};
  rows.forEach(function(c) { if (c.skipped_at && !c.cancelled_at) reasons[c.skip_reason || "(no reason)"] = (reasons[c.skip_reason || "(no reason)"] || 0) + 1; });
  var today = hkToday();
  var detail = rows.slice().sort(function(a, b) {
    return a.clean_date < b.clean_date ? -1 : a.clean_date > b.clean_date ? 1 : rmCompareNames(hkRoom(a.room_id).name, hkRoom(b.room_id).name);
  }).map(function(c) {
    var st = hkStatus(c);
    var label = st === "done" ? "Done" : st === "skipped" ? "Skipped" : st === "cancelled" ? "Cancelled"
      : c.clean_date < today ? "Missed" : st === "started" ? "In progress" : "Not started";
    return [c.clean_date, hkRoom(c.room_id).name, hkType(c.cleaning_type_id).name, hkWorkerName(c.housekeeper_id), label,
      hkTime(c.started_at), hkTime(c.finished_at), hkMinutes(c), hkType(c.cleaning_type_id).target_minutes,
      c.skip_reason || c.cancel_reason || "", c.finished_by_name || c.skipped_by_name || "", c.schedule_id ? "Schedule" : "One-off", c.notes];
  });
  var col = function(h, w, t) { return { header: h, width: w, type: t || "text" }; };
  var book = buildXlsxWorkbookSheets(JSZip, [
    { name: "By housekeeper", columns: [col("Housekeeper", 26), col("Done", 8, "int"), col("Days worked", 11, "int"), col("Per day worked", 13, "dec1"),
      col("Avg minutes", 11, "int"), col("On target %", 11, "int"), col("Skipped", 9, "int"), col("Missed", 9, "int")], rows: whoRows },
    { name: "By cleaning type", columns: [col("Cleaning", 20), col("Done", 8, "int"), col("Avg minutes", 11, "int"), col("Target minutes", 13, "int"),
      col("On target %", 11, "int"), col("Skipped", 9, "int"), col("Missed", 9, "int")], rows: typeRows },
    { name: "Skip reasons", columns: [col("Reason", 26), col("Times", 8, "int")], rows: Object.keys(reasons).map(function(r) { return [r, reasons[r]]; }) },
    { name: "All cleanings", columns: [col("Date", 12, "date"), col("Room", 10), col("Cleaning", 18), col("Housekeeper", 24), col("Status", 12),
      col("Started", 10), col("Finished", 10), col("Minutes", 9, "int"), col("Target", 8, "int"), col("Reason", 24), col("Tapped by", 22),
      col("From", 10), col("Notes", 30)], rows: detail }
  ]);
  book.generateAsync({ type: "blob", compression: "DEFLATE", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }).then(function(blob) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "housekeeping_" + HK.code + "_" + from + "_to_" + to + ".xlsx";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function() { URL.revokeObjectURL(a.href); }, 1000);
  }).catch(function(err) { hkFail("Couldn't make the Excel file", err); });
}

// ── Cleaning types (Admins and Editors) ──────────────────────────────────────

function hkOpenTypes() {
  var modal = document.createElement("div");
  modal.className = "tk-modal";
  HK.el.querySelector(".hk").appendChild(modal);
  var draw = function() {
    modal.innerHTML = '<div class="tk-modal-box rm-types" role="dialog" aria-label="Cleaning types">' +
      '<div class="tk-modal-head"><h3>Cleaning types</h3><button type="button" class="tk-pane-close" data-hkt="close" aria-label="Close">&times;</button></div>' +
      '<p class="tk-muted">One list for every building in the company. The target time is what a cleaning of that type should usually take. Changes save as you type; archiving hides a choice but keeps it on past cleanings.</p>' +
      '<div class="rm-types-list"><div class="rm-et-row rm-row-head"><div>Cleaning</div><div>Target (minutes)</div><div></div><div></div></div>' +
      HK.types.map(function(t) {
        var dis = t.archived ? " disabled" : "";
        return '<div class="rm-et-row' + (t.archived ? " rm-archived" : "") + '">' +
          '<input class="config-input" data-hkt="name" data-id="' + t.id + '" value="' + escapeHtml(t.name) + '"' + dis + ' aria-label="Name" />' +
          '<input class="config-input" type="number" min="1" max="600" data-hkt="mins" data-id="' + t.id + '" value="' + (t.target_minutes == null ? "" : t.target_minutes) + '"' + dis + ' aria-label="Target minutes" />' +
          '<div></div><button type="button" class="tk-tool-btn" data-hkt="archive" data-id="' + t.id + '">' + (t.archived ? "Restore" : "Archive") + '</button></div>';
      }).join("") + '</div>' +
      '<form class="rm-alias-add rm-et-new"><input class="config-input" name="newname" placeholder="Add a type, e.g. Window cleaning" />' +
        '<input class="config-input" type="number" min="1" max="600" name="mins" placeholder="Minutes" /><button type="submit" class="tk-tool-btn">Add</button></form>' +
    '</div>';
  };
  draw();
  modal.addEventListener("click", async function(e) {
    if (e.target === modal || e.target.closest("[data-hkt='close']")) { modal.remove(); hkLoad(true); return; }
    var b = e.target.closest("[data-hkt='archive']");
    if (!b) return;
    var t = HK.types.find(function(x) { return x.id === b.getAttribute("data-id"); });
    var res = await sb.from("cleaning_types").update({ archived: !t.archived }).eq("id", t.id);
    if (res.error) { hkFail("Couldn't change that", res.error); return; }
    t.archived = !t.archived;
    draw();
  });
  modal.addEventListener("change", async function(e) {
    var what = e.target.getAttribute("data-hkt");
    if (what !== "name" && what !== "mins") return;
    var t = HK.types.find(function(x) { return x.id === e.target.getAttribute("data-id"); });
    var change = what === "name" ? { name: e.target.value.trim() } : { target_minutes: e.target.value === "" ? null : parseInt(e.target.value, 10) };
    if (what === "name" && !change.name) { e.target.value = t.name; return; }
    var res = await sb.from("cleaning_types").update(change).eq("id", t.id);
    if (res.error) { hkFail("Couldn't save that", res.error); draw(); return; }
    Object.assign(t, change);
  });
  modal.addEventListener("submit", async function(e) {
    e.preventDefault();
    var name = e.target.newname.value.trim();
    if (!name) return;
    var order = HK.types.reduce(function(m, u) { return Math.max(m, u.sort_order); }, 0) + 1;
    var row = { company_id: hkProp().companyId, name: name, sort_order: order };
    if (e.target.mins.value) row.target_minutes = parseInt(e.target.mins.value, 10);
    var res = await sb.from("cleaning_types").insert(row).select().single();
    if (res.error) { hkFail("Couldn't add", res.error); return; }
    HK.types.push(res.data);
    draw();
  });
}

// ── Clicks, typing and forms ─────────────────────────────────────────────────

function hkWire() {
  var root = HK.el.querySelector(".hk");
  if (!root) return;
  root.addEventListener("click", function(e) {
    var t = e.target.closest("[data-hk], [data-hkm]");
    if (!t || t.closest(".tk-modal")) return;
    if (t.hasAttribute("data-hkm")) {
      var c = hkCleaning(t.getAttribute("data-id"));
      if (c) hkAct(c, t.getAttribute("data-hkm"));
      return;
    }
    var what = t.getAttribute("data-hk");
    if (what === "retry") hkLoad();
    else if (what === "view") { HK.view = t.getAttribute("data-value"); HK.adding = false; HK.editId = null; hkLoad(); }
    else if (what === "day") { HK.date = hkAddDays(HK.date, +t.getAttribute("data-value")); hkLoad(); }
    else if (what === "today") { HK.date = hkToday(); hkLoad(); }
    else if (what === "mode") hkSetBoardMode(t.getAttribute("data-value"));
    else if (what === "goto-day") { HK.date = t.getAttribute("data-value"); hkSetBoardMode("day"); }
    else if (what === "cancelled") { HK.showCancelled = !HK.showCancelled; hkRender(); }
    else if (what === "rep-days") { HK.repDays = +t.getAttribute("data-value"); HK.repRows = null; hkLoad(); }
    else if (what === "rep-xlsx") hkReportXlsx();
    else if (what === "add") { HK.adding = !HK.adding; hkRender(); var box = root.ownerDocument.querySelector(".hk [name='room'], .hk [name='rooms']"); if (box) box.focus(); hkUpdateSchedPreview(); }
    else if (what === "add-cancel") { HK.adding = false; hkRender(); }
    else if (what === "open") hkOpenCleaning(t.getAttribute("data-id"));
    else if (what === "types") hkOpenTypes();
    else if (what === "sched-edit") { HK.editId = t.getAttribute("data-id"); hkRender(); }
    else if (what === "sched-edit-cancel") { HK.editId = null; hkRender(); }
    else if (what === "sched-stop") hkStopSchedule(t.getAttribute("data-id"));
    else if (what === "pick") {
      var f = root.querySelector("[data-hk='sched-form']");
      var type = root.querySelector("[data-hk='pick-type']").value, floor = root.querySelector("[data-hk='pick-floor']").value;
      var picked = HK.rooms.filter(function(r) {
        if (type === "__common") { if (r.kind !== "common") return false; }
        else if (type && r.unit_type_id !== type) return false;
        else if (!type && r.kind === "common") return false;
        return !floor || r.floor === floor;
      });
      f.rooms.value = picked.map(function(r) { return r.name; }).join(", ");
      hkUpdateSchedPreview();
    }
  });
  root.addEventListener("change", function(e) {
    var t = e.target;
    if (t.matches("[data-hk='building']")) { rememberCommunity(t.value); HK.code = t.value; HK.date = hkToday(); HK.adding = false; hkLoad(); return; }
    if (t.matches("[data-hk='date']") && t.value) { HK.date = t.value; hkLoad(); return; }
    if (t.closest("[data-hk='sched-form']")) hkUpdateSchedPreview();
  });
  root.addEventListener("input", function(e) {
    if (e.target.closest("[data-hk='sched-form']")) hkUpdateSchedPreview();
  });
  root.addEventListener("submit", function(e) {
    e.preventDefault();
    var f = e.target.getAttribute("data-hk");
    if (f === "add-form") hkAddCleaning(e.target);
    else if (f === "sched-form") hkAddSchedules(e.target);
    else if (f === "sched-edit-form") hkSaveSchedule(e.target);
  });
}
