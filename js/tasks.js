// StoneAnchor's own work orders, PM and room turns — the replacement for Asana
// (see supabase/tasks/01-tasks.sql). Built to feel like Asana: round check
// circles, sections, a board of cards, and a detail pane that slides in from
// the right. Shown two ways from the same code:
//   - the "Lists" view of the Work Orders tab (Admins, Editors, Viewers)
//   - the Staff screen, which is all a tech or front desk login ever sees
// The database enforces the record rules (nothing deleted, times stamped by the
// database, notes permanent); this page just never offers those actions.

var TK = {
  el: null,            // the container the screen is drawn into
  mode: "office",      // "office" (dashboard tab) or "staff"
  codes: [],           // buildings this screen may show
  code: null,          // the building being shown
  lists: [],
  listId: null,
  sections: [],
  tasks: [],           // the open (and, if asked for, completed) tasks of the list
  view: "list",        // "list" or "board"
  showDone: false,
  collapsed: {},       // section id -> true when folded up
  openId: null,        // task shown in the detail pane
  search: "",
  searchResults: null,
  rooms: [],
  canWork: false,      // may add / check off / note (not Viewers)
  canSetup: false,     // may create lists (Editors and up); anyone who can work tasks may change sections
  timer: null,
  searchTimer: null
};

var TK_STAFF_KINDS = ["work_orders", "pm", "room_turns"];

// ── The two ways in ──────────────────────────────────────────────────────────

// Staff logins (techs, front desk): this screen is all they get — no dashboard
// tabs. Called from onAuthed() in js/shared.js.
function showStaffApp() {
  var codes = visibleProperties().map(function(p) { return p.code; });
  var saved = rememberedCommunity();
  var code = codes.indexOf(saved) !== -1 ? saved : codes[0];
  var picker = document.getElementById("staffBuilding");
  picker.innerHTML = visibleProperties().map(function(p) {
    return '<option value="' + escapeHtml(p.code) + '"' + (p.code === code ? " selected" : "") + '>' + escapeHtml(p.name) + '</option>';
  }).join("");
  picker.style.display = codes.length > 1 ? "" : "none";
  document.getElementById("staffBuildingName").textContent = codes.length > 1 ? "" : communityLabel(code);
  document.getElementById("staffSignedInAs").textContent = myDisplayName();
  document.getElementById("welcomeScreen").style.display = "none";
  document.getElementById("mainApp").style.display = "none";
  document.getElementById("staffApp").style.display = "block";
  document.body.classList.add("staff-mode");
  rememberCommunity(code);
  openTasks(document.getElementById("staffTasks"), "staff", codes, code);
}

function staffSwitchBuilding(code) {
  rememberCommunity(code);
  tkSwitchBuilding(code);
}

// The Work Orders tab has two views: "lists" (these screens) and "numbers"
// (the Asana numbers and charts in js/workorders.js). Remembered per browser.
// The buildings whose lists this person sees in the Work Orders tab: the ones
// switched off Asana — or every building, for the Executive and Admins (to set
// them up before they're switched).
function listBuildings() {
  var seesAll = isExecutive() || (currentProfile && currentProfile.role === "admin");
  return communityProperties().filter(function(p) { return seesAll || onStoneAnchor(p); });
}

function workOrdersView() {
  if (!listBuildings().length) return "numbers";
  var saved = null;
  try { saved = localStorage.getItem("woView"); } catch (e) {}
  return saved === "numbers" ? "numbers" : "lists";
}

function setWorkOrdersView(view) {
  try { localStorage.setItem("woView", view); } catch (e) {}
  showWorkOrdersView();
}

function showWorkOrdersView() {
  var view = workOrdersView();
  document.getElementById("woSwitch").style.display = listBuildings().length ? "" : "none";
  document.querySelectorAll("#woSwitch [data-wo-view]").forEach(function(b) {
    b.classList.toggle("active", b.getAttribute("data-wo-view") === view);
  });
  var numbers = document.getElementById("woNumbers");
  var wasHidden = numbers.style.display === "none";
  numbers.style.display = view === "numbers" ? "" : "none";
  document.getElementById("tasksPanel").style.display = view === "lists" ? "" : "none";
  if (view === "lists") openTasksTab();
  else {
    tkClosePane();
    // The chart sizes itself to the screen, so redraw it if it was drawn while hidden.
    if (wasHidden && typeof currentTrendProp !== "undefined" && currentTrendProp) loadTrendChart(currentTrendProp, currentWeeks);
  }
}

// The lists inside the Work Orders tab. Opens on the picked community, or the
// first one under "All communities" (with a building dropdown in the header).
function openTasksTab() {
  var codes = listBuildings().map(function(p) { return p.code; });
  var panel = document.getElementById("tasksPanel");
  if (!codes.length) { panel.innerHTML = '<div class="tk-empty">No buildings to show.</div>'; return; }
  var keep = TK.el === panel && codes.indexOf(TK.code) !== -1 ? TK.code : codes[0];
  openTasks(panel, "office", codes, keep);
}
var TK_KIND_ORDER = { work_orders: 0, pm: 1, room_turns: 2, compliance: 3, other: 4 };

// The standard lists a new building starts with (matching how Asana is set up today).
var TK_STARTER_LISTS = [
  { name: "Work Orders", kind: "work_orders", sections: ["Work Order Requests", "Work Orders Active", "Work Orders On Hold", "Work Orders Outsourced", "Work Order Projects"] },
  { name: "Preventative Maintenance", kind: "pm", sections: ["PM Tasks"] },
  { name: "Room Turns", kind: "room_turns", sections: ["Rooms to be Turned", "Rent Ready Rooms"] }
];

// ── Small helpers ────────────────────────────────────────────────────────────

function tkProp() {
  return ALL_PROPERTIES.find(function(p) { return p.code === TK.code; }) || {};
}

function tkTimeZone() {
  return tkProp().timeZone || "America/Denver";
}

// "Nov 5, 2026, 2:14 PM" in the building's own time zone.
function tkStamp(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleString("en-US", {
    timeZone: tkTimeZone(), month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit"
  });
}

// Today's date (YYYY-MM-DD) in the building's time zone.
function tkToday() {
  return new Date().toLocaleDateString("en-CA", { timeZone: tkTimeZone() });
}

// Asana-style due dates: Today, Tomorrow, Yesterday, weekday this week, else "Nov 7".
function tkDueLabel(d) {
  if (!d) return "";
  var diff = daysBetween(tkToday(), d);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  var date = new Date(d + "T00:00:00");
  if (diff > 1 && diff < 7) return date.toLocaleDateString("en-US", { weekday: "long" });
  var sameYear = d.slice(0, 4) === tkToday().slice(0, 4);
  return date.toLocaleDateString("en-US", sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

function tkDueClass(t) {
  if (!t.due_date || t.completed_at) return "";
  var diff = daysBetween(tkToday(), t.due_date);
  return diff < 0 ? " tk-overdue" : (diff <= 1 ? " tk-due-soon" : "");
}

// Who did something: their name — or, for records stamped before names
// existed, the part of their email before the @, with the full address on hover.
function tkWho(name) {
  if (!name) return '<span class="tk-who">Someone</span>';
  var short = name.indexOf("@") > 0 ? name.slice(0, name.indexOf("@")) : name;
  return '<span class="tk-who" title="' + escapeHtml(name) + '">' + escapeHtml(short) + '</span>';
}

function tkInitials(name) {
  var s = (name || "?").split("@")[0].replace(/[^A-Za-z0-9]+/g, " ").trim().split(" ");
  return ((s[0] || "?")[0] + (s[1] ? s[1][0] : "")).toUpperCase();
}

function tkCurrentList() {
  return TK.lists.find(function(l) { return l.id === TK.listId; }) || null;
}

function tkTask(id) {
  return TK.tasks.find(function(t) { return t.id === id; }) ||
    (TK.searchResults || []).find(function(t) { return t.id === id; }) || null;
}

function tkListName(id) {
  var l = TK.lists.find(function(x) { return x.id === id; });
  return l ? l.name : "";
}

function tkStatus(t) {
  if (t.cancelled_at) return { cls: "tk-badge-cancelled", label: "Cancelled" };
  if (t.completed_at) return { cls: "tk-badge-done", label: "Completed" };
  return { cls: "tk-badge-open", label: "Open" };
}

function tkFail(what, err) {
  console.error(err);
  alert(what + ": " + (err && err.message ? err.message : err));
}

// ── Opening the screen and loading data ──────────────────────────────────────

// el: where to draw. mode: "office" or "staff". codes: buildings it may show.
async function openTasks(el, mode, codes, code) {
  TK.el = el;
  TK.mode = mode;
  TK.codes = codes;
  TK.code = code && codes.indexOf(code) !== -1 ? code : codes[0];
  var role = currentProfile.role;
  TK.canWork = isExecutive() || role === "admin" || role === "editor" || role === "staff";
  TK.canSetup = isExecutive() || role === "admin" || role === "editor";
  TK.openId = null;
  TK.search = "";
  TK.searchResults = null;
  tkShell();
  await tkLoadBuilding();
  if (!TK.timer) {
    // Keep the list current when someone else checks something off (like Asana does).
    TK.timer = setInterval(function() { if (tkVisible() && !tkBusy()) tkLoadTasks(true); }, 60000);
    window.addEventListener("focus", function() { if (tkVisible() && !tkBusy()) tkLoadTasks(true); });
  }
}

function tkVisible() {
  return TK.el && TK.el.offsetParent !== null;
}

// Don't redraw under someone who is typing.
function tkBusy() {
  var a = document.activeElement;
  return a && TK.el.contains(a) && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT");
}

async function tkLoadBuilding() {
  var res = await sb.from("task_lists").select("*").eq("property_code", TK.code).eq("archived", false);
  if (res.error) return tkFail("Couldn't load the task lists", res.error);
  TK.lists = res.data
    .filter(function(l) { return TK.mode !== "staff" || TK_STAFF_KINDS.indexOf(l.kind) !== -1; })
    .sort(function(a, b) { return (TK_KIND_ORDER[a.kind] - TK_KIND_ORDER[b.kind]) || (a.sort_order - b.sort_order) || a.name.localeCompare(b.name); });
  if (!TK.lists.some(function(l) { return l.id === TK.listId; })) TK.listId = TK.lists.length ? TK.lists[0].id : null;
  tkLoadRooms();
  await tkLoadList();
}

async function tkLoadList() {
  TK.collapsed = {};
  TK.renamingSection = null;
  TK.addingSection = false;
  if (!TK.listId) { TK.sections = []; TK.tasks = []; tkRender(); return; }
  var res = await sb.from("task_sections").select("*").eq("list_id", TK.listId).eq("archived", false).order("sort_order").order("created_at");
  if (res.error) return tkFail("Couldn't load the sections", res.error);
  TK.sections = res.data;
  await tkLoadTasks(false);
}

async function tkLoadTasks(quiet) {
  if (!TK.listId) return;
  var q = sb.from("tasks").select("*").eq("list_id", TK.listId).is("cancelled_at", null);
  if (!TK.showDone) q = q.is("completed_at", null);
  var res = await q.order("created_at", { ascending: false }).limit(TK.showDone ? 1000 : 2000);
  if (res.error) { if (!quiet) tkFail("Couldn't load the tasks", res.error); return; }
  TK.tasks = res.data;
  tkRender();
}

async function tkLoadRooms() {
  var res = await sb.rpc("task_rooms", { p_code: TK.code });
  TK.rooms = res.error ? [] : res.data.map(function(r) { return r.room; });
  var dl = document.getElementById("tkRoomOptions");
  if (dl) dl.innerHTML = TK.rooms.map(function(r) { return '<option value="' + escapeHtml(r) + '">'; }).join("");
}

// A building with no lists yet: an Editor/Admin sets up the standard three.
async function tkCreateStarterLists() {
  var btn = TK.el.querySelector("[data-tk='setup']");
  if (btn) { btn.disabled = true; btn.textContent = "Setting up…"; }
  for (var i = 0; i < TK_STARTER_LISTS.length; i++) {
    var s = TK_STARTER_LISTS[i];
    var res = await sb.from("task_lists").insert({ property_code: TK.code, name: s.name, kind: s.kind, sort_order: i }).select().single();
    if (res.error) return tkFail("Couldn't create " + s.name, res.error);
    var rows = s.sections.map(function(name, j) { return { list_id: res.data.id, name: name, sort_order: j }; });
    var secRes = await sb.from("task_sections").insert(rows);
    if (secRes.error) return tkFail("Couldn't create the sections for " + s.name, secRes.error);
  }
  await tkLoadBuilding();
}

// ── Drawing ──────────────────────────────────────────────────────────────────

// The frame that stays put: header, body, detail pane, toast.
function tkShell() {
  TK.el.innerHTML =
    '<div class="tk">' +
      '<div class="tk-head"></div>' +
      '<div class="tk-body"></div>' +
      '<aside class="tk-pane" aria-hidden="true"></aside>' +
      '<div class="tk-toast" role="status"></div>' +
      '<datalist id="tkRoomOptions"></datalist>' +
    '</div>';
  if (!TK.el.dataset.tkWired) { tkWire(TK.el); TK.el.dataset.tkWired = "1"; }
}

function tkRender() {
  tkRenderHead();
  var body = TK.el.querySelector(".tk-body");
  if (TK.searchResults) { body.innerHTML = tkSearchHtml(); return; }
  if (!TK.lists.length) { body.innerHTML = tkEmptyBuildingHtml(); return; }
  body.innerHTML = (TK.canWork ? tkAddRowHtml(null, true) : "") + (TK.view === "board" ? tkBoardHtml() : tkListHtml());
}

function tkRenderHead() {
  var list = tkCurrentList();
  var buildingPicker = TK.mode === "office" && TK.codes.length > 1
    ? '<select class="tk-building" data-tk="building">' + TK.codes.map(function(c) {
        var p = ALL_PROPERTIES.find(function(x) { return x.code === c; }) || { name: c };
        return '<option value="' + escapeHtml(c) + '"' + (c === TK.code ? " selected" : "") + '>' + escapeHtml(p.name) + '</option>';
      }).join("") + '</select>'
    : "";
  var tabs = TK.lists.map(function(l) {
    return '<button type="button" class="tk-list-tab' + (l.id === TK.listId && !TK.searchResults ? " active" : "") + '" data-tk="list" data-id="' + l.id + '">' + escapeHtml(l.name) + '</button>';
  }).join("");
  TK.el.querySelector(".tk-head").innerHTML =
    '<div class="tk-head-top">' +
      '<div class="tk-title-wrap">' + buildingPicker +
        '<h2 class="tk-title">' + escapeHtml(TK.searchResults ? "Search results" : (list ? list.name : "Tasks")) + '</h2>' +
      '</div>' +
      '<div class="tk-search">' +
        '<span class="tk-search-icon" aria-hidden="true">&#8981;</span>' +
        '<input type="search" data-tk="search" placeholder="Search rooms, work orders, notes" value="' + escapeHtml(TK.search) + '" />' +
      '</div>' +
    '</div>' +
    '<div class="tk-head-bar">' +
      '<div class="tk-list-tabs">' + tabs + '</div>' +
      '<div class="tk-tools">' +
        '<div class="tk-view-toggle">' +
          '<button type="button" data-tk="view" data-view="list" class="' + (TK.view === "list" ? "active" : "") + '">&#9776; List</button>' +
          '<button type="button" data-tk="view" data-view="board" class="' + (TK.view === "board" ? "active" : "") + '">&#9638; Board</button>' +
        '</div>' +
        '<label class="tk-sort">Sort by <select data-tk="sortby">' +
          '<option value="newest"' + (tkSortBy() === "newest" ? " selected" : "") + '>Newest first</option>' +
          '<option value="due"' + (tkSortBy() === "due" ? " selected" : "") + '>Due date</option>' +
        '</select></label>' +
        '<label class="tk-show-done"><input type="checkbox" data-tk="showdone"' + (TK.showDone ? " checked" : "") + ' /> Show completed</label>' +
        '<button type="button" class="tk-tool-btn" data-tk="roomhistory">Room history</button>' +
      '</div>' +
    '</div>';
}

function tkEmptyBuildingHtml() {
  if (!TK.canSetup) return '<div class="tk-empty">No task lists have been set up for this building yet. Ask your administrator.</div>';
  return '<div class="tk-empty"><p>This building doesn’t have any task lists yet.</p>' +
    '<p class="tk-muted">This creates Work Orders, Preventative Maintenance and Room Turns, with the same sections used in Asana.</p>' +
    '<button type="button" class="config-btn" data-tk="setup">Set up the standard lists</button></div>';
}

// Room → Tab → work order → Enter. An empty data-section means the list's first section.
function tkAddRowHtml(sectionId, top) {
  return '<form class="tk-add' + (top ? " tk-add-top" : " tk-add-inline") + '" data-section="' + (sectionId || "") + '" autocomplete="off">' +
    '<span class="tk-add-plus" aria-hidden="true">+</span>' +
    '<input class="tk-add-room" name="room" list="tkRoomOptions" placeholder="' + (top ? "Room / location" : "Room") + '" aria-label="Room or location" />' +
    '<input class="tk-add-title" name="title" placeholder="' + (top ? tkAddWord() + "… then press Enter" : "Add task…") + '" aria-label="' + tkAddWord() + '" />' +
    '<label class="tk-add-urgent" title="Urgent"><input type="checkbox" name="urgent" /> Urgent</label>' +
    '<button type="submit" class="tk-add-btn">Add task</button>' +
    '<span class="tk-add-msg" aria-live="polite"></span>' +
  '</form>';
}

function tkAddWord() {
  var list = tkCurrentList();
  return list && list.kind === "work_orders" ? "Work order" : "Task";
}

// The "Sort by" choice: "newest" (default) or "due". Remembered per browser.
function tkSortBy() {
  var saved = null;
  try { saved = localStorage.getItem("tkSortBy"); } catch (e) {}
  return saved === "due" ? "due" : "newest";
}

function tkSetSortBy(value) {
  try { localStorage.setItem("tkSortBy", value); } catch (e) {}
  tkRender();
}

// Open first; completed ones (when shown) at the end of their section.
// "newest": newest first. A repeat keeps the place (placed_at) of the task it came from.
// "due": soonest due date first (overdue at the top), no due date at the bottom,
// newest first among ties.
function tkSortTasks(list) {
  var byDue = tkSortBy() === "due";
  return list.slice().sort(function(a, b) {
    if (!!a.completed_at !== !!b.completed_at) return a.completed_at ? 1 : -1;
    if (byDue && a.due_date !== b.due_date) {
      if (!a.due_date) return 1;
      if (!b.due_date) return -1;
      return a.due_date < b.due_date ? -1 : 1;
    }
    var pa = a.placed_at || a.created_at, pb = b.placed_at || b.created_at;
    return pa === pb ? 0 : pa < pb ? 1 : -1;
  });
}

function tkTasksIn(sectionId) {
  var firstId = TK.sections.length ? TK.sections[0].id : null;
  var known = {};
  TK.sections.forEach(function(s) { known[s.id] = true; });
  return tkSortTasks(TK.tasks.filter(function(t) {
    // A task whose section was archived shows in the first section rather than vanishing.
    var sid = t.section_id && known[t.section_id] ? t.section_id : firstId;
    return sid === sectionId;
  }));
}

function tkCircleHtml(t) {
  var done = !!t.completed_at;
  return '<button type="button" class="tk-check' + (done ? " done" : "") + '" data-tk="check" data-id="' + t.id + '"' +
    (TK.canWork ? "" : " disabled") + ' aria-label="' + (done ? "Mark incomplete" : "Mark complete") + '">' +
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 8.4l2.6 2.6L12 5.6" /></svg></button>';
}

function tkTagsHtml(t) {
  var tags = "";
  if (t.urgent) tags += '<span class="tk-tag tk-tag-urgent">Urgent</span>';
  if (t.recurrence) tags += '<span class="tk-tag tk-tag-repeat" title="Repeats">&#8635;</span>';
  return tags;
}

function tkListHtml() {
  if (!TK.sections.length) return '<div class="tk-empty">This list has no sections yet.</div>' + tkAddSectionHtml("tk-add-section-list");
  var html = '<div class="tk-table">' +
    '<div class="tk-row tk-row-head"><div class="tk-col-name">Task name</div><div class="tk-col-due">Due date</div><div class="tk-col-created">Created</div></div>';
  TK.sections.forEach(function(s) {
    var tasks = tkTasksIn(s.id);
    var folded = !!TK.collapsed[s.id];
    html += '<div class="tk-section">' +
      '<div class="tk-section-head">' +
        '<button type="button" class="tk-fold" data-tk="fold" data-id="' + s.id + '" aria-label="Fold or unfold">' +
          '<span class="tk-caret' + (folded ? " folded" : "") + '">&#9662;</span></button>' +
        tkSectionNameHtml(s, "fold") +
        '<span class="tk-count">' + tasks.length + '</span>' + tkSectionMenuBtn(s) +
      '</div>';
    if (!folded) {
      html += tasks.map(tkRowHtml).join("");
      if (TK.canWork) html += tkAddRowHtml(s.id, false);
    }
    html += '</div>';
  });
  return html + tkAddSectionHtml("tk-add-section-list") + '</div>';
}

// ── Sections (list headings / board columns): add, rename, reorder, delete ──
// Anyone who can work tasks (Staff included, not Viewers). "Delete" archives the section after moving its tasks,
// so no task or history is ever lost.

function tkSectionNameHtml(s, action) {
  if (TK.renamingSection === s.id) {
    return '<input class="tk-section-input" data-tk-section="rename" data-id="' + s.id + '" value="' + escapeHtml(s.name) + '" maxlength="80" />';
  }
  return '<span class="tk-section-name" data-tk="' + action + '" data-id="' + s.id + '"' +
    (TK.canWork ? ' title="Double-click to rename"' : "") + '>' + escapeHtml(s.name) + '</span>';
}

function tkSectionMenuBtn(s) {
  return TK.canWork ? '<button type="button" class="tk-sec-menu-btn" data-tk="secmenu" data-id="' + s.id + '" aria-label="Section options">&#8943;</button>' : "";
}

function tkAddSectionHtml(cls) {
  if (!TK.canWork) return "";
  if (TK.addingSection) {
    return '<div class="tk-add-section ' + cls + '"><input class="tk-section-input" data-tk-section="add" placeholder="Name the new section, then press Enter" maxlength="80" /></div>';
  }
  return '<div class="tk-add-section ' + cls + '"><button type="button" class="tk-add-section-btn" data-tk="addsection">+ Add section</button></div>';
}

function tkOpenSectionMenu(btn, id) {
  var wasOpen = TK.el.querySelector(".tk-menu[data-id='" + id + "']");
  tkCloseMenu();
  if (wasOpen) return;
  var i = TK.sections.findIndex(function(s) { return s.id === id; });
  var board = TK.view === "board";
  var item = function(action, label, off, cls) {
    return '<button type="button" class="tk-menu-item' + (cls || "") + '" data-tk="' + action + '" data-id="' + id + '"' + (off ? " disabled" : "") + '>' + label + '</button>';
  };
  var menu = document.createElement("div");
  menu.className = "tk-menu";
  menu.setAttribute("data-id", id);
  menu.innerHTML =
    item("secrename", "Rename section") +
    item("secup", board ? "Move left" : "Move up", i === 0) +
    item("secdown", board ? "Move right" : "Move down", i === TK.sections.length - 1) +
    item("secdelete", "Delete section…", TK.sections.length < 2, " tk-menu-danger");
  TK.el.querySelector(".tk").appendChild(menu);
  // Opens below the ⋯, or above it when there's no room at the bottom of the screen.
  var r = btn.getBoundingClientRect();
  var below = r.bottom + 4 + menu.offsetHeight <= window.innerHeight - 8;
  menu.style.top = (below ? r.bottom + 4 : Math.max(8, r.top - 4 - menu.offsetHeight)) + "px";
  menu.style.left = Math.max(8, Math.min(r.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8)) + "px";
}

function tkCloseMenu() {
  var m = TK.el && TK.el.querySelector(".tk-menu");
  if (m) m.remove();
}

function tkStartRename(id) {
  TK.renamingSection = id;
  TK.addingSection = false;
  tkRender();
  var box = TK.el.querySelector("[data-tk-section='rename']");
  if (box) { box.focus(); box.select(); }
}

function tkStartAddSection() {
  TK.addingSection = true;
  TK.renamingSection = null;
  tkRender();
  var box = TK.el.querySelector("[data-tk-section='add']");
  if (box) box.focus();
  if (box && TK.view === "board") box.scrollIntoView({ block: "nearest", inline: "end" });
}

// Enter or clicking away saves; Esc (or an empty name) leaves it as it was.
async function tkFinishSectionInput(box, save) {
  if (box.dataset.done) return;
  box.dataset.done = "1";
  var kind = box.getAttribute("data-tk-section");
  var name = box.value.trim();
  TK.renamingSection = null;
  TK.addingSection = false;
  if (save && name) {
    if (kind === "add") {
      var last = TK.sections.reduce(function(m, s) { return Math.max(m, s.sort_order); }, -1);
      var res = await sb.from("task_sections").insert({ list_id: TK.listId, name: name, sort_order: last + 1 }).select().single();
      if (res.error) return tkFail("Couldn't add the section", res.error);
      TK.sections.push(res.data);
    } else {
      var id = box.getAttribute("data-id");
      var s = TK.sections.find(function(x) { return x.id === id; });
      if (s && s.name !== name) {
        var upd = await sb.from("task_sections").update({ name: name }).eq("id", id).select().single();
        if (upd.error) return tkFail("Couldn't rename the section", upd.error);
        s.name = upd.data.name;
      }
    }
  }
  tkRender();
  if (TK.openId) tkRenderPane();
}

async function tkMoveSection(id, step) {
  var i = TK.sections.findIndex(function(s) { return s.id === id; });
  var j = i + step;
  if (i === -1 || j < 0 || j >= TK.sections.length) return;
  var moved = TK.sections.splice(i, 1)[0];
  TK.sections.splice(j, 0, moved);
  tkRender();
  // Number them 0, 1, 2… and save only the ones whose place changed.
  var saves = [];
  TK.sections.forEach(function(s, n) {
    if (s.sort_order !== n) { s.sort_order = n; saves.push(sb.from("task_sections").update({ sort_order: n }).eq("id", s.id)); }
  });
  var results = await Promise.all(saves);
  var bad = results.find(function(r) { return r.error; });
  if (bad) { tkFail("Couldn't save the new order", bad.error); tkLoadList(); }
}

// Asks where the section's tasks should go, then moves them and hides the section.
async function tkConfirmDeleteSection(id) {
  var s = TK.sections.find(function(x) { return x.id === id; });
  if (!s) return;
  var counted = await sb.from("tasks").select("id", { count: "exact", head: true }).eq("section_id", id);
  if (counted.error) return tkFail("Couldn't check the section", counted.error);
  var n = counted.count || 0;
  var others = TK.sections.filter(function(x) { return x.id !== id; });
  var modal = document.createElement("div");
  modal.className = "tk-modal";
  modal.innerHTML =
    '<div class="tk-modal-box tk-modal-small" role="dialog" aria-label="Delete section">' +
      '<div class="tk-modal-head"><h3>Delete “' + escapeHtml(s.name) + '”?</h3><button type="button" class="tk-pane-close" data-sd="close" aria-label="Close">&times;</button></div>' +
      (n
        ? '<p>This section has <b>' + n + '</b> task' + (n === 1 ? "" : "s") + ' in it (counting completed ones). They’ll move to:</p>' +
          '<select class="tk-sd-target">' + others.map(function(o) { return '<option value="' + o.id + '">' + escapeHtml(o.name) + '</option>'; }).join("") + '</select>' +
          '<p class="tk-muted">No tasks are erased — each one keeps its notes and history, and the move is recorded on it.</p>'
        : '<p>This section is empty.</p>') +
      '<div class="tk-sd-buttons"><button type="button" class="tk-danger-btn" data-sd="go">Delete section</button>' +
        '<button type="button" class="tk-pane-link" data-sd="close">Keep it</button></div>' +
    '</div>';
  TK.el.querySelector(".tk").appendChild(modal);
  modal.addEventListener("click", async function(e) {
    if (e.target === modal || e.target.closest("[data-sd='close']")) { modal.remove(); return; }
    var go = e.target.closest("[data-sd='go']");
    if (!go) return;
    go.disabled = true;
    go.textContent = "Deleting…";
    if (n) {
      var target = modal.querySelector(".tk-sd-target").value;
      var mv = await sb.from("tasks").update({ section_id: target }).eq("section_id", id);
      if (mv.error) { modal.remove(); return tkFail("Couldn't move the tasks", mv.error); }
    }
    var arch = await sb.from("task_sections").update({ archived: true }).eq("id", id);
    modal.remove();
    if (arch.error) return tkFail("Couldn't delete the section", arch.error);
    var keepOpen = TK.openId;
    await tkLoadList();
    if (keepOpen) tkRenderPane();
  });
}

function tkRowHtml(t) {
  return '<div class="tk-row tk-task' + (t.completed_at ? " is-done" : "") + (t.id === TK.openId ? " is-open" : "") + '" data-tk="open" data-id="' + t.id + '">' +
    '<div class="tk-col-name">' + tkCircleHtml(t) +
      '<span class="tk-room">' + escapeHtml(t.room) + '</span>' +
      '<span class="tk-name">' + escapeHtml(t.title || "(no description)") + '</span>' + tkTagsHtml(t) +
      (t.details ? '<span class="tk-has-details" title="Has a description">&#8801;</span>' : "") +
    '</div>' +
    '<div class="tk-col-due' + tkDueClass(t) + '">' + escapeHtml(tkDueLabel(t.due_date)) + '</div>' +
    '<div class="tk-col-created">' + escapeHtml(tkStamp(t.created_at)) + '</div>' +
  '</div>';
}

function tkBoardHtml() {
  if (!TK.sections.length) return '<div class="tk-empty">This list has no sections yet.</div>' + tkAddSectionHtml("tk-add-section-list");
  return '<div class="tk-board">' + TK.sections.map(function(s) {
    var tasks = tkTasksIn(s.id);
    return '<div class="tk-column" data-section="' + s.id + '">' +
      '<div class="tk-column-head">' + tkSectionNameHtml(s, "colname") + '<span class="tk-count">' + tasks.length + '</span>' + tkSectionMenuBtn(s) + '</div>' +
      '<div class="tk-column-cards">' + tasks.map(tkCardHtml).join("") + '</div>' +
      (TK.canWork ? tkAddRowHtml(s.id, false) : "") +
    '</div>';
  }).join("") + tkAddSectionHtml("tk-add-section-board") + '</div>';
}

function tkCardHtml(t) {
  return '<div class="tk-card' + (t.completed_at ? " is-done" : "") + (t.id === TK.openId ? " is-open" : "") + '" data-tk="open" data-id="' + t.id + '"' +
    (TK.canWork ? ' draggable="true"' : "") + '>' +
    '<div class="tk-card-top">' + tkCircleHtml(t) + '<span class="tk-name">' + escapeHtml(t.title || "(no description)") + '</span></div>' +
    '<div class="tk-card-meta"><span class="tk-room">' + escapeHtml(t.room) + '</span>' + tkTagsHtml(t) +
      (t.due_date ? '<span class="tk-card-due' + tkDueClass(t) + '">' + escapeHtml(tkDueLabel(t.due_date)) + '</span>' : "") +
    '</div></div>';
}

function tkSearchHtml() {
  var rows = TK.searchResults;
  if (!rows.length) return '<div class="tk-empty">Nothing matches “' + escapeHtml(TK.search) + '”.</div>';
  return '<div class="tk-muted tk-result-count">' + rows.length + (rows.length === 300 ? "+" : "") + ' result' + (rows.length === 1 ? "" : "s") + ' — open, completed and cancelled</div>' +
    '<div class="tk-table">' +
    '<div class="tk-row tk-row-head"><div class="tk-col-name">Task name</div><div class="tk-col-due">Status</div><div class="tk-col-created">Created</div></div>' +
    rows.map(function(t) {
      var st = tkStatus(t);
      return '<div class="tk-row tk-task' + (t.completed_at || t.cancelled_at ? " is-done" : "") + '" data-tk="open" data-id="' + t.id + '">' +
        '<div class="tk-col-name"><span class="tk-room">' + escapeHtml(t.room) + '</span><span class="tk-name">' + escapeHtml(t.title || "(no description)") + '</span>' +
          '<span class="tk-list-chip">' + escapeHtml(tkListName(t.list_id)) + '</span></div>' +
        '<div class="tk-col-due"><span class="tk-badge ' + st.cls + '">' + st.label + '</span></div>' +
        '<div class="tk-col-created">' + escapeHtml(tkStamp(t.created_at)) + '</div></div>';
    }).join("") + '</div>';
}

// ── Clicks, typing, dragging ─────────────────────────────────────────────────
// One set of listeners on the container (the content inside is redrawn often).

function tkWire(el) {
  el.addEventListener("click", function(e) {
    if (!e.target.closest(".tk-menu, [data-tk='secmenu']")) tkCloseMenu();
    var btn = e.target.closest("[data-tk]");
    if (!btn || !el.contains(btn)) return;
    var action = btn.getAttribute("data-tk");
    var id = btn.getAttribute("data-id");
    if (action === "secmenu") { tkOpenSectionMenu(btn, id); return; }
    if (action === "secrename") { tkCloseMenu(); tkStartRename(id); return; }
    if (action === "secup" || action === "secdown") { tkCloseMenu(); tkMoveSection(id, action === "secup" ? -1 : 1); return; }
    if (action === "secdelete") { tkCloseMenu(); tkConfirmDeleteSection(id); return; }
    if (action === "addsection") { tkStartAddSection(); return; }
    if (action === "colname") return;
    if (action === "check") { e.stopPropagation(); tkToggleComplete(id); return; }
    if (action === "open") { tkOpenTask(id); return; }
    if (action === "fold") { TK.collapsed[id] = !TK.collapsed[id]; tkRender(); return; }
    if (action === "view") { TK.view = btn.getAttribute("data-view"); tkRender(); return; }
    if (action === "list") { tkClearSearch(); TK.listId = id; tkClosePane(); tkLoadList(); return; }
    if (action === "setup") { tkCreateStarterLists(); return; }
    if (action === "roomhistory") { tkOpenRoomHistory(""); return; }
    if (action === "undo") { tkUndo(); return; }
    tkPaneClick(action, btn, e);
  });

  el.addEventListener("change", function(e) {
    var t = e.target;
    if (t.matches("[data-tk='showdone']")) { TK.showDone = t.checked; tkLoadTasks(false); return; }
    if (t.matches("[data-tk='building']")) { tkSwitchBuilding(t.value); return; }
    if (t.matches("[data-tk='sortby']")) { tkSetSortBy(t.value); return; }
    tkPaneChange(e);
  });

  el.addEventListener("input", function(e) {
    if (!e.target.matches("[data-tk='search']")) return;
    var q = e.target.value;
    clearTimeout(TK.searchTimer);
    TK.searchTimer = setTimeout(function() { tkRunSearch(q); }, 300);
  });

  el.addEventListener("submit", function(e) {
    if (e.target.matches(".tk-add")) { e.preventDefault(); tkAddFromRow(e.target); return; }
    tkPaneSubmit(e);
  });

  // Room box: Enter jumps to the work order (like Tab). Work order box: Enter saves (the form's submit).
  el.addEventListener("keydown", function(e) {
    if (e.key === "Enter" && e.target.matches(".tk-add-room")) {
      e.preventDefault();
      var form = e.target.closest(".tk-add");
      // Nothing typed yet: say so, rather than moving on and losing the request.
      if (!e.target.value.trim()) tkAddFromRow(form);
      else form.querySelector(".tk-add-title").focus();
    }
    // The title in the pane is one line: Enter finishes editing (and saves).
    if (e.key === "Enter" && e.target.matches(".tk-pane-title")) { e.preventDefault(); e.target.blur(); }
    if (e.target.matches("[data-tk-section]") && (e.key === "Enter" || e.key === "Escape")) {
      e.preventDefault();
      tkFinishSectionInput(e.target, e.key === "Enter");
      return;
    }
    if (e.key === "Escape") {
      tkCloseMenu();
      if (TK.el.querySelector(".tk-modal")) tkCloseRoomHistory();
      else if (TK.openId) tkClosePane();
    }
  });
  el.addEventListener("input", function(e) {
    if (e.target.matches(".tk-pane-title")) tkAutoGrow(e.target);
  });
  el.addEventListener("focusout", function(e) {
    if (e.target.matches && e.target.matches("[data-tk-section]")) tkFinishSectionInput(e.target, true);
  });
  el.addEventListener("dblclick", function(e) {
    var name = e.target.closest(".tk-section-name");
    if (name && TK.canWork) tkStartRename(name.getAttribute("data-id"));
  });

  // The ⋯ menu is pinned to the screen, so it closes rather than drift when the page scrolls.
  window.addEventListener("scroll", function() { if (TK.el === el) tkCloseMenu(); }, true);

  // Clicking anywhere outside the detail pane closes it (like Asana). Clicking
  // another task just switches the pane to that one. Anything typed in the pane
  // has already saved by then (fields save when you leave them).
  document.addEventListener("click", function(e) {
    if (!TK.openId || !TK.el || TK.el !== el || !e.target.isConnected) return;
    if (e.target.closest(".tk-pane, .tk-modal, .tk-toast, .tk-menu, [data-tk='open'], [data-tk='check']")) return;
    tkClosePane();
  });

  // Board: drag a card to another column to move it.
  el.addEventListener("dragstart", function(e) {
    var card = e.target.closest && e.target.closest(".tk-card");
    if (!card) return;
    e.dataTransfer.setData("text/plain", card.getAttribute("data-id"));
    e.dataTransfer.effectAllowed = "move";
    card.classList.add("dragging");
  });
  el.addEventListener("dragend", function(e) {
    var card = e.target.closest && e.target.closest(".tk-card");
    if (card) card.classList.remove("dragging");
    el.querySelectorAll(".tk-column.drop-target").forEach(function(c) { c.classList.remove("drop-target"); });
  });
  el.addEventListener("dragover", function(e) {
    var col = e.target.closest && e.target.closest(".tk-column");
    if (!col) return;
    e.preventDefault();
    el.querySelectorAll(".tk-column.drop-target").forEach(function(c) { if (c !== col) c.classList.remove("drop-target"); });
    col.classList.add("drop-target");
  });
  el.addEventListener("drop", function(e) {
    var col = e.target.closest && e.target.closest(".tk-column");
    if (!col) return;
    e.preventDefault();
    col.classList.remove("drop-target");
    tkMoveTask(e.dataTransfer.getData("text/plain"), col.getAttribute("data-section"));
  });
}

async function tkSwitchBuilding(code) {
  TK.code = code;
  TK.listId = null;
  tkClearSearch();
  tkClosePane();
  await tkLoadBuilding();
}

// ── Adding ───────────────────────────────────────────────────────────────────

async function tkAddFromRow(form) {
  var roomEl = form.querySelector(".tk-add-room");
  var titleEl = form.querySelector(".tk-add-title");
  var urgentEl = form.querySelector("[name='urgent']");
  var msg = form.querySelector(".tk-add-msg");
  var room = roomEl.value.trim();
  if (!room) {
    roomEl.classList.add("tk-invalid");
    msg.textContent = "Room or location required";
    msg.className = "tk-add-msg tk-add-msg-error";
    roomEl.focus();
    return;
  }
  roomEl.classList.remove("tk-invalid");
  // "office" typed where "OFFICE" already exists: use the existing spelling, so
  // the room reads the same everywhere (room history matches either way).
  var existing = TK.rooms.find(function(r) { return r.toLowerCase() === room.toLowerCase(); });
  if (existing) room = existing;
  var row = {
    property_code: TK.code, list_id: TK.listId, room: room, title: titleEl.value.trim(),
    urgent: urgentEl.checked, section_id: form.getAttribute("data-section") || null
  };
  var btn = form.querySelector(".tk-add-btn");
  btn.disabled = true;
  var res = await sb.from("tasks").insert(row).select().single();
  btn.disabled = false;
  if (res.error) { msg.textContent = "Not saved — " + res.error.message; msg.className = "tk-add-msg tk-add-msg-error"; return; }

  TK.tasks.unshift(res.data);
  if (TK.rooms.indexOf(room) === -1) tkLoadRooms();
  var wasTop = form.classList.contains("tk-add-top");
  var sectionId = form.getAttribute("data-section");
  tkRender();
  // Straight back to the Room box for the next one, with a quick "Added" flash.
  var again = wasTop ? TK.el.querySelector(".tk-add-top")
    : TK.el.querySelector(".tk-add-inline[data-section='" + sectionId + "']");
  if (again) {
    var m = again.querySelector(".tk-add-msg");
    m.textContent = "✓ Added " + room;
    m.className = "tk-add-msg tk-add-msg-ok";
    setTimeout(function() { if (m.textContent.indexOf("Added") !== -1) m.textContent = ""; }, 2500);
    again.querySelector(".tk-add-room").focus();
  }
  var added = TK.el.querySelector("[data-tk='open'][data-id='" + res.data.id + "']");
  if (added) added.classList.add("tk-flash");
}

// ── Checking off (one tap, gone, with Undo) ──────────────────────────────────

var TK_UNDO = null;   // { id, timer }

async function tkToggleComplete(id) {
  if (!TK.canWork) return;
  var t = tkTask(id) || (TK.extraTask && TK.extraTask.id === id ? TK.extraTask : null);
  if (!t) return;
  var completing = !t.completed_at;
  var res = await sb.from("tasks").update({ completed_at: completing ? new Date().toISOString() : null }).eq("id", id).select().single();
  if (res.error) return tkFail(completing ? "Couldn't check that off" : "Couldn't reopen that", res.error);
  tkReplaceTask(res.data);
  if (TK.extraTask && TK.extraTask.id === id) TK.extraTask = res.data;
  if (TK.openId === id) tkLoadPaneRecords(id);

  if (completing) {
    // Fill the circle, then let the row slide away (unless completed tasks are showing).
    TK.el.querySelectorAll("[data-id='" + id + "'].tk-task, [data-id='" + id + "'].tk-card").forEach(function(r) {
      r.classList.add("is-done", "tk-completing");
      var c = r.querySelector(".tk-check"); if (c) c.classList.add("done");
    });
    // A repeating task: the database just made the next one. Like Asana, it
    // comes straight back in the same spot with its new due date.
    var nextCopy = t.recurrence
      ? sb.from("tasks").select("*").eq("previous_task_id", id).is("cancelled_at", null).order("created_at", { ascending: false }).limit(1)
      : null;
    setTimeout(async function() {
      var next = null;
      if (nextCopy) { var n = await nextCopy; next = n.data && n.data[0]; }
      if (next && next.list_id === TK.listId) {
        var at = TK.tasks.findIndex(function(x) { return x.id === id; });
        if (TK.showDone || at === -1) TK.tasks.unshift(next);
        else TK.tasks.splice(at, 1, next);
      } else if (!TK.showDone) {
        TK.tasks = TK.tasks.filter(function(x) { return x.id !== id; });
      }
      tkRender();
      if (next) {
        TK.el.querySelectorAll("[data-id='" + next.id + "']").forEach(function(r) {
          if (r.matches(".tk-task, .tk-card")) r.classList.add("tk-flash", "tk-came-back");
        });
        // The pane follows the task on to its next round.
        if (TK.openId === id) tkOpenTask(next.id);
      } else if (TK.openId === id) tkRenderPane();
      tkShowUndo(id, t, next);
    }, 450);
  } else {
    if (TK.tasks.every(function(x) { return x.id !== id; }) && res.data.list_id === TK.listId) TK.tasks.unshift(res.data);
    tkRender();
    if (TK.openId === id) tkRenderPane();
    if (t.recurrence) tkLoadTasks(true);
  }
}

function tkShowUndo(id, t, next) {
  var toast = TK.el.querySelector(".tk-toast");
  if (TK_UNDO) clearTimeout(TK_UNDO.timer);
  toast.innerHTML = '<span>✓ <b>' + escapeHtml(t.room) + '</b> ' + escapeHtml(t.title || "") + ' marked complete' +
      (next && next.due_date ? ' — next one due ' + escapeHtml(tkDueLabel(next.due_date)) : "") + '</span>' +
    '<button type="button" data-tk="undo">Undo</button>';
  toast.classList.add("show");
  TK_UNDO = { id: id, nextId: next ? next.id : null, timer: setTimeout(tkHideUndo, 6000) };
}

function tkHideUndo() {
  var toast = TK.el && TK.el.querySelector(".tk-toast");
  if (toast) toast.classList.remove("show");
  TK_UNDO = null;
}

async function tkUndo() {
  if (!TK_UNDO) return;
  var id = TK_UNDO.id, nextId = TK_UNDO.nextId;
  tkHideUndo();
  var res = await sb.from("tasks").update({ completed_at: null }).eq("id", id).select().single();
  if (res.error) return tkFail("Couldn't undo", res.error);
  await tkLoadTasks(true);
  // The repeat it made is cancelled again, so the pane goes back to the original.
  if (nextId && TK.openId === nextId) tkOpenTask(id);
  else if (TK.openId === id) tkRenderPane();
}

function tkReplaceTask(row) {
  TK.tasks = TK.tasks.map(function(x) { return x.id === row.id ? row : x; });
  if (TK.searchResults) TK.searchResults = TK.searchResults.map(function(x) { return x.id === row.id ? row : x; });
}

// ── Moving between sections ──────────────────────────────────────────────────

async function tkMoveTask(id, sectionId) {
  var t = tkTask(id);
  if (!t || !sectionId || t.section_id === sectionId) return;
  var res = await sb.from("tasks").update({ section_id: sectionId }).eq("id", id).select().single();
  if (res.error) return tkFail("Couldn't move that task", res.error);
  tkReplaceTask(res.data);
  tkRender();
  if (TK.openId === id) tkRenderPane();
}

// ── Search ───────────────────────────────────────────────────────────────────

async function tkRunSearch(q) {
  TK.search = q;
  if (!q.trim()) { tkClearSearch(); tkRender(); return; }
  var res = await sb.rpc("search_tasks", { p_codes: [TK.code], q: q });
  if (res.error) return tkFail("Search failed", res.error);
  if (TK.search !== q) return;   // a newer search is on its way
  // Staff only search their own kinds of list (the database already hides the rest).
  TK.searchResults = res.data;
  tkRender();
  var box = TK.el.querySelector("[data-tk='search']");
  if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
}

function tkClearSearch() {
  TK.search = "";
  TK.searchResults = null;
}

// ── Task detail pane ─────────────────────────────────────────────────────────

var TK_PANE = { notes: [], photos: [], events: [], showHistory: false, cancelling: false };
var TK_NOTE_DRAFTS = {};   // task id -> a note typed but not yet added

// Keep what's in the note box, so closing or redrawing the pane never loses it.
function tkKeepNoteDraft() {
  var pane = TK.el && TK.el.querySelector(".tk-pane");
  var box = pane && pane.querySelector(".tk-note-form textarea");
  if (box && pane.dataset.taskId) TK_NOTE_DRAFTS[pane.dataset.taskId] = box.value;
}

var TK_REPEATS = [
  { key: "", label: "Doesn’t repeat" },
  { key: "daily", label: "Every day" },
  { key: "weekly", label: "Every week" },
  { key: "biweekly", label: "Every 2 weeks" },
  { key: "monthly", label: "Every month" },
  { key: "quarterly", label: "Every 3 months" },
  { key: "yearly", label: "Every year" }
];

function tkRepeatKey(rule) {
  if (!rule) return "";
  var n = rule.interval || 1;
  if (rule.freq === "daily" && n === 1) return "daily";
  if (rule.freq === "weekly" && n === 1 && (rule.days || []).length <= 1) return "weekly";
  if (rule.freq === "weekly" && n === 2 && (rule.days || []).length <= 1) return "biweekly";
  if (rule.freq === "monthly" && rule.weekday) return "custom";
  if (rule.freq === "monthly" && n === 1) return "monthly";
  if (rule.freq === "monthly" && n === 3) return "quarterly";
  if (rule.freq === "yearly" && n === 1) return "yearly";
  return "custom";
}

// Words for a repeat that isn't one of the simple choices (most came from Asana):
// "Every week on Wed, Fri", "Monthly on the last Fri", "Every 6 months".
function tkRepeatLabel(rule) {
  var dayNames = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  var n = rule.interval || 1;
  if (rule.freq === "daily") return n === 1 ? "Every day" : "Every " + n + " days";
  if (rule.freq === "weekly") {
    return (n === 1 ? "Every week" : "Every " + n + " weeks") +
      ((rule.days || []).length ? " on " + rule.days.map(function(d) { return dayNames[d]; }).join(", ") : "");
  }
  if (rule.freq === "monthly" && rule.weekday) {
    var nth = { "-1": "last", "1": "1st", "2": "2nd", "3": "3rd", "4": "4th" }[String(rule.week)] || "1st";
    return "Monthly on the " + nth + " " + dayNames[rule.weekday];
  }
  if (rule.freq === "monthly") return "Every " + n + " months";
  return n === 1 ? "Every year" : "Every " + n + " years";
}

function tkRepeatRule(key, dueDate) {
  // Weekly repeats land on the due date's weekday (ISO: 1 = Monday … 7 = Sunday).
  var dow = new Date((dueDate || tkToday()) + "T00:00:00").getDay() || 7;
  return {
    daily: { freq: "daily", interval: 1 },
    weekly: { freq: "weekly", interval: 1, days: [dow] },
    biweekly: { freq: "weekly", interval: 2, days: [dow] },
    monthly: { freq: "monthly", interval: 1 },
    quarterly: { freq: "monthly", interval: 3 },
    yearly: { freq: "yearly", interval: 1 }
  }[key] || null;
}

async function tkOpenTask(id) {
  TK.openId = id;
  TK_PANE = { notes: [], photos: [], events: [], showHistory: TK_PANE.showHistory, cancelling: false };
  TK.el.querySelectorAll(".is-open").forEach(function(r) { r.classList.remove("is-open"); });
  TK.el.querySelectorAll("[data-tk='open'][data-id='" + id + "']").forEach(function(r) { r.classList.add("is-open"); });
  tkRenderPane();
  var pane = TK.el.querySelector(".tk-pane");
  // On the test copy, start below the orange TEST banner so it can't cover the pane's buttons.
  var banner = document.querySelector(".test-db-banner");
  pane.style.top = banner ? banner.offsetHeight + "px" : "";
  pane.classList.add("open");
  pane.setAttribute("aria-hidden", "false");
  document.body.classList.add("tk-pane-open");
  await tkLoadPaneRecords(id);
}

function tkClosePane() {
  TK.openId = null;
  var pane = TK.el && TK.el.querySelector(".tk-pane");
  if (!pane) return;
  tkKeepNoteDraft();
  pane.classList.remove("open");
  pane.setAttribute("aria-hidden", "true");
  document.body.classList.remove("tk-pane-open");
  TK.el.querySelectorAll(".is-open").forEach(function(r) { r.classList.remove("is-open"); });
}

async function tkLoadPaneRecords(id) {
  var results = await Promise.all([
    sb.from("task_notes").select("*").eq("task_id", id).order("created_at"),
    sb.from("task_photos").select("*").eq("task_id", id).order("created_at"),
    sb.from("task_events").select("*").eq("task_id", id).order("created_at")
  ]);
  if (TK.openId !== id) return;
  TK_PANE.notes = results[0].data || [];
  TK_PANE.photos = results[1].data || [];
  TK_PANE.events = results[2].data || [];
  if (TK_PANE.photos.length) {
    var signed = await sb.storage.from("task-files").createSignedUrls(TK_PANE.photos.map(function(p) { return p.storage_path; }), 3600);
    (signed.data || []).forEach(function(s, i) { if (TK_PANE.photos[i]) TK_PANE.photos[i].url = s.signedUrl; });
  }
  if (TK.openId === id) tkRenderPane();
}

// A task the pane is showing that isn't in the current list (e.g. from search or room history).
async function tkEnsureTask(id) {
  if (tkTask(id)) return tkTask(id);
  var res = await sb.from("tasks").select("*").eq("id", id).single();
  if (res.error) return null;
  TK.extraTask = res.data;
  return res.data;
}

function tkPaneTask() {
  return tkTask(TK.openId) || (TK.extraTask && TK.extraTask.id === TK.openId ? TK.extraTask : null);
}

function tkRenderPane() {
  var pane = TK.el.querySelector(".tk-pane");
  var t = tkPaneTask();
  tkKeepNoteDraft();
  if (!t) {
    pane.dataset.taskId = "";
    pane.innerHTML = '<div class="tk-pane-loading">Loading…</div>';
    tkEnsureTask(TK.openId).then(function(row) { if (row) tkRenderPane(); });
    return;
  }
  var dis = TK.canWork ? "" : " disabled";
  var done = !!t.completed_at;
  var cancelled = !!t.cancelled_at;
  var sectionOpts = TK.sections.length && t.list_id === TK.listId
    ? TK.sections.map(function(s) { return '<option value="' + s.id + '"' + (s.id === t.section_id ? " selected" : "") + '>' + escapeHtml(s.name) + '</option>'; }).join("")
    : '<option>' + escapeHtml(tkListName(t.list_id)) + '</option>';
  var repeatKey = tkRepeatKey(t.recurrence);
  var repeatOpts = TK_REPEATS.map(function(r) {
    return '<option value="' + r.key + '"' + (r.key === repeatKey ? " selected" : "") + '>' + r.label + '</option>';
  }).join("") + (repeatKey === "custom" ? '<option value="custom" selected>' + escapeHtml(tkRepeatLabel(t.recurrence)) + '</option>' : "");

  pane.innerHTML =
    '<div class="tk-pane-bar">' +
      (cancelled
        ? '<span class="tk-badge tk-badge-cancelled">Cancelled</span>'
        : '<button type="button" class="tk-complete-btn' + (done ? " done" : "") + '" data-tk="check" data-id="' + t.id + '"' + dis + '>' +
            '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 8.4l2.6 2.6L12 5.6" /></svg>' + (done ? "Completed" : "Mark complete") + '</button>') +
      '<span class="tk-pane-spacer"></span>' +
      (TK.canWork && !cancelled && !done ? '<button type="button" class="tk-pane-link" data-tk="cancel-start">Cancel task…</button>' : "") +
      (TK.canWork && cancelled ? '<button type="button" class="tk-pane-link" data-tk="restore">Restore task</button>' : "") +
      '<button type="button" class="tk-pane-close" data-tk="close" aria-label="Close">&times;</button>' +
    '</div>' +
    (TK_PANE.cancelling
      ? '<form class="tk-cancel-form" data-form="cancel">' +
          '<label>Why is this being cancelled? It stays on record.</label>' +
          '<input name="reason" placeholder="e.g. Entered twice" required />' +
          '<button type="submit" class="tk-danger-btn">Cancel task</button>' +
          '<button type="button" class="tk-pane-link" data-tk="cancel-stop">Never mind</button></form>'
      : "") +
    (cancelled ? '<div class="tk-cancel-note">Cancelled by ' + tkWho(t.cancelled_by_name) + ' · ' + escapeHtml(tkStamp(t.cancelled_at)) +
      '<br>Reason: ' + escapeHtml(t.cancel_reason || "") + '</div>' : "") +
    '<div class="tk-pane-scroll">' +
      '<textarea class="tk-pane-title" data-field="title" rows="1" placeholder="Work order"' + dis + '>' + escapeHtml(t.title) + '</textarea>' +
      '<div class="tk-fields">' +
        '<label>Room / location</label><input data-field="room" value="' + escapeHtml(t.room) + '" list="tkRoomOptions"' + dis + ' />' +
        '<label>Due date</label><input type="date" data-field="due_date" value="' + escapeHtml(t.due_date || "") + '"' + dis + ' />' +
        '<label>Section</label><select data-field="section_id"' + (t.list_id === TK.listId ? dis : " disabled") + '>' + sectionOpts + '</select>' +
        '<label>Urgent</label><label class="tk-switch"><input type="checkbox" data-field="urgent"' + (t.urgent ? " checked" : "") + dis + ' /> Urgent</label>' +
        '<label>Repeats</label><select data-field="recurrence"' + dis + '>' + repeatOpts + '</select>' +
        '<label>Created</label><div class="tk-field-text">' + tkWho(t.created_by_name) + ' · ' + escapeHtml(tkStamp(t.created_at)) + '</div>' +
        (done ? '<label>Completed</label><div class="tk-field-text">' + tkWho(t.completed_by_name) + ' · ' + escapeHtml(tkStamp(t.completed_at)) + '</div>' : "") +
        // Imported tasks: photos and attachments stayed in Asana.
        (t.asana_gid ? '<label>From Asana</label><div class="tk-field-text"><a href="https://app.asana.com/0/0/' + encodeURIComponent(t.asana_gid) + '" target="_blank" rel="noopener">Open the original (photos and attachments)</a></div>' : "") +
      '</div>' +
      '<label class="tk-pane-label">Description</label>' +
      '<textarea class="tk-pane-details" data-field="details" rows="4" placeholder="' + (TK.canWork ? "Add more detail to this work order…" : "") + '"' + dis + '>' + escapeHtml(t.details) + '</textarea>' +
      tkPhotosHtml(t) +
      tkTimelineHtml(t) +
    '</div>' +
    (TK.canWork
      ? '<form class="tk-note-form" data-form="note">' +
          '<div class="tk-avatar">' + escapeHtml(tkInitials(myDisplayName())) + '</div>' +
          '<textarea name="body" rows="2" placeholder="Add a note… (notes are permanent and time-stamped)">' + escapeHtml(TK_NOTE_DRAFTS[t.id] || "") + '</textarea>' +
          '<button type="submit" class="tk-note-btn">Add note</button></form>'
      : "");
  pane.dataset.taskId = t.id;
  tkAutoGrow(pane.querySelector(".tk-pane-title"));
}

function tkPhotosHtml(t) {
  var thumbs = TK_PANE.photos.map(function(p) {
    return '<a href="#" class="tk-photo" data-tk="photo" data-path="' + escapeHtml(p.storage_path) + '" title="' +
      escapeHtml(p.file_name + " — " + (p.uploaded_by_name || "") + ", " + tkStamp(p.created_at)) + '">' +
      (p.url ? '<img src="' + escapeHtml(p.url) + '" alt="' + escapeHtml(p.file_name) + '" />' : '<span>' + escapeHtml(p.file_name) + '</span>') + '</a>';
  }).join("");
  return '<label class="tk-pane-label">Photos</label><div class="tk-photos">' + thumbs +
    (TK.canWork ? '<label class="tk-photo tk-photo-add" title="Add a photo">+<input type="file" accept="image/*" data-tk-photo="' + t.id + '" hidden /></label>' : "") +
    (!thumbs && !TK.canWork ? '<span class="tk-muted">None</span>' : "") + '</div>';
}

var TK_EVENT_WORDS = {
  created: "created this task", completed: "marked this complete", reopened: "marked this incomplete",
  cancelled: "cancelled this task", restored: "restored this task", moved: "moved this task", edited: "changed", photo: "added a photo"
};

// Notes always show; the rest of the history (moves, edits) behind "Show all history", like Asana.
function tkTimelineHtml(t) {
  var items = TK_PANE.notes.map(function(n) { return { at: n.created_at, note: n }; });
  TK_PANE.events.forEach(function(ev) {
    var key = ev.event_type === "created" || ev.event_type === "completed" || ev.event_type === "cancelled";
    if (key || TK_PANE.showHistory) items.push({ at: ev.created_at, ev: ev });
  });
  items.sort(function(a, b) { return a.at < b.at ? -1 : 1; });
  var hidden = TK_PANE.events.length - items.filter(function(i) { return i.ev; }).length;
  var html = '<div class="tk-timeline-head"><span class="tk-pane-label">Notes &amp; history</span>' +
    (TK_PANE.events.length > 0
      ? '<button type="button" class="tk-pane-link" data-tk="history">' + (TK_PANE.showHistory ? "Hide extra history" : "Show all history" + (hidden ? " (" + hidden + " more)" : "")) + '</button>'
      : "") + '</div><div class="tk-timeline">';
  html += items.map(function(i) {
    if (i.note) {
      return '<div class="tk-note"><div class="tk-avatar">' + escapeHtml(tkInitials(i.note.author_name)) + '</div><div class="tk-note-body">' +
        '<div class="tk-note-meta">' + tkWho(i.note.author_name) + ' <span>' + escapeHtml(tkStamp(i.note.created_at)) + '</span></div>' +
        '<div class="tk-note-text">' + escapeHtml(i.note.body) + '</div></div></div>';
    }
    var ev = i.ev;
    return '<div class="tk-event">' + tkWho(ev.actor_name) + ' ' + escapeHtml(TK_EVENT_WORDS[ev.event_type] || ev.event_type) +
      (ev.detail ? ' <span class="tk-event-detail">' + escapeHtml(ev.detail) + '</span>' : "") +
      ' · <span>' + escapeHtml(tkStamp(ev.created_at)) + '</span></div>';
  }).join("");
  return html + (items.length ? "" : '<div class="tk-muted">Nothing yet.</div>') + '</div>';
}

function tkAutoGrow(ta) {
  if (!ta) return;
  ta.style.height = "auto";
  ta.style.height = ta.scrollHeight + "px";
}

function tkPaneClick(action, btn, e) {
  if (action === "close") { tkClosePane(); return; }
  if (action === "history") { TK_PANE.showHistory = !TK_PANE.showHistory; tkRenderPane(); return; }
  if (action === "cancel-start") { TK_PANE.cancelling = true; tkRenderPane(); TK.el.querySelector(".tk-cancel-form input").focus(); return; }
  if (action === "cancel-stop") { TK_PANE.cancelling = false; tkRenderPane(); return; }
  if (action === "restore") { tkSaveField(TK.openId, { cancelled_at: null }); return; }
  if (action === "photo") { viewStoredFile(e, btn, "task-files"); return; }
}

// Fields save as soon as they change (like Asana) — the history records each change.
function tkPaneChange(e) {
  var el = e.target;
  if (el.hasAttribute("data-tk-photo")) { tkUploadPhoto(el.getAttribute("data-tk-photo"), el); return; }
  var field = el.getAttribute("data-field");
  if (!field || !TK.openId || !el.closest(".tk-pane")) return;
  var t = tkPaneTask();
  var change = {};
  if (field === "urgent") change.urgent = el.checked;
  else if (field === "due_date") change.due_date = el.value || null;
  else if (field === "recurrence") {
    if (el.value === "custom") return;
    change.recurrence = tkRepeatRule(el.value, t.due_date);
  }
  else if (field === "room") {
    var room = el.value.trim();
    if (!room) { alert("A room or location is required."); el.value = t.room; return; }
    change.room = room;
  }
  else change[field] = el.value.trim();
  if (field !== "urgent" && field !== "recurrence" && (change[field] || "") === (t[field] || "")) return;
  tkSaveField(t.id, change);
}

async function tkSaveField(id, change) {
  var res = await sb.from("tasks").update(change).eq("id", id).select().single();
  if (res.error) { tkFail("Couldn't save that change", res.error); tkRenderPane(); return; }
  tkReplaceTask(res.data);
  if (TK.extraTask && TK.extraTask.id === id) TK.extraTask = res.data;
  if ("cancelled_at" in change && !res.data.cancelled_at && res.data.list_id === TK.listId && !tkTask(id)) TK.tasks.unshift(res.data);
  if (res.data.cancelled_at) TK.tasks = TK.tasks.filter(function(x) { return x.id !== id; });
  TK_PANE.cancelling = false;
  tkRender();
  await tkLoadPaneRecords(id);
}

function tkPaneSubmit(e) {
  var form = e.target;
  var kind = form.getAttribute("data-form");
  if (!kind) return;
  e.preventDefault();
  if (kind === "note") tkAddNote(form);
  if (kind === "cancel") {
    var reason = form.querySelector("[name='reason']").value.trim();
    if (!reason) return;
    tkSaveField(TK.openId, { cancelled_at: new Date().toISOString(), cancel_reason: reason });
  }
}

async function tkAddNote(form) {
  var box = form.querySelector("[name='body']");
  var body = box.value.trim();
  if (!body) return;
  var btn = form.querySelector(".tk-note-btn");
  btn.disabled = true;
  var res = await sb.from("task_notes").insert({ task_id: TK.openId, body: body });
  btn.disabled = false;
  if (res.error) return tkFail("Couldn't add the note", res.error);
  box.value = "";
  delete TK_NOTE_DRAFTS[TK.openId];
  await tkLoadPaneRecords(TK.openId);
  var scroll = TK.el.querySelector(".tk-pane-scroll");
  if (scroll) scroll.scrollTop = scroll.scrollHeight;
}

async function tkUploadPhoto(taskId, input) {
  var file = input.files[0];
  if (!file) return;
  var path = taskId + "/" + Date.now() + "-" + safeStorageName(file.name);
  var up = await sb.storage.from("task-files").upload(path, file);
  if (up.error) return tkFail("Couldn't upload the photo", up.error);
  var res = await sb.from("task_photos").insert({ task_id: taskId, storage_path: path, file_name: file.name });
  if (res.error) return tkFail("The photo uploaded but couldn't be attached", res.error);
  await tkLoadPaneRecords(taskId);
}

// ── Room history (for rent increases and state inspections) ─────────────────

var TK_RH = { room: "", from: "", to: "", rows: [], notes: {} };

function tkOpenRoomHistory(room) {
  TK_RH = { room: room || "", from: "", to: "", rows: [], notes: {} };
  var modal = document.createElement("div");
  modal.className = "tk-modal";
  modal.innerHTML =
    '<div class="tk-modal-box" role="dialog" aria-label="Room history">' +
      '<div class="tk-modal-head"><h3>Room history</h3><button type="button" class="tk-pane-close" data-rh="close" aria-label="Close">&times;</button></div>' +
      '<form class="tk-rh-form" autocomplete="off">' +
        '<label>Room / location<input name="room" list="tkRoomOptions" value="' + escapeHtml(TK_RH.room) + '" placeholder="e.g. 108" required /></label>' +
        '<label>From<input type="date" name="from" /></label>' +
        '<label>To<input type="date" name="to" /></label>' +
        '<button type="submit" class="config-btn">Look up</button>' +
      '</form>' +
      '<div class="tk-rh-results tk-muted">Every work order, PM and room turn ever logged for one room — open, completed and cancelled. Leave the dates empty for all time, or set “From” to a move-in date.</div>' +
    '</div>';
  TK.el.querySelector(".tk").appendChild(modal);
  modal.addEventListener("click", function(e) {
    if (e.target === modal || e.target.closest("[data-rh='close']")) { tkCloseRoomHistory(); return; }
    var open = e.target.closest("[data-rh='open']");
    if (open) { var id = open.getAttribute("data-id"); tkCloseRoomHistory(); TK.extraTask = TK_RH.rows.find(function(r) { return r.id === id; }); tkOpenTask(id); return; }
    if (e.target.closest("[data-rh='csv']")) tkRoomHistoryCsv();
    if (e.target.closest("[data-rh='pdf']")) tkRoomHistoryPdf();
  });
  modal.querySelector("form").addEventListener("submit", function(e) { e.preventDefault(); tkRunRoomHistory(e.target); });
  modal.querySelector("[name='room']").focus();
  if (room) tkRunRoomHistory(modal.querySelector("form"));
}

function tkCloseRoomHistory() {
  var m = TK.el.querySelector(".tk-modal");
  if (m) m.remove();
}

async function tkRunRoomHistory(form) {
  TK_RH.room = form.room.value.trim();
  TK_RH.from = form.from.value;
  TK_RH.to = form.to.value;
  if (!TK_RH.room) return;
  var out = TK.el.querySelector(".tk-rh-results");
  out.className = "tk-rh-results tk-muted";
  out.textContent = "Looking up…";
  // Same room, ignoring upper/lower case ("office" = "OFFICE"). ilike with the
  // wildcards escaped is an exact, case-blind match.
  var exact = TK_RH.room.replace(/[\\%_]/g, function(c) { return "\\" + c; });
  var q = sb.from("tasks").select("*").eq("property_code", TK.code).ilike("room", exact);
  // Dates are the building's calendar days; the database stores UTC times.
  if (TK_RH.from) q = q.gte("created_at", tkDayStartUtc(TK_RH.from));
  if (TK_RH.to) q = q.lt("created_at", tkDayStartUtc(tkNextDay(TK_RH.to)));
  var res = await q.order("created_at", { ascending: false }).limit(2000);
  if (res.error) { out.textContent = "Couldn't look that up: " + res.error.message; return; }
  TK_RH.rows = res.data;
  TK_RH.notes = {};
  if (res.data.length) {
    var ids = res.data.map(function(r) { return r.id; });
    var notes = await sb.from("task_notes").select("task_id, body, author_name, created_at").in("task_id", ids).order("created_at");
    (notes.data || []).forEach(function(n) { (TK_RH.notes[n.task_id] = TK_RH.notes[n.task_id] || []).push(n); });
  }
  tkRenderRoomHistory();
}

function tkNextDay(d) {
  var x = new Date(d + "T12:00:00Z");
  x.setUTCDate(x.getUTCDate() + 1);
  return x.toISOString().slice(0, 10);
}

// Midnight at the start of a building-calendar day, as a UTC timestamp.
function tkDayStartUtc(d) {
  var guess = new Date(d + "T00:00:00Z");
  var shown = new Date(guess.toLocaleString("en-US", { timeZone: tkTimeZone() }));
  var asUtc = new Date(guess.toLocaleString("en-US", { timeZone: "UTC" }));
  return new Date(guess.getTime() + (asUtc - shown)).toISOString();
}

function tkRoomHistoryRange() {
  if (TK_RH.from && TK_RH.to) return formatDateOnly(TK_RH.from) + " – " + formatDateOnly(TK_RH.to);
  if (TK_RH.from) return "Since " + formatDateOnly(TK_RH.from);
  if (TK_RH.to) return "Through " + formatDateOnly(TK_RH.to);
  return "All time";
}

function tkRenderRoomHistory() {
  var out = TK.el.querySelector(".tk-rh-results");
  if (!out) return;
  var rows = TK_RH.rows;
  var live = rows.filter(function(r) { return !r.cancelled_at; }).length;
  out.className = "tk-rh-results";
  if (!rows.length) { out.innerHTML = '<p class="tk-muted">No work orders found for “' + escapeHtml(TK_RH.room) + '” (' + tkRoomHistoryRange() + ').</p>'; return; }
  out.innerHTML =
    '<div class="tk-rh-summary"><div><span class="tk-rh-count">' + live + '</span> request' + (live === 1 ? "" : "s") +
      ' for <b>' + escapeHtml(TK_RH.room) + '</b> · ' + escapeHtml(tkRoomHistoryRange()) +
      (rows.length > live ? ' <span class="tk-muted">(plus ' + (rows.length - live) + ' cancelled)</span>' : "") + '</div>' +
      '<div class="tk-rh-downloads"><button type="button" class="tk-tool-btn" data-rh="csv">Download CSV</button>' +
      '<button type="button" class="tk-tool-btn" data-rh="pdf">Download PDF</button></div></div>' +
    '<div class="tk-table tk-rh-table">' +
      '<div class="tk-row tk-row-head"><div class="tk-col-name">Work order</div><div class="tk-col-due">Status</div><div class="tk-col-created">Created</div></div>' +
      rows.map(function(t) {
        var st = tkStatus(t);
        var n = (TK_RH.notes[t.id] || []).length;
        return '<div class="tk-row tk-task" data-rh="open" data-id="' + t.id + '">' +
          '<div class="tk-col-name"><span class="tk-name">' + escapeHtml(t.title || "(no description)") + '</span>' +
            '<span class="tk-list-chip">' + escapeHtml(tkListName(t.list_id)) + '</span>' +
            (n ? '<span class="tk-muted tk-note-count">' + n + ' note' + (n === 1 ? "" : "s") + '</span>' : "") + '</div>' +
          '<div class="tk-col-due"><span class="tk-badge ' + st.cls + '">' + st.label + '</span></div>' +
          '<div class="tk-col-created">' + escapeHtml(tkStamp(t.created_at)) + '</div></div>';
      }).join("") +
    '</div>';
}

function tkRoomHistoryLines() {
  return TK_RH.rows.map(function(t) {
    var notes = (TK_RH.notes[t.id] || []).map(function(n) {
      return tkStamp(n.created_at) + " (" + (n.author_name || "") + "): " + n.body;
    }).join("\n");
    return {
      created: tkStamp(t.created_at), createdBy: t.created_by_name || "",
      list: tkListName(t.list_id), workOrder: t.title, details: t.details,
      status: tkStatus(t).label,
      closed: t.cancelled_at ? tkStamp(t.cancelled_at) + " — " + (t.cancel_reason || "") : tkStamp(t.completed_at),
      closedBy: t.cancelled_at ? (t.cancelled_by_name || "") : (t.completed_by_name || ""),
      notes: notes
    };
  });
}

function tkRoomHistoryFileName(ext) {
  return "room-history_" + TK.code + "_" + TK_RH.room.replace(/[^A-Za-z0-9]+/g, "-") + "_" + tkToday() + "." + ext;
}

function tkRoomHistoryCsv() {
  var head = ["Created", "Created by", "List", "Work order", "Description", "Status", "Completed / cancelled", "By", "Notes"];
  var lines = [head.map(csvField).join(",")].concat(tkRoomHistoryLines().map(function(r) {
    return [r.created, r.createdBy, r.list, r.workOrder, r.details, r.status, r.closed, r.closedBy, r.notes].map(csvField).join(",");
  }));
  var blob = new Blob([lines.join("\r\n")], { type: "text/csv" });
  var a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = tkRoomHistoryFileName("csv");
  a.click();
  setTimeout(function() { URL.revokeObjectURL(a.href); }, 1000);
}

function tkRoomHistoryPdf() {
  var doc = new window.jspdf.jsPDF({ orientation: "landscape", unit: "pt", format: "letter" });
  var live = TK_RH.rows.filter(function(r) { return !r.cancelled_at; }).length;
  doc.setFontSize(16);
  doc.text(tkProp().name + " — Room / location " + TK_RH.room, 40, 44);
  doc.setFontSize(10);
  doc.text(live + " request" + (live === 1 ? "" : "s") + " · " + tkRoomHistoryRange() + " · Printed " + tkStamp(new Date().toISOString()) +
    " (" + tkTimeZone() + ")", 40, 62);
  doc.autoTable({
    startY: 76,
    head: [["Created", "Work order", "Status", "Completed / cancelled", "Notes"]],
    body: tkRoomHistoryLines().map(function(r) {
      return [r.created + "\n" + r.createdBy, r.workOrder + (r.details ? "\n" + r.details : "") + "\n(" + r.list + ")", r.status,
        r.closed + (r.closedBy ? "\n" + r.closedBy : ""), r.notes];
    }),
    styles: { fontSize: 8, cellPadding: 4, valign: "top" },
    headStyles: { fillColor: [148, 73, 47] },
    columnStyles: { 0: { cellWidth: 110 }, 1: { cellWidth: 200 }, 2: { cellWidth: 60 }, 3: { cellWidth: 120 } }
  });
  doc.save(tkRoomHistoryFileName("pdf"));
}
