// Live updates: when anyone adds, checks off or changes a task (or adds a note
// or photo to one), Supabase Realtime tells every open copy of the dashboard,
// and the screens that show it redraw on their own — no refresh needed.
// Realtime uses the same access rules as everything else, so a browser only
// hears about tasks in buildings its person can see. Needs the tables turned
// on for Realtime (supabase/tasks/07-live-updates.sql).
//
// What updates live: the open task list and its detail pane (js/tasks.js),
// the Work Orders cards for buildings on StoneAnchor (js/workorders.js) and
// the Building Compliance cards (js/compliance.js). CapEx isn't live; it
// reloads every minute while its tab is open, and when you come back to the
// window.

var LIVE = {
  channel: null,
  timers: {},          // key -> pending redraw, so a burst of changes redraws once
  hiddenAt: null,      // when the window was put in the background
  capexTimer: null
};

function startLiveUpdates() {
  if (!sb || LIVE.channel) return;
  LIVE.channel = sb.channel("live-tasks")
    .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, liveTaskChanged)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "task_notes" }, liveTaskRecordAdded)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "task_photos" }, liveTaskRecordAdded)
    .subscribe();
  if (!LIVE.capexTimer) {
    LIVE.capexTimer = setInterval(function() { liveRefreshCapex(); }, 60000);
    window.addEventListener("focus", function() { liveRefreshCapex(); });
    document.addEventListener("visibilitychange", liveVisibilityChanged);
  }
}

function stopLiveUpdates() {
  if (LIVE.channel) { sb.removeChannel(LIVE.channel); LIVE.channel = null; }
  Object.keys(LIVE.timers).forEach(function(k) { clearTimeout(LIVE.timers[k]); });
  LIVE.timers = {};
}

// Runs fn once, a moment after the last call with the same key.
function liveSoon(key, delay, fn) {
  clearTimeout(LIVE.timers[key]);
  LIVE.timers[key] = setTimeout(function() { delete LIVE.timers[key]; fn(); }, delay);
}

function liveProp(code) {
  return communityProperties().find(function(p) { return p.code === code; }) || null;
}

function liveTaskChanged(payload) {
  var row = payload.new && payload.new.id ? payload.new : payload.old;
  if (!row || !row.property_code) return;
  liveRefreshList(row.list_id, row.id);
  liveRefreshCards(row.property_code);
}

// A note or photo added to a task: only matters if that task is open in the pane.
function liveTaskRecordAdded(payload) {
  var taskId = payload.new && payload.new.task_id;
  if (taskId && typeof TK !== "undefined" && TK.openId === taskId) {
    liveSoon("pane", 700, function() { liveWhenNotTyping(function() { if (TK.openId === taskId) tkLoadPaneRecords(taskId); }); });
  }
}

// The task list on screen (Work Orders → Lists, the Compliance tab's list, or
// the Staff screen), if the change was in it.
function liveRefreshList(listId, taskId) {
  if (typeof TK === "undefined" || !TK.el) return;
  if (listId !== TK.listId && !(TK.openId && TK.openId === taskId)) return;
  liveSoon("list", 700, function() {
    liveWhenNotTyping(async function() {
      if (!tkVisible()) return;  // the 60-second check and opening the screen catch it up
      await tkLoadTasks(true);
      if (TK.openId) tkLoadPaneRecords(TK.openId);
    });
  });
}

// Don't redraw a list under someone who is typing in it; try again shortly.
function liveWhenNotTyping(fn, tries) {
  tries = tries || 0;
  if (typeof tkBusy === "function" && TK.el && tkBusy() && tries < 20) {
    setTimeout(function() { liveWhenNotTyping(fn, tries + 1); }, 3000);
    return;
  }
  fn();
}

// That building's Work Orders card and Compliance card, if they're on the page.
function liveRefreshCards(code) {
  var prop = liveProp(code);
  if (!prop || !onStoneAnchor(prop)) return;
  liveSoon("cards-" + code, 1500, function() {
    if (document.getElementById("card-" + code) && typeof loadCard === "function") loadCard(prop);
    if (document.getElementById("compliance-card-" + code) && typeof loadComplianceCard === "function") loadComplianceCard(prop);
  });
}

// Every StoneAnchor building's cards — after the window was in the background
// a while, when a live message could have been missed.
function liveRefreshAllCards() {
  communityProperties().forEach(function(p) { liveRefreshCards(p.code); });
}

function liveVisibilityChanged() {
  if (document.hidden) { LIVE.hiddenAt = Date.now(); return; }
  if (LIVE.hiddenAt && Date.now() - LIVE.hiddenAt > 120000) liveRefreshAllCards();
  LIVE.hiddenAt = null;
}

// CapEx: reload while its tab is showing, unless someone is in the middle of
// something there (typing, something typed but not saved yet, an Edit box
// open, a pop-up showing).
function liveRefreshCapex() {
  var panel = document.getElementById("capexPanel");
  if (!panel || panel.offsetParent === null || document.hidden || !currentProfile) return;
  var a = document.activeElement;
  if (a && panel.contains(a) && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT")) return;
  var editing = Array.prototype.some.call(panel.querySelectorAll(".budget-edit-form, .expense-export-panel"), function(f) { return f.offsetParent !== null; });
  var popup = Array.prototype.some.call(document.querySelectorAll(".modal-overlay"), function(m) { return m.offsetParent !== null || getComputedStyle(m).display !== "none"; });
  var typed = Array.prototype.some.call(panel.querySelectorAll("input, textarea, select"), function(f) {
    if (f.tagName === "SELECT") return Array.prototype.some.call(f.options, function(o) { return o.selected !== o.defaultSelected; });
    if (f.type === "file") return f.files && f.files.length > 0;
    if (f.type === "checkbox" || f.type === "radio") return f.checked !== f.defaultChecked;
    return f.value !== f.defaultValue;
  });
  if (editing || popup || typed) return;
  loadCapexData();
}
