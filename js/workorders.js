// Work Orders tab: pulls open/completed task counts and room-turn data
// from Asana (via the asana-proxy Supabase Edge Function) for each facility
// card — or, for a building switched off Asana, from StoneAnchor's own task
// lists (getStoneAnchorCardData). The per-property trend chart and weekly history table below it read
// saved daily numbers from the work_order_daily_stats table instead (kept up
// to date hourly by the work-order-stats Edge Function), so they don't have
// to wait on Asana.
//
// For a building on StoneAnchor's own lists, a row of name buttons above the
// chart ("All · Mike · Jose …") switches the chart, headline numbers and
// history list to just the work orders one person marked complete. Those are
// worked out in the browser from each task's locked "completed by" name.
// The last button, "Compare", puts everyone side by side: one line each on
// the chart, and a ranked table underneath.

let dailyStatsCache = {};   // { propCode: [daily rows, oldest first] }
let completionsCache = {};  // { propCode: [completed work orders, with who completed them] }
let currentPerson = null;   // name picked in the person buttons; null = All, COMPARE = Compare
const COMPARE = "__compare__";
let currentTrendProp = null;
let currentWeeks = 12;
let trendLoadSeq = 0;       // ignores a slow response for a property no longer selected

const HISTORY_MAX_WEEKS = 52;  // longest range button (1 Yr)
const ROLLING_WEEKS = 6;       // "6-wk avg" columns in the history table

// ── Utilities ─────────────────────────────────────────────────────────────────

function setStatus(msg, type) {
  var el = document.getElementById("statusBar");
  el.textContent = msg;
  el.className = "status-bar" + (type ? " " + type : "");
}


function daysOverdue(due) {
  var today = new Date(); today.setHours(0,0,0,0);
  return Math.round((today - new Date(due)) / 86400000);
}


// Return the Monday of the week containing date d
function weekStart(d) {
  var dt = new Date(d);
  var day = dt.getDay(); // 0=Sun
  var diff = (day === 0) ? -6 : 1 - day;
  dt.setDate(dt.getDate() + diff);
  dt.setHours(0,0,0,0);
  return dt;
}

function fmtWeekLabel(dt) {
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ── Asana API ─────────────────────────────────────────────────────────────────
// asanaFetch() itself lives in shared.js — the Work Orders and Building
// Compliance tabs both call it.

async function getOpenTasks(projectGid) {
  var fields = "name,due_on,completed,completed_at,created_at,assignee.name";
  var tasks = [], offset = null;
  while (true) {
    var url = "/tasks?project=" + projectGid + "&completed_since=now&opt_fields=" + fields + "&limit=100";
    if (offset) url += "&offset=" + offset;
    var data = await asanaFetch(url);
    tasks = tasks.concat(data.data);
    if (data.next_page) { offset = data.next_page.offset; } else { break; }
  }
  return tasks;
}

async function getRecentlyCompleted(projectGid) {
  var fields = "name,completed,completed_at,created_at";
  var since = new Date(); since.setDate(since.getDate() - 30);
  try {
    var data = await asanaFetch("/tasks?project=" + projectGid + "&completed_since=" + since.toISOString() + "&opt_fields=" + fields + "&limit=100");
    return data.data.filter(function(t) { return t.completed; });
  } catch(e) { return []; }
}

async function getRoomTurnData(projectGid) {
  var secData = await asanaFetch("/projects/" + projectGid + "/sections?opt_fields=name,gid");
  var sections = secData.data;

  function findSec(keyword) {
    return sections.find(function(s) { return s.name.toLowerCase().indexOf(keyword.toLowerCase()) !== -1; });
  }

  var rentReadySec  = findSec("rent ready");
  var toBeTurnedSec = findSec("to be turned") || findSec("rooms to be");
  var currentlySec  = findSec("currently");
  var fields = "name,due_on,completed,notes,assignee.name";

  async function fetchSection(sec) {
    if (!sec) return [];
    var data = await asanaFetch("/tasks?section=" + sec.gid + "&opt_fields=" + fields + "&limit=100");
    return data.data.filter(function(t) { return !t.completed; });
  }

  var res = await Promise.all([fetchSection(rentReadySec), fetchSection(toBeTurnedSec), fetchSection(currentlySec)]);
  return { rentReady: res[0], toBeTurned: res[1], currently: res[2] };
}

// ── StoneAnchor's own task lists ──────────────────────────────────────────────
// For a building switched off Asana (onStoneAnchor in shared.js) the cards read
// the same things from StoneAnchor instead, shaped like the Asana tasks above
// (name, due_on, created_at, completed_at, notes) so the rest of the card code
// doesn't need to know where they came from. Cancelled tasks never count.

async function saListIds(code, kind) {
  var res = await sb.from("task_lists").select("id").eq("property_code", code).eq("kind", kind).eq("archived", false);
  if (res.error) throw new Error(res.error.message);
  return res.data.map(function(l) { return l.id; });
}

function saAsAsana(t) {
  // "General" is the import's stand-in for "no room in the name" — leave it off.
  var name = !t.title ? t.room : (t.room === "General" ? t.title : t.room + " — " + t.title);
  return { name: name, due_on: t.due_date, created_at: t.created_at,
           completed_at: t.completed_at, completed: !!t.completed_at, notes: t.details };
}

async function saTasks(listIds, open, sinceIso, sectionId) {
  if (!listIds.length) return [];
  var q = sb.from("tasks").select("room,title,details,due_date,created_at,completed_at").in("list_id", listIds).is("cancelled_at", null);
  q = open ? q.is("completed_at", null) : q.gte("completed_at", sinceIso);
  if (sectionId) q = q.eq("section_id", sectionId);
  var res = await q.limit(5000);
  if (res.error) throw new Error(res.error.message);
  return res.data.map(saAsAsana);
}

async function getStoneAnchorCardData(code) {
  var since = new Date(); since.setDate(since.getDate() - 30);
  var ids = await Promise.all([saListIds(code, "work_orders"), saListIds(code, "pm"), saListIds(code, "room_turns")]);
  // Room turns: the same three sections the Asana version looks for, by name.
  var secRes = ids[2].length
    ? await sb.from("task_sections").select("id,name").in("list_id", ids[2]).eq("archived", false)
    : { data: [] };
  if (secRes.error) throw new Error(secRes.error.message);
  function findSec(keyword) {
    return secRes.data.find(function(s) { return s.name.toLowerCase().indexOf(keyword) !== -1; });
  }
  function sectionTasks(sec) { return sec ? saTasks(ids[2], true, null, sec.id) : Promise.resolve([]); }
  var res = await Promise.all([
    saTasks(ids[0], true), saTasks(ids[0], false, since.toISOString()), saTasks(ids[1], true),
    sectionTasks(findSec("rent ready")), sectionTasks(findSec("to be turned") || findSec("rooms to be")), sectionTasks(findSec("currently"))
  ]);
  return [res[0], res[1], res[2], { rentReady: res[3], toBeTurned: res[4], currently: res[5] }];
}

// ── Trend Chart ───────────────────────────────────────────────────────────────

function ymd(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

// "2026-10-24" -> a Date at local midnight (new Date("2026-10-24") would be
// UTC midnight, i.e. the evening before in Utah).
function parseYmd(s) {
  var p = s.split("-");
  return new Date(+p[0], +p[1] - 1, +p[2]);
}

function buildWeekBuckets(numWeeks) {
  var buckets = [];
  var now = today0();
  for (var i = numWeeks - 1; i >= 0; i--) {
    var wStart = new Date(now);
    wStart.setDate(now.getDate() - (i * 7));
    wStart = weekStart(wStart);
    var wEnd = new Date(wStart);
    wEnd.setDate(wStart.getDate() + 7);
    buckets.push({ start: wStart, end: wEnd, label: fmtWeekLabel(wStart), days: [], added: 0, completed: 0, daysTotal: 0 });
  }
  return buckets;
}

// Groups saved daily rows (oldest first) into Monday–Sunday weeks. "Open" and
// "Overdue" for a week are the numbers on its last saved day.
function groupIntoWeeks(rows, numWeeks) {
  var buckets = buildWeekBuckets(numWeeks);
  rows.forEach(function(r) {
    var d = parseYmd(r.stat_date);
    for (var i = 0; i < buckets.length; i++) {
      if (d >= buckets[i].start && d < buckets[i].end) { buckets[i].days.push(r); break; }
    }
  });
  buckets.forEach(function(b) {
    b.days.forEach(function(r) {
      b.added += r.added;
      b.completed += r.completed;
      b.daysTotal += Number(r.completed_days_total);
    });
    b.last = b.days.length ? b.days[b.days.length - 1] : null;
  });
  return buckets;
}

// Adds a 6-week rolling average of added/completed to each week that has 5
// full weeks of saved history before it. Left blank for the current week,
// since a half-finished week would drag the average down.
function addRollingAverages(buckets) {
  var lastIdx = buckets.length - 1;
  buckets.forEach(function(b, i) {
    b.rollAdded = null;
    b.rollCompleted = null;
    if (i === lastIdx || i < ROLLING_WEEKS - 1) return;
    var span = buckets.slice(i - ROLLING_WEEKS + 1, i + 1);
    if (span.some(function(w) { return w.days.length === 0; })) return;
    b.rollAdded = span.reduce(function(s, w) { return s + w.added; }, 0) / ROLLING_WEEKS;
    b.rollCompleted = span.reduce(function(s, w) { return s + w.completed; }, 0) / ROLLING_WEEKS;
  });
}

// Two years of days: the 1-Yr chart, the year before it (for the headline
// comparison), plus a few weeks for the earliest 6-week rolling averages.
async function fetchDailyStats(propCode) {
  var from = today0();
  from.setDate(from.getDate() - (HISTORY_MAX_WEEKS * 2 + ROLLING_WEEKS) * 7);
  var res = await sb.from("work_order_daily_stats")
    .select("stat_date,added,completed,open_count,overdue_count,completed_days_total,is_estimate,updated_at")
    .eq("property_code", propCode)
    .gte("stat_date", ymd(weekStart(from)))
    .order("stat_date");
  if (res.error) throw new Error(res.error.message);
  // Each facility started using Asana at a different time, and the days
  // before that are saved as all zeros. Drop them, so they're treated as "no
  // history" rather than as weeks with no work orders (which would make
  // every comparison against them look like a huge change).
  var firstActive = res.data.findIndex(function(r) { return r.added > 0 || r.completed > 0 || r.open_count > 0; });
  return firstActive === -1 ? [] : res.data.slice(firstActive);
}

// ── Per-person view ───────────────────────────────────────────────────────────

// Every work order at a StoneAnchor-lists building completed in the same
// window fetchDailyStats covers, with who completed it. Cancelled ones
// (entered by mistake) don't count, same as the saved daily numbers.
async function fetchCompletedWorkOrders(propCode) {
  var lists = await sb.from("task_lists").select("id").eq("property_code", propCode).eq("kind", "work_orders");
  if (lists.error) throw new Error(lists.error.message);
  if (!lists.data.length) return [];
  var ids = lists.data.map(function(l) { return l.id; });
  var from = today0();
  from.setDate(from.getDate() - (HISTORY_MAX_WEEKS * 2 + ROLLING_WEEKS) * 7 - 8);
  var tasks = [];
  // The database hands back at most 1,000 rows per request, so page through.
  for (var offset = 0; ; offset += 1000) {
    var res = await sb.from("tasks").select("created_at,completed_at,completed_by_name")
      .in("list_id", ids).is("cancelled_at", null).gte("completed_at", from.toISOString())
      .order("id").range(offset, offset + 999);
    if (res.error) throw new Error(res.error.message);
    tasks = tasks.concat(res.data);
    if (res.data.length < 1000) break;
  }
  return tasks;
}

// The calendar day ("2026-11-25") something happened, in the building's own
// time zone — the same way the saved daily numbers split days.
function dayInZone(iso, timeZone) {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: timeZone || "America/Denver" });
}

// Everyone who completed a work order here within the weeks the chart is
// showing (e.g. 12 Wks), most completions first. Leaving out anyone with no
// completions in that range means old names (like someone's Asana-era name
// before they had a StoneAnchor login) drop off the buttons on their own as
// time passes. "Asana" is what work orders brought over from Asana say when
// Asana didn't record a name, so it isn't a person.
function peopleFrom(tasks, numWeeks) {
  var since = today0();
  since.setDate(since.getDate() - (numWeeks - 1) * 7);
  since = weekStart(since);   // the first day of the chart's first week
  var counts = {};
  tasks.forEach(function(t) {
    var name = (t.completed_by_name || "").trim();
    if (!name || name === "Asana" || new Date(t.completed_at) < since) return;
    counts[name] = (counts[name] || 0) + 1;
  });
  return Object.keys(counts).sort(function(a, b) { return counts[b] - counts[a] || a.localeCompare(b); });
}

// One person's numbers in the same shape as the saved daily rows, so the
// chart, headline numbers and history list can show them unchanged. Starts
// on the day of their first completion (so the weeks before they started
// don't count as weeks with nothing done) and uses the building's own saved
// days as the calendar. "buildingCompleted" is kept for the "share" figures.
function personDailyRows(buildingRows, tasks, person, timeZone) {
  var completed = {}, daysTotal = {}, first = null;
  tasks.forEach(function(t) {
    if ((t.completed_by_name || "").trim() !== person) return;
    var day = dayInZone(t.completed_at, timeZone);
    completed[day] = (completed[day] || 0) + 1;
    daysTotal[day] = (daysTotal[day] || 0) + (new Date(t.completed_at) - new Date(t.created_at)) / 86400000;
    if (!first || day < first) first = day;
  });
  if (!first) return [];
  return buildingRows.filter(function(r) { return r.stat_date >= first; }).map(function(r) {
    return {
      stat_date: r.stat_date, added: 0, completed: completed[r.stat_date] || 0,
      open_count: 0, overdue_count: 0, completed_days_total: daysTotal[r.stat_date] || 0,
      is_estimate: false, updated_at: r.updated_at, buildingCompleted: r.completed
    };
  });
}

// The "All · name · name" buttons. Only for buildings on StoneAnchor's own
// lists — buildings still on Asana don't record who completed what here.
function renderPersonToggle(people) {
  var box = document.getElementById("chartPersonToggle");
  if (!people.length) { box.style.display = "none"; box.innerHTML = ""; return; }
  // "Compare" only makes sense with at least two people.
  var choices = [null].concat(people);
  if (people.length >= 2) choices.push(COMPARE);
  box.innerHTML = '<span class="chart-person-label">Show</span>' +
    choices.map(function(name) {
      var label = name === COMPARE ? "Compare" : shortName(name) || "All";
      return '<button type="button" class="range-btn' + (name === currentPerson ? ' active' : '') + '" data-person="' +
        escapeHtml(name || "") + '">' + escapeHtml(label) + '</button>';
    }).join("");
  box.querySelectorAll(".range-btn").forEach(function(btn) {
    btn.addEventListener("click", function() {
      currentPerson = btn.getAttribute("data-person") || null;
      if (currentTrendProp) loadTrendChart(currentTrendProp, currentWeeks);
    });
  });
  box.style.display = "flex";
}

// A login that never filled in its name is stamped with its email address;
// show just the part before the "@" so the buttons stay short.
function shortName(name) {
  return name && name.indexOf("@") > 0 ? name.slice(0, name.indexOf("@")) : name;
}

// Switches the labels around the chart between the building's totals and one person.
function setChartMode(person) {
  var compare = person === COMPARE;
  document.getElementById("chartTitle").textContent = compare ? "Work Orders — Completed, Side by Side" :
    person ? "Work Orders — Completed by " + shortName(person) : "Work Orders — Added vs Completed";
  // Compare puts its own name list under the chart instead.
  document.getElementById("chartLegend").style.display = compare ? "none" : "";
  document.getElementById("woHistoryEyebrow").textContent = compare ? "Side by side · click a name to see their own history" :
    "History · click a month to see its weeks, a week to see its days";
  document.getElementById("legendAdded").style.display = person ? "none" : "";
  document.getElementById("statAddedTile").style.display = person ? "none" : "";
  document.getElementById("stat-open-label").innerHTML = person ? "Share of<br>All Completed" : "Open<br>Right Now";
  document.getElementById("chartSummary").classList.toggle("person-mode", !!person);
  // The download is the building's saved totals, so it's only offered on "All".
  document.getElementById("woDownloadBtn").style.display = person ? "none" : "";
}

// ── Compare view ──────────────────────────────────────────────────────────────

var PERSON_COLOR_COUNT = 6;   // --person-1 … --person-6 in css/styles.css

// Everyone side by side: a line each on the chart (weekly completions) and a
// ranked table for the selected range. Like the headline numbers, the table
// covers the last n full weeks (this unfinished week isn't counted) and
// compares each person's weekly pace with the n weeks before.
function renderCompare(prop, buildingRows, completions, people, n) {
  var css = getComputedStyle(document.documentElement);
  var building = groupIntoWeeks(buildingRows, n * 2 + 1);
  var series = people.map(function(name, i) {
    return {
      name: name,
      color: css.getPropertyValue("--person-" + (i % PERSON_COLOR_COUNT + 1)).trim(),
      weeks: groupIntoWeeks(personDailyRows(buildingRows, completions, name, prop.timeZone), n * 2 + 1)
    };
  });

  drawCompareChart(series.map(function(s) { return { name: s.name, color: s.color, weeks: s.weeks.slice(-n) }; }));
  document.getElementById("chartSummary").style.display = "none";

  function sum(ws, f) { return ws.reduce(function(t, w) { return t + w[f]; }, 0); }
  var buildingRecent = building.slice(n, n * 2);
  var allDone = sum(buildingRecent, "completed");
  var rowsOut = series.map(function(s) {
    var prior = s.weeks.slice(0, n), recent = s.weeks.slice(n, n * 2);
    var had = recent.filter(function(w) { return w.days.length > 0; });   // weeks since they started
    var done = sum(recent, "completed");
    var priorComplete = prior.every(function(w) { return w.days.length > 0; });
    return {
      name: s.name, color: s.color, done: done,
      perWeek: had.length ? done / had.length : null,
      priorPerWeek: priorComplete ? sum(prior, "completed") / n : null,
      share: allDone > 0 ? done / allDone : null,   // of everything the building completed in these weeks
      avgDays: done > 0 ? sum(recent, "daysTotal") / done : null
    };
  }).sort(function(a, b) { return b.done - a.done; });

  var html = '<thead><tr><th>Person</th><th>Completed</th><th>Per<br>week</th><th>Share</th><th>Avg<br>days</th></tr></thead><tbody>';
  rowsOut.forEach(function(r) {
    var change = "";
    if (r.perWeek != null && r.priorPerWeek != null) {
      var now = fmtAvg(r.perWeek), before = fmtAvg(r.priorPerWeek);
      if (now === before) change = '<span class="compare-change">no change</span>';
      else if (r.perWeek > r.priorPerWeek) change = '<span class="compare-change good">▲ from ' + before + '</span>';
      else change = '<span class="compare-change bad">▼ from ' + before + '</span>';
    }
    html += '<tr class="wo-row compare-row" data-person="' + escapeHtml(r.name) + '">' +
      '<td><span class="compare-dot" style="background:' + r.color + '"></span>' + escapeHtml(shortName(r.name)) + '</td>' +
      '<td>' + r.done + '</td>' +
      '<td>' + fmtAvg(r.perWeek) + change + '</td>' +
      '<td>' + (r.share == null ? "—" : Math.round(r.share * 100) + "%") + '</td>' +
      '<td>' + (r.avgDays == null ? "—" : Math.round(r.avgDays) + "d") + '</td></tr>';
  });
  var total = sum(buildingRecent, "completed");
  var buildingWeeks = buildingRecent.filter(function(w) { return w.days.length > 0; }).length;
  html += '<tr class="compare-total"><td>Whole building</td><td>' + total + '</td>' +
    '<td>' + (buildingWeeks ? fmtAvg(total / buildingWeeks) : "—") + '</td><td>100%</td>' +
    '<td>' + (total > 0 ? Math.round(sum(buildingRecent, "daysTotal") / total) + "d" : "—") + '</td></tr>';

  var table = document.getElementById("woHistoryTable");
  table.className = "wo-history-table compare-table";
  table.innerHTML = html + '</tbody>';
  table.querySelectorAll(".compare-row").forEach(function(tr) {
    tr.addEventListener("click", function() {
      currentPerson = tr.getAttribute("data-person");
      loadTrendChart(currentTrendProp, currentWeeks);
    });
  });

  var period = PERIOD_NAMES[n] || n + " weeks";
  document.getElementById("woHistoryNote").innerHTML =
    "The past " + period + " (full weeks only, so this week isn't counted yet). The ▲▼ compares each person's pace with the " + period + " before. " +
    "Per week only counts the weeks since each person's first completion here, so someone new isn't marked down for weeks before they started. " +
    "The whole-building row also includes work orders completed by anyone not listed (for example, older ones Asana didn't record a name for).";
  document.getElementById("woHistory").style.display = "block";
}

// One line per person: how many work orders they completed each week.
// Weeks before someone's first completion are left blank, not drawn as zero.
function drawCompareChart(series) {
  var content = document.getElementById("chartContent");
  content.innerHTML = '<canvas id="trendChart" height="280"></canvas><div class="compare-legend">' +
    series.map(function(s) {
      return '<span><span class="compare-dot" style="background:' + s.color + '"></span>' + escapeHtml(shortName(s.name)) + '</span>';
    }).join("") + '</div>';
  var canvas = document.getElementById("trendChart");
  var ctx = canvas.getContext("2d");
  var W = canvas.offsetWidth || 800, H = 280;
  canvas.width = W;
  canvas.height = H;
  var PAD_LEFT = 44, PAD_RIGHT = 20, PAD_TOP = 20, PAD_BOTTOM = 48;
  var chartW = W - PAD_LEFT - PAD_RIGHT, chartH = H - PAD_TOP - PAD_BOTTOM;
  var weeks = series[0].weeks, n = weeks.length;
  var groupW = chartW / n;
  var labelStep = Math.max(1, Math.ceil(50 / groupW));

  var maxVal = 1;
  series.forEach(function(s) { s.weeks.forEach(function(w) { if (w.completed > maxVal) maxVal = w.completed; }); });
  var yMax = Math.ceil(maxVal / 5) * 5 + 5;

  var css = getComputedStyle(document.documentElement);
  function cssColor(name) { return css.getPropertyValue(name).trim(); }

  // Grid lines and y labels
  ctx.strokeStyle = cssColor("--border");
  ctx.lineWidth = 1;
  for (var s = 0; s <= 5; s++) {
    var yVal = (yMax / 5) * s;
    var yPos = PAD_TOP + chartH - (yVal / yMax) * chartH;
    ctx.beginPath(); ctx.moveTo(PAD_LEFT, yPos); ctx.lineTo(PAD_LEFT + chartW, yPos); ctx.stroke();
    ctx.fillStyle = cssColor("--text-muted");
    ctx.font = "10px 'Share Tech Mono', monospace";
    ctx.textAlign = "right";
    ctx.fillText(Math.round(yVal), PAD_LEFT - 6, yPos + 3);
  }

  // Current week band and x labels
  ctx.fillStyle = cssColor("--accent-soft");
  ctx.fillRect(PAD_LEFT + (n - 1) * groupW, PAD_TOP, groupW, chartH);
  ctx.fillStyle = cssColor("--accent");
  ctx.font = "8px 'Share Tech Mono', monospace";
  ctx.textAlign = "center";
  ctx.fillText("THIS WEEK", PAD_LEFT + (n - 1) * groupW + groupW / 2, PAD_TOP + 10);
  ctx.fillStyle = cssColor("--text-dim");
  ctx.font = "9px 'Share Tech Mono', monospace";
  for (var i = 0; i < n; i++) {
    if ((n - 1 - i) % labelStep === 0) ctx.fillText(weeks[i].label, PAD_LEFT + i * groupW + groupW / 2, H - 10);
  }

  // The lines, with a dot on each week
  function x(i) { return PAD_LEFT + i * groupW + groupW / 2; }
  function y(v) { return PAD_TOP + chartH - (v / yMax) * chartH; }
  series.forEach(function(sr) {
    ctx.strokeStyle = sr.color;
    ctx.fillStyle = sr.color;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    var drawing = false;
    sr.weeks.forEach(function(w, i) {
      if (!w.days.length) { drawing = false; return; }
      if (drawing) ctx.lineTo(x(i), y(w.completed)); else ctx.moveTo(x(i), y(w.completed));
      drawing = true;
    });
    ctx.stroke();
    var r = groupW >= 14 ? 3.5 : 2;
    sr.weeks.forEach(function(w, i) {
      if (!w.days.length) return;
      ctx.beginPath(); ctx.arc(x(i), y(w.completed), r, 0, Math.PI * 2); ctx.fill();
    });
  });
}

// personMode: one person's view — just their completed bars, no added bars
// or open-backlog trend line (those belong to the building, not a person).
function drawChart(buckets, propName, numWeeks, personMode) {
  var content = document.getElementById("chartContent");
  content.innerHTML = '<canvas id="trendChart" height="280"></canvas>';
  var canvas = document.getElementById("trendChart");
  var ctx = canvas.getContext("2d");

  // Set canvas size
  var W = canvas.offsetWidth || 800;
  var H = 280;
  canvas.width  = W;
  canvas.height = H;

  var PAD_LEFT = 44, PAD_RIGHT = 20, PAD_TOP = 20, PAD_BOTTOM = 48;
  var chartW = W - PAD_LEFT - PAD_RIGHT;
  var chartH = H - PAD_TOP - PAD_BOTTOM;

  var labels    = buckets.map(function(b) { return b.label; });
  var added     = buckets.map(function(b) { return b.added; });
  var completed = buckets.map(function(b) { return b.completed; });

  var maxVal = Math.max.apply(null, added.concat(completed).concat([1]));
  var yMax = Math.ceil(maxVal / 5) * 5 + 5;

  var n = buckets.length;
  var barGroupW = chartW / n;
  var barW = barGroupW * 0.32;
  var gap   = barGroupW * 0.06;
  var labelStep = Math.max(1, Math.ceil(50 / barGroupW));

  // Colors come from the site's color system (top of css/styles.css), so the
  // chart can never drift away from the rest of the page.
  var css = getComputedStyle(document.documentElement);
  function cssColor(name) { return css.getPropertyValue(name).trim(); }
  var colAdded     = cssColor("--series-1");
  var colCompleted = cssColor("--series-2");
  var colGrid      = cssColor("--border");
  var colText      = cssColor("--text-muted");
  var colTextBright= cssColor("--text-dim");
  var colBrand     = cssColor("--accent");
  var colBrandSoft = cssColor("--accent-soft");

  // Grid lines
  ctx.strokeStyle = colGrid;
  ctx.lineWidth = 1;
  var ySteps = 5;
  for (var s = 0; s <= ySteps; s++) {
    var yVal = (yMax / ySteps) * s;
    var yPos = PAD_TOP + chartH - (yVal / yMax) * chartH;
    ctx.beginPath();
    ctx.moveTo(PAD_LEFT, yPos);
    ctx.lineTo(PAD_LEFT + chartW, yPos);
    ctx.stroke();
    // Y label
    ctx.fillStyle = colText;
    ctx.font = "10px 'Share Tech Mono', monospace";
    ctx.textAlign = "right";
    ctx.fillText(Math.round(yVal), PAD_LEFT - 6, yPos + 3);
  }

  // Shade the current week's column first, so the bars sit on top of it
  ctx.fillStyle = colBrandSoft;
  ctx.fillRect(PAD_LEFT + (n - 1) * barGroupW, PAD_TOP, barGroupW, chartH);

  // Bars
  for (var i = 0; i < n; i++) {
    var xBase = PAD_LEFT + i * barGroupW + barGroupW * 0.1;

    // Added bar
    var hAdded = personMode ? 0 : (added[i] / yMax) * chartH;
    var xAdded = xBase;
    var yAdded = PAD_TOP + chartH - hAdded;
    ctx.fillStyle = colAdded;
    ctx.globalAlpha = 1.0;
    if (hAdded > 0) ctx.fillRect(xAdded, yAdded, barW, hAdded);

    // Completed bar
    var hComp = (completed[i] / yMax) * chartH;
    // On its own, the completed bar sits in the middle of its week.
    var xComp = personMode ? xBase + (barGroupW * 0.8 - barW) / 2 : xBase + barW + gap;
    var yComp = PAD_TOP + chartH - hComp;
    ctx.fillStyle = colCompleted;
    ctx.globalAlpha = 1.0;
    if (hComp > 0) ctx.fillRect(xComp, yComp, barW, hComp);

    ctx.globalAlpha = 1.0;

    // Value labels on bars, in dark text (gold text would be hard to read) —
    // only when the bars are wide enough for the
    // numbers not to run into each other (not on the 1-Yr view).
    ctx.font = "bold 9px 'Share Tech Mono', monospace";
    ctx.textAlign = "center";
    if (!personMode && added[i] > 0 && barGroupW >= 28) {
      ctx.fillStyle = colTextBright;
      ctx.fillText(added[i], xAdded + barW / 2, yAdded - 4);
    }
    if (completed[i] > 0 && barGroupW >= 28) {
      ctx.fillStyle = colTextBright;
      ctx.fillText(completed[i], xComp + barW / 2, yComp - 4);
    }

    // X label — spaced at least ~50px apart so dates never overlap, counted
    // back from the current week so it's always labeled.
    if ((n - 1 - i) % labelStep === 0) {
      ctx.fillStyle = colTextBright;
      ctx.font = "9px 'Share Tech Mono', monospace";
      ctx.textAlign = "center";
      ctx.fillText(labels[i], PAD_LEFT + i * barGroupW + barGroupW / 2, H - 10);
    }

    // Label the current week's column (its shaded band is drawn behind the bars, above)
    if (i === n - 1) {
      ctx.fillStyle = colBrand;
      ctx.font = "8px 'Share Tech Mono', monospace";
      ctx.textAlign = "center";
      ctx.fillText("THIS WEEK", PAD_LEFT + i * barGroupW + barGroupW / 2, PAD_TOP + 10);
    }
  }

  if (personMode) return;

  // Trend line — net (added - completed) rolling
  ctx.strokeStyle = colText;
  ctx.globalAlpha = 0.6;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  var netRunning = 0;
  for (var i = 0; i < n; i++) {
    netRunning += (added[i] - completed[i]);
    var xMid = PAD_LEFT + i * barGroupW + barGroupW / 2;
    var netClamped = Math.max(0, Math.min(netRunning, yMax));
    var yNet = PAD_TOP + chartH - (netClamped / yMax) * chartH;
    if (i === 0) ctx.moveTo(xMid, yNet);
    else ctx.lineTo(xMid, yNet);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1.0;

}

async function loadTrendChart(prop, numWeeks) {
  numWeeks = numWeeks || currentWeeks;
  // A different building starts back on "All".
  if (!currentTrendProp || currentTrendProp.code !== prop.code) currentPerson = null;
  currentTrendProp = prop;
  var seq = ++trendLoadSeq;
  var panel = document.getElementById("chartPanel");
  var content = document.getElementById("chartContent");
  panel.classList.add("visible");
  document.getElementById("chartSummary").style.display = "none";
  document.getElementById("woHistory").style.display = "none";

  function showMessage(html) {
    content.innerHTML = '<div class="chart-loading">' + html + '</div>';
    setTimeout(function() { panel.classList.add("loaded"); }, 50);
  }

  var onStoneAnchor = prop.taskSource === "stoneanchor";
  if (!prop.gid && !onStoneAnchor) { showMessage("Not connected to Asana yet."); return; }
  if (!onStoneAnchor) { currentPerson = null; renderPersonToggle([]); }

  if (!dailyStatsCache[prop.code]) {
    content.innerHTML = '<div class="chart-loading">Loading history…</div>';
    setTimeout(function() { panel.classList.add("loaded"); }, 50);
    try {
      var fetched = await fetchDailyStats(prop.code);
      dailyStatsCache[prop.code] = fetched;
      delete completionsCache[prop.code];
    } catch(err) {
      if (seq !== trendLoadSeq) return;
      showMessage('<span style="color:var(--danger)">Couldn\'t load trend data: ' + escapeHtml(err.message) + '</span>' +
        '<br><button class="table-action-btn" style="margin-top:12px" onclick="loadTrendChart(currentTrendProp)">Try again</button>');
      return;
    }
  }
  if (seq !== trendLoadSeq) return;

  // Who completed what, for the person buttons. If it can't load, the
  // building's totals still show — just without the buttons.
  if (onStoneAnchor && !completionsCache[prop.code]) {
    try { completionsCache[prop.code] = await fetchCompletedWorkOrders(prop.code); }
    catch (err) { console.warn("Couldn't load who completed each work order:", err); }
    if (seq !== trendLoadSeq) return;
  }
  var completions = completionsCache[prop.code] || [];
  if (onStoneAnchor) {
    var people = peopleFrom(completions, numWeeks);
    if (currentPerson === COMPARE ? people.length < 2 : currentPerson && people.indexOf(currentPerson) === -1) currentPerson = null;
    renderPersonToggle(people);
  }
  setChartMode(currentPerson);

  var rows = dailyStatsCache[prop.code];
  if (rows.length > 0 && currentPerson === COMPARE) {
    renderCompare(prop, rows, completions, people, numWeeks);
    panel.classList.add("loaded");
    return;
  }
  if (rows.length > 0 && currentPerson) {
    rows = personDailyRows(rows, completions, currentPerson, prop.timeZone);
    if (rows.length === 0) { showMessage("No completed work orders saved for " + escapeHtml(shortName(currentPerson)) + " yet."); return; }
  }
  if (rows.length === 0) {
    showMessage("No history saved for this facility yet — it's recorded automatically every hour, so check back shortly.");
    return;
  }

  // Group every fetched week once, oldest first; the chart, headline numbers
  // and month list each take the slice they need.
  var all = groupIntoWeeks(rows, HISTORY_MAX_WEEKS * 2 + ROLLING_WEEKS);
  addRollingAverages(all);
  var chartWeeks = all.slice(-numWeeks);

  drawChart(chartWeeks, prop.name, numWeeks, !!currentPerson);
  // Headline numbers: the selected range's full weeks vs. the same number
  // of weeks before them, plus the current (unfinished) week.
  renderHistorySummary(all.slice(-(numWeeks * 2 + 1)), numWeeks, !!currentPerson);

  // The month list shows whole months: every month the chart reaches into,
  // and never fewer than the current month plus the two before it.
  var first = chartWeeks[0].start;
  var listStart = new Date(first.getFullYear(), first.getMonth(), 1);
  var now = today0();
  var minStart = new Date(now.getFullYear(), now.getMonth() - 2, 1);
  if (minStart < listStart) listStart = minStart;
  renderHistoryTree(all.filter(function(w) { return w.start >= listStart; }), rows, !!currentPerson);
  panel.classList.add("loaded");
}

function fmtAvg(n) {
  return n == null ? "—" : (Math.round(n * 10) / 10).toFixed(1);
}

function avgDaysCell(daysTotal, completed) {
  return completed > 0 ? Math.round(daysTotal / completed) + "d" : "—";
}

var PERIOD_NAMES = { 6: "6 weeks", 12: "12 weeks", 26: "6 months", 52: "year" };

// Headline numbers above the history list: the selected range's last n full
// weeks compared with the n full weeks before them. `w` is 2n + 1 weeks,
// oldest first, the last being the current (unfinished) week.
// In personMode the "Open right now" tile shows the person's share of all
// work orders completed at the building instead (open work isn't anyone's).
function renderHistorySummary(w, n, personMode) {
  var prior = w.slice(0, n);
  // Only weeks with saved history count, so a facility newer to Asana than
  // the selected range averages over the weeks it actually has.
  var recent = w.slice(n, n * 2).filter(function(x) { return x.days.length > 0; });
  // The earlier period is only compared against when all of it is there —
  // half a period would make the change look bigger or smaller than it is.
  var priorComplete = prior.every(function(x) { return x.days.length > 0; });
  function sum(ws, f) { return ws.reduce(function(s, x) { return s + x[f]; }, 0); }
  function perWeek(ws, f) { return ws.length ? sum(ws, f) / ws.length : null; }
  function avgDays(ws) { var c = sum(ws, "completed"); return c > 0 ? sum(ws, "daysTotal") / c : null; }

  var now = w[w.length - 1].last;
  var openThen = prior[prior.length - 1].last;
  var p = priorComplete ? prior : [];

  var name = PERIOD_NAMES[n] || n + " weeks";
  var caption = "Past " + name + ", compared with the " + name + " before";
  if (recent.length < n) caption = "Past " + recent.length + " weeks: all the history saved so far for " + (personMode ? "this person" : "this facility");
  document.getElementById("chartSummaryCaption").textContent = caption;

  // goodWhenUp: true = a rise is good news (green), false = a rise is bad
  // news (red), null = neither (e.g. more work orders coming in is just demand).
  function setTile(id, value, previous, text, goodWhenUp) {
    document.getElementById(id).textContent = value == null ? "—" : text(value);
    var deltaEl = document.getElementById(id + "-delta");
    deltaEl.className = "chart-stat-delta";
    if (value == null) { deltaEl.innerHTML = "&nbsp;"; return; }
    if (previous == null) { deltaEl.textContent = "no earlier data"; return; }
    var same = text(value) === text(previous);
    var cls = "";
    if (!same && goodWhenUp !== null) cls = (value > previous) === goodWhenUp ? " good" : " bad";
    deltaEl.className = "chart-stat-delta" + cls;
    deltaEl.textContent = same ? "no change" : (value > previous ? "▲" : "▼") + " from " + text(previous);
  }

  setTile("stat-added", perWeek(recent, "added"), perWeek(p, "added"), fmtAvg, null);
  setTile("stat-completed", perWeek(recent, "completed"), perWeek(p, "completed"), fmtAvg, true);
  if (personMode) {
    // Their completions as a share of everyone's, over the same weeks.
    var share = function(ws) {
      var mine = 0, all = 0;
      ws.forEach(function(x) { x.days.forEach(function(r) { mine += r.completed; all += r.buildingCompleted; }); });
      return all > 0 ? mine / all : null;
    };
    var pct = function(v) { return Math.round(v * 100) + "%"; };
    setTile("stat-open", share(recent), p.length ? share(p) : null, pct, null);
  } else {
    setTile("stat-open", now ? now.open_count : null, openThen ? openThen.open_count : null, String, false);
  }
  setTile("stat-days", avgDays(recent), avgDays(p), function(v) { return Math.round(v) + "d"; }, false);
  document.getElementById("chartSummary").style.display = "grid";
}

// "≈" marks numbers rebuilt after the fact rather than recorded on the day.
function snapshotCell(row, field) {
  if (!row) return "—";
  return (row.is_estimate ? '<span class="wo-est">≈</span>' : "") + row[field];
}

// The history list: one simple row per month; click a month to see its
// weeks, click a week to see its days. Each level only shows added /
// completed / open — the rest (overdue, avg days, 6-week averages) appears
// once you've opened a week. Weeks run Monday–Sunday and sit under the month
// their Monday falls in, so a month's totals always equal its weeks' totals.
// personMode: one person's view — the columns become Completed and Avg days
// (added and open belong to the building, not a person).
function renderHistoryTree(weeks, rows, personMode) {
  var table = document.getElementById("woHistoryTable");
  table.className = "wo-history-table";
  var lastIdx = weeks.length - 1;

  var months = [];   // newest first
  for (var i = lastIdx; i >= 0; i--) {
    var w = weeks[i];
    if (w.days.length === 0) continue;
    w.isCurrent = i === lastIdx;
    var key = w.start.getFullYear() + "-" + w.start.getMonth();
    var m = months[months.length - 1];
    if (!m || m.key !== key) {
      m = { key: key, label: w.start.toLocaleDateString("en-US", { month: "long", year: "numeric" }), weeks: [], added: 0, completed: 0, daysTotal: 0 };
      months.push(m);
    }
    m.weeks.push(w);
    m.added += w.added;
    m.completed += w.completed;
    m.daysTotal += w.daysTotal;
  }

  // The number columns for a month, week or day row.
  function cells(added, completed, openRow, daysTotal) {
    if (personMode) return '<td>' + completed + '</td><td>' + avgDaysCell(daysTotal, completed) + '</td>';
    return '<td>' + added + '</td><td>' + completed + '</td><td>' + snapshotCell(openRow, "open_count") + '</td>';
  }
  var cols = personMode ? 3 : 4;

  var soFar = ' <span class="wo-this-week">so far</span>';
  var html = '<thead><tr><th></th>' + (personMode ? '<th>Completed</th><th>Avg<br>days</th>' :
    '<th>Added</th><th>Completed</th><th>Open<br>at end</th>') + '</tr></thead><tbody>';

  months.forEach(function(m, mi) {
    var mId = "m" + mi;
    html +=
      '<tr class="wo-row wo-month" data-id="' + mId + '">' +
        '<td><span class="wo-caret">▸</span>' + m.label + (m.weeks[0].isCurrent ? soFar : '') + '</td>' +
        cells(m.added, m.completed, m.weeks[0].last, m.daysTotal) +
      '</tr>';

    m.weeks.forEach(function(w, wi) {
      var wId = mId + "w" + wi;
      html +=
        '<tr class="wo-row wo-week" data-id="' + wId + '" data-parent="' + mId + '" hidden>' +
          '<td><span class="wo-caret">▸</span>Week of ' + w.label + (w.isCurrent ? soFar : '') + '</td>' +
          cells(w.added, w.completed, w.last, w.daysTotal) +
        '</tr>';

      var facts;
      if (personMode) {
        var allDone = w.days.reduce(function(s, r) { return s + r.buildingCompleted; }, 0);
        facts = ["<b>" + w.completed + "</b> of the building's <b>" + allDone + "</b> completed this week"];
        if (w.rollCompleted != null) facts.push("6-week avg: <b>" + fmtAvg(w.rollCompleted) + "</b> completed per week");
      } else facts = [
        "<b>" + snapshotCell(w.last, "overdue_count") + "</b> overdue at week end",
        "<b>" + avgDaysCell(w.daysTotal, w.completed) + "</b> avg to complete"
      ];
      if (!personMode && w.rollAdded != null) {
        facts.push("6-week avg: <b>" + fmtAvg(w.rollAdded) + "</b> added, <b>" + fmtAvg(w.rollCompleted) + "</b> completed per week");
      }
      html += '<tr class="wo-detail" data-parent="' + wId + '" hidden><td colspan="' + cols + '">' + facts.join('<span class="wo-sep">·</span>') + '</td></tr>';

      w.days.slice().reverse().forEach(function(r) {
        var day = parseYmd(r.stat_date).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
        var extra = [];
        if (r.overdue_count > 0) extra.push(snapshotCell(r, "overdue_count") + " overdue");
        if (r.completed > 0 && !personMode) extra.push(avgDaysCell(Number(r.completed_days_total), r.completed) + " avg");
        html +=
          '<tr class="wo-day" data-parent="' + wId + '" hidden>' +
            '<td>' + day + (extra.length ? '<span class="wo-day-extra">' + extra.join(" · ") + '</span>' : '') + '</td>' +
            cells(r.added, r.completed, r, Number(r.completed_days_total)) +
          '</tr>';
      });
    });
  });
  table.innerHTML = html + '</tbody>';

  // Opening a row shows just its direct children; closing it hides
  // everything underneath (so re-opening a month starts tidy again).
  function collapse(id) {
    table.querySelectorAll('[data-parent="' + id + '"]').forEach(function(child) {
      child.hidden = true;
      if (child.classList.contains("expanded")) {
        child.classList.remove("expanded");
        collapse(child.getAttribute("data-id"));
      }
    });
  }
  table.querySelectorAll(".wo-row").forEach(function(tr) {
    tr.addEventListener("click", function() {
      var id = tr.getAttribute("data-id");
      if (tr.classList.toggle("expanded")) {
        table.querySelectorAll('[data-parent="' + id + '"]').forEach(function(child) { child.hidden = false; });
      } else {
        collapse(id);
      }
    });
  });

  var notes = [];
  var latest = rows.reduce(function(m, r) { return r.updated_at > m ? r.updated_at : m; }, "");
  if (personMode) {
    notes.push("Counts the work orders this person marked complete under their own login (work orders brought over from Asana use the name Asana recorded). " +
      "Avg days runs from when a work order was entered to when it was marked complete, so it includes any time it waited before they picked it up.");
  } else if (latest) {
    var t = new Date(latest);
    notes.push("Saved" + (currentTrendProp && currentTrendProp.taskSource === "stoneanchor" ? "" : " from Asana") + " " + t.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
      " at " + t.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) + " · updates every hour · weeks run Monday–Sunday.");
  }
  var shownEstimates = weeks.some(function(w) { return w.days.some(function(r) { return r.is_estimate; }); });
  if (shownEstimates) {
    notes.push('<span class="wo-est">≈</span> Rebuilt afterward from Asana\'s records. Open and overdue counts on these days can be slightly off if a due date was changed or a work order was deleted since.');
  }
  document.getElementById("woHistoryNote").innerHTML = notes.join("<br>");
  document.getElementById("woHistory").style.display = "block";
}

// ── Download history ──────────────────────────────────────────────────────────
// The "Download history" button (Admins and Editors only) saves saved daily
// numbers as an Excel file for a chosen time range, for the building being viewed.

// Time-range choices, worked out from today so each label names the actual
// months/years it covers, e.g. "Last month (September 2026)".
function historyDownloadRanges() {
  var t = today0();
  var y = t.getFullYear(), m = t.getMonth();
  function mon(d, long) { return d.toLocaleDateString("en-US", { month: long ? "long" : "short", year: "numeric" }); }
  var lastMonthStart = new Date(y, m - 1, 1);
  var lastMonthEnd = new Date(y, m, 0);   // day 0 of this month = last day of the month before
  var threeStart = new Date(y, m - 3, 1);
  var twelveStart = new Date(y, m - 12, 1);
  return [
    { key: "last-month", label: "Last month (" + mon(lastMonthStart, true) + ")", from: lastMonthStart, to: lastMonthEnd },
    { key: "last-3", label: "Last 3 full months (" + mon(threeStart) + " – " + mon(lastMonthEnd) + ")", from: threeStart, to: lastMonthEnd },
    { key: "last-12", label: "Last 12 full months (" + mon(twelveStart) + " – " + mon(lastMonthEnd) + ")", from: twelveStart, to: lastMonthEnd },
    { key: "this-year", label: "This year so far (" + y + ")", from: new Date(y, 0, 1), to: t },
    { key: "last-year", label: "Last year (" + (y - 1) + ")", from: new Date(y - 1, 0, 1), to: new Date(y - 1, 11, 31) },
    { key: "all", label: "All saved history", from: null, to: t },
    { key: "custom", label: "Custom dates…", from: null, to: null }
  ];
}

function openHistoryDownload() {
  if (!requireEditAccess() || !currentTrendProp) return;
  document.getElementById("woDownloadRange").innerHTML = historyDownloadRanges().map(function(r) {
    return '<option value="' + r.key + '">' + escapeHtml(r.label) + '</option>';
  }).join("");
  document.getElementById("woDownloadCustom").hidden = true;
  var t = today0();
  document.getElementById("woDownloadFrom").value = ymd(new Date(t.getFullYear(), t.getMonth(), 1));
  document.getElementById("woDownloadTo").value = ymd(t);

  // Always just the building being viewed — each one is downloaded on its
  // own; to get another, switch buildings with the "Viewing" picker first.
  document.getElementById("woDownloadBuilding").textContent = currentTrendProp.name;

  document.getElementById("woDownloadError").style.display = "none";
  document.getElementById("woDownloadOverlay").style.display = "flex";
}

function closeHistoryDownload() {
  document.getElementById("woDownloadOverlay").style.display = "none";
}

async function downloadHistory(btn) {
  var errEl = document.getElementById("woDownloadError");
  function fail(msg) { errEl.textContent = msg; errEl.style.display = "block"; }
  errEl.style.display = "none";

  var key = document.getElementById("woDownloadRange").value;
  var range = historyDownloadRanges().find(function(r) { return r.key === key; });
  var fromStr = range.from ? ymd(range.from) : null;
  var toStr = ymd(range.to || today0());
  if (key === "custom") {
    fromStr = document.getElementById("woDownloadFrom").value;
    toStr = document.getElementById("woDownloadTo").value;
    if (!fromStr || !toStr) return fail("Pick both a start and an end date.");
    if (fromStr > toStr) return fail("The start date needs to be on or before the end date.");
  }

  var prop = currentTrendProp;
  var label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Preparing…";
  try {
    // The database hands back at most 1,000 rows per request (under three
    // years of days), so ask page by page until a short page comes back.
    var rows = [];
    for (var offset = 0; ; offset += 1000) {
      var q = sb.from("work_order_daily_stats")
        .select("property_code,stat_date,added,completed,open_count,overdue_count,completed_days_total,is_estimate")
        .eq("property_code", prop.code)
        .lte("stat_date", toStr);
      if (fromStr) q = q.gte("stat_date", fromStr);
      var res = await q.order("stat_date").range(offset, offset + 999);
      if (res.error) throw new Error(res.error.message);
      rows = rows.concat(res.data);
      if (res.data.length < 1000) break;
    }

    // Leave out the all-zero days from before this building started using
    // Asana (same as the chart does).
    var firstActive = rows.findIndex(function(r) { return r.added > 0 || r.completed > 0 || r.open_count > 0; });
    rows = firstActive === -1 ? [] : rows.slice(firstActive);
    if (rows.length === 0) return fail("There's no saved history for " + prop.name + " in that time range.");

    // Built by js/xlsx-writer.js — the same layout as the monthly email's attachment.
    var names = {};
    names[prop.code] = prop.name;
    var blob = await workOrderHistoryXlsx(JSZip, prop.name, names, rows).generateAsync({
      type: "blob",
      compression: "DEFLATE",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "work-order-history_" + prop.code + "_" + (fromStr || rows[0].stat_date) + "_to_" + toStr + ".xlsx";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    closeHistoryDownload();
  } catch(err) {
    fail("Couldn't download: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

function hideTrendChart() {
  trendLoadSeq++;
  var panel = document.getElementById("chartPanel");
  panel.classList.remove("visible");
  panel.classList.remove("loaded");
}

// ── Card Builder ──────────────────────────────────────────────────────────────

function buildCard(prop, index) {
  var card = document.createElement("div");
  card.className = "card";
  card.id = "card-" + prop.code;
  card.innerHTML =
    '<div class="card-header">' +
      '<div>' +
        '<div class="property-code">' + escapeHtml(prop.code) + '</div>' +
        '<div class="property-name">' + escapeHtml(prop.name) + '</div>' +
      '</div>' +
      '<div class="card-status-pill pill-loading" id="pill-' + prop.code + '">Loading…</div>' +
    '</div>' +
    '<div class="metrics">' +
      '<div class="metric"><div class="metric-value" id="total-' + prop.code + '">—</div><div class="metric-label">Open<br>Work Orders</div></div>' +
      '<div class="metric"><div class="metric-value" id="overdue-' + prop.code + '">—</div><div class="metric-label">Overdue<br>Work Orders</div></div>' +
      '<div class="metric"><div class="metric-value" id="avg-' + prop.code + '">—</div><div class="metric-label">Avg Days to<br>Complete (30d)</div></div>' +
    '</div>' +
    '<div class="section-block">' +
      '<div class="section-title">Overdue Work Orders</div>' +
      '<div id="wo-list-' + prop.code + '"><div class="skeleton" style="height:12px;width:80%;margin-bottom:6px;"></div><div class="skeleton" style="height:12px;width:60%;"></div></div>' +
    '</div>' +
    '<div class="section-block">' +
      '<div class="pm-header">' +
        '<div class="section-title">Preventative Maintenance</div>' +
        '<div class="pm-count-wrap"><span class="pm-count" id="pm-count-' + prop.code + '">—</span><span class="pm-count-label">Tasks Overdue</span></div>' +
      '</div>' +
      '<div id="pm-list-' + prop.code + '"><div class="skeleton" style="height:12px;width:70%;"></div></div>' +
    '</div>' +
    '<div class="section-block">' +
      '<div class="section-title">Room Turns</div>' +
      '<div class="rt-columns" id="rt-' + prop.code + '"><div class="skeleton" style="height:80px;width:100%;"></div></div>' +
    '</div>';

  document.getElementById("grid").appendChild(card);
  setTimeout(function() { card.classList.add("loaded"); }, 50 + index * 80);
}

// ── Card Loader ───────────────────────────────────────────────────────────────

async function loadCard(prop) {
  if (!prop.gid && !onStoneAnchor(prop)) {
    var pill = document.getElementById("pill-" + prop.code);
    if (pill) { pill.textContent = "Not Connected"; pill.className = "card-status-pill pill-alert"; }
    var woList = document.getElementById("wo-list-" + prop.code);
    if (woList) { woList.innerHTML = '<div style="font-size:11px;color:var(--text-muted)">This facility isn\'t connected to Asana yet — add its Asana IDs on the Admin tab to see Work Orders here.</div>'; }
    return;
  }
  try {
    var results = onStoneAnchor(prop) ? await getStoneAnchorCardData(prop.code) : await Promise.all([
      getOpenTasks(prop.gid),
      getRecentlyCompleted(prop.gid),
      getOpenTasks(prop.pmGid),
      getRoomTurnData(prop.rtGid)
    ]);

    var openTasks      = results[0];
    var completedTasks = results[1];
    var pmTasks        = results[2];
    var rtData         = results[3];
    var now            = today0();

    // Work Order metrics
    var overdueTasks = openTasks
      .filter(function(t) { return t.due_on && new Date(t.due_on) < now; })
      .sort(function(a,b) { return new Date(a.due_on) - new Date(b.due_on); });

    document.getElementById("total-" + prop.code).textContent = openTasks.length;

    var overdueEl = document.getElementById("overdue-" + prop.code);
    overdueEl.textContent = overdueTasks.length;
    overdueEl.className = "metric-value " + (overdueTasks.length <= 10 ? "success" : overdueTasks.length <= 15 ? "warn" : "danger");

    var avgDays = "—";
    var withDates = completedTasks.filter(function(t) { return t.created_at && t.completed_at; });
    if (withDates.length > 0) {
      avgDays = Math.round(withDates.reduce(function(s,t) { return s + daysBetween(t.created_at, t.completed_at); }, 0) / withDates.length);
    }

    var avgEl = document.getElementById("avg-" + prop.code);
    avgEl.textContent = typeof avgDays === "number" ? avgDays + "d" : avgDays;
    if (typeof avgDays === "number") {
      avgEl.className = "metric-value " + (avgDays <= 7 ? "success" : avgDays <= 14 ? "warn" : "danger");
    }

    var card = document.getElementById("card-" + prop.code);
    card.classList.remove("all-clear", "has-overdue");
    if (overdueTasks.length === 0) card.classList.add("all-clear");
    else if (overdueTasks.length > 15) card.classList.add("has-overdue");

    var pill = document.getElementById("pill-" + prop.code);
    if (overdueTasks.length === 0) {
      pill.textContent = "All Clear"; pill.className = "card-status-pill pill-ok";
    } else if (overdueTasks.length <= 15) {
      pill.textContent = overdueTasks.length + " Overdue"; pill.className = "card-status-pill pill-warn";
    } else {
      pill.textContent = overdueTasks.length + " Overdue"; pill.className = "card-status-pill pill-alert";
    }

    var woListEl = document.getElementById("wo-list-" + prop.code);
    if (overdueTasks.length === 0) {
      woListEl.innerHTML = '<div class="no-overdue">✓ No overdue tasks</div>';
    } else {
      var show = overdueTasks.slice(0, 5);
      woListEl.innerHTML = '<ul class="overdue-list">' +
        show.map(function(t) {
          return '<li class="overdue-item"><div class="overdue-dot"></div><div class="overdue-name">' + escapeHtml(t.name) + '</div>' +
            '<div style="font-family:\'Share Tech Mono\',monospace;font-size:10px;color:var(--text-dim);white-space:nowrap">' + daysOverdue(t.due_on) + 'd overdue</div></li>';
        }).join("") +
        (overdueTasks.length > 5 ? '<li class="overdue-item"><div style="font-family:\'Share Tech Mono\',monospace;font-size:10px;color:var(--text-muted)">+ ' + (overdueTasks.length - 5) + ' more…</div></li>' : '') +
      '</ul>';
    }

    // PM section
    var pmOverdue = pmTasks
      .filter(function(t) { return t.due_on && new Date(t.due_on) < now; })
      .sort(function(a,b) { return new Date(a.due_on) - new Date(b.due_on); });

    var pmCountEl = document.getElementById("pm-count-" + prop.code);
    pmCountEl.textContent = pmOverdue.length;
    pmCountEl.className = "pm-count " + (pmOverdue.length === 0 ? "success" : pmOverdue.length <= 3 ? "warn" : "danger");

    var pmListEl = document.getElementById("pm-list-" + prop.code);
    if (pmOverdue.length === 0) {
      pmListEl.innerHTML = '<div class="no-overdue">✓ No overdue PM tasks</div>';
    } else {
      pmListEl.innerHTML = '<ul class="overdue-list">' +
        pmOverdue.map(function(t) {
          return '<li class="overdue-item"><div class="overdue-dot" style="background:var(--series-1)"></div><div class="overdue-name">' + escapeHtml(t.name) + '</div></li>';
        }).join("") +
      '</ul>';
    }

    // Room Turns
    function fmtDue(due_on) {
      if (!due_on) return null;
      var d = new Date(due_on);
      return { label: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }), overdue: d < now };
    }

    function buildRtCol(title, cssClass, tasks, showDue, showNotes) {
      var rows = tasks.length === 0
        ? '<div class="rt-empty">None</div>'
        : tasks.map(function(t) {
            var due  = showDue   && t.due_on ? fmtDue(t.due_on) : null;
            var note = showNotes && t.notes  ? t.notes.split('\n')[0].slice(0, 80) : null;
            return '<div class="rt-room">' +
              '<div class="rt-room-name">' + escapeHtml(t.name) + '</div>' +
              (due  ? '<div class="rt-room-due' + (due.overdue ? ' overdue' : '') + '">Due ' + due.label + (due.overdue ? ' — OVERDUE' : '') + '</div>' : '') +
              (note ? '<div class="rt-room-note">' + escapeHtml(note) + '</div>' : '') +
            '</div>';
          }).join('');
      return '<div class="rt-col"><div class="rt-col-title ' + cssClass + '">' + title + '</div>' + rows + '</div>';
    }

    document.getElementById("rt-" + prop.code).innerHTML =
      buildRtCol("Rent Ready",             "ready",   rtData.rentReady,  false, false) +
      buildRtCol("To Be Turned",           "pending", rtData.toBeTurned, true,  false) +
      buildRtCol("Currently Being Turned", "active",  rtData.currently,  false, true);

  } catch(err) {
    console.error(prop.code, err);
    var pill = document.getElementById("pill-" + prop.code);
    if (pill) { pill.textContent = "Error"; pill.className = "card-status-pill pill-alert"; }
    var woList = document.getElementById("wo-list-" + prop.code);
    if (woList) { woList.innerHTML = '<div style="font-size:11px;color:var(--danger)">Failed to load: ' + escapeHtml(err.message) + '</div>'; }
  }
}

// ── View Switcher ─────────────────────────────────────────────────────────────

function applyView(value) {
  var grid = document.getElementById("grid");
  if (value === "all") {
    grid.classList.remove("single-view");
    hideTrendChart();
    PROPERTIES.forEach(function(prop) {
      var card = document.getElementById("card-" + prop.code);
      if (card) card.style.display = "";
    });
  } else {
    grid.classList.add("single-view");
    PROPERTIES.forEach(function(prop) {
      var card = document.getElementById("card-" + prop.code);
      if (card) card.style.display = prop.code === value ? "" : "none";
    });
    // Load trend chart for selected property
    var prop = PROPERTIES.find(function(p) { return p.code === value; });
    if (prop) loadTrendChart(prop);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function loadAll() {
  dailyStatsCache = {};
  completionsCache = {};
  currentPerson = null;
  currentTrendProp = null;
  currentWeeks = 12;
  document.querySelectorAll("#chartPanel .chart-range-toggle .range-btn").forEach(function(b) {
    b.classList.toggle("active", b.getAttribute("data-weeks") === "12");
  });
  document.getElementById("grid").innerHTML = "";
  hideTrendChart();
  setStatus("Connecting to Asana API…", "loading");
  communityProperties().forEach(function(prop, i) { buildCard(prop, i); });
  // The view picker and trend chart don't depend on the cards (the chart
  // reads saved history, not Asana), so show them right away rather than
  // waiting for every card to finish loading.
  document.getElementById("viewSelector").style.display = communityLocked() ? "none" : "flex";
  var sel = document.getElementById("viewSelect").value;
  if (sel !== "all") applyView(sel);
  setStatus("Fetching data for all properties…", "loading");
  await Promise.all(communityProperties().map(function(prop) { return loadCard(prop); }));
  var now = new Date();
  document.getElementById("lastUpdated").textContent =
    "Updated " + now.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
    " at " + now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  setStatus("✓ All properties loaded", "done");
  setTimeout(function() { setStatus(""); }, 3000);
}
