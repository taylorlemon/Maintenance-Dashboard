// Work Orders tab: pulls open/completed task counts and room-turn data
// from Asana (via the asana-proxy Supabase Edge Function) and draws the
// per-property trend chart.

let trendDataCache = {};    // { "propCode-weeks": buckets }
let currentTrendProp = null;
let currentWeeks = 12;

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

// Pull ALL tasks (open + completed) going back numWeeks for trend data
async function getAllTasksForTrend(projectGid, numWeeks) {
  var since = new Date();
  since.setDate(since.getDate() - (numWeeks * 7));
  var fields = "created_at,completed_at,completed";
  var tasks = [], offset = null;
  while (true) {
    var url = "/tasks?project=" + projectGid + "&completed_since=" + since.toISOString() + "&opt_fields=" + fields + "&limit=100";
    if (offset) url += "&offset=" + offset;
    var data = await asanaFetch(url);
    tasks = tasks.concat(data.data);
    if (data.next_page) { offset = data.next_page.offset; } else { break; }
  }
  return tasks;
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

// ── Trend Chart ───────────────────────────────────────────────────────────────

function buildWeekBuckets(numWeeks) {
  var buckets = [];
  var now = today0();
  for (var i = numWeeks - 1; i >= 0; i--) {
    var wStart = new Date(now);
    wStart.setDate(now.getDate() - (i * 7));
    wStart = weekStart(wStart);
    var wEnd = new Date(wStart);
    wEnd.setDate(wStart.getDate() + 7);
    buckets.push({ start: wStart, end: wEnd, label: fmtWeekLabel(wStart), added: 0, completed: 0 });
  }
  return buckets;
}

function bucketTasks(tasks, buckets) {
  tasks.forEach(function(t) {
    // Count as "added" in the week it was created
    if (t.created_at) {
      var created = new Date(t.created_at);
      for (var i = 0; i < buckets.length; i++) {
        if (created >= buckets[i].start && created < buckets[i].end) {
          buckets[i].added++;
          break;
        }
      }
    }
    // Count as "completed" in the week it was completed
    if (t.completed && t.completed_at) {
      var completed = new Date(t.completed_at);
      for (var i = 0; i < buckets.length; i++) {
        if (completed >= buckets[i].start && completed < buckets[i].end) {
          buckets[i].completed++;
          break;
        }
      }
    }
  });
  return buckets;
}

function drawChart(buckets, propName, numWeeks) {
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

  // Colors
  var colAdded     = "#2563eb";
  var colCompleted = "#16a34a";
  var colGrid      = "#dde3ea";
  var colText      = "#64748b";
  var colTextBright= "#475569";

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

  // Bars
  for (var i = 0; i < n; i++) {
    var xBase = PAD_LEFT + i * barGroupW + barGroupW * 0.1;

    // Added bar
    var hAdded = (added[i] / yMax) * chartH;
    var xAdded = xBase;
    var yAdded = PAD_TOP + chartH - hAdded;
    ctx.fillStyle = colAdded;
    ctx.globalAlpha = 0.85;
    if (hAdded > 0) ctx.fillRect(xAdded, yAdded, barW, hAdded);

    // Completed bar
    var hComp = (completed[i] / yMax) * chartH;
    var xComp = xBase + barW + gap;
    var yComp = PAD_TOP + chartH - hComp;
    ctx.fillStyle = colCompleted;
    ctx.globalAlpha = 0.85;
    if (hComp > 0) ctx.fillRect(xComp, yComp, barW, hComp);

    ctx.globalAlpha = 1.0;

    // Value labels on bars
    ctx.font = "bold 9px 'Share Tech Mono', monospace";
    ctx.textAlign = "center";
    if (added[i] > 0) {
      ctx.fillStyle = colAdded;
      ctx.fillText(added[i], xAdded + barW / 2, yAdded - 4);
    }
    if (completed[i] > 0) {
      ctx.fillStyle = colCompleted;
      ctx.fillText(completed[i], xComp + barW / 2, yComp - 4);
    }

    // X label — every other week to avoid crowding
    if (i % 2 === 0 || i === n - 1) {
      ctx.fillStyle = colTextBright;
      ctx.font = "9px 'Share Tech Mono', monospace";
      ctx.textAlign = "center";
      ctx.fillText(labels[i], PAD_LEFT + i * barGroupW + barGroupW / 2, H - 10);
    }

    // Highlight current week column
    if (i === n - 1) {
      ctx.fillStyle = "rgba(180,83,9,0.08)";
      ctx.fillRect(PAD_LEFT + i * barGroupW, PAD_TOP, barGroupW, chartH);
      ctx.fillStyle = "#b45309";
      ctx.font = "8px 'Share Tech Mono', monospace";
      ctx.textAlign = "center";
      ctx.fillText("THIS WEEK", PAD_LEFT + i * barGroupW + barGroupW / 2, PAD_TOP + 10);
    }
  }

  // Trend line — net (added - completed) rolling
  ctx.strokeStyle = "rgba(180,83,9,0.5)";
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

  // Summary stats
  var totalAdded     = added.reduce(function(a,b) { return a+b; }, 0);
  var totalCompleted = completed.reduce(function(a,b) { return a+b; }, 0);
  var avgAdded       = Math.round(totalAdded / n * 10) / 10;
  var avgCompleted   = Math.round(totalCompleted / n * 10) / 10;
  var net            = totalAdded - totalCompleted;

  document.getElementById("stat-avg-added").textContent     = avgAdded;
  document.getElementById("stat-avg-completed").textContent = avgCompleted;

  var periodLabel = numWeeks <= 12 ? numWeeks + "-Wk" : (numWeeks === 26 ? "6-Mo" : "1-Yr");

  var trendEl = document.getElementById("stat-trend");
  if (net > 0) {
    trendEl.textContent = "+" + net;
    trendEl.style.color = "var(--danger)";
    trendEl.nextElementSibling.textContent = "Net Backlog Growth (" + periodLabel + ")";
  } else if (net < 0) {
    trendEl.textContent = net;
    trendEl.style.color = "var(--success)";
    trendEl.nextElementSibling.textContent = "Net Backlog Reduction (" + periodLabel + ")";
  } else {
    trendEl.textContent = "Even";
    trendEl.style.color = "var(--text-dim)";
    trendEl.nextElementSibling.textContent = "No Net Change (" + periodLabel + ")";
  }

  document.getElementById("chartSummary").style.display = "grid";
}

async function loadTrendChart(prop, numWeeks) {
  numWeeks = numWeeks || currentWeeks;
  currentTrendProp = prop;
  var panel = document.getElementById("chartPanel");
  if (!prop.gid) {
    panel.classList.add("visible");
    document.getElementById("chartContent").innerHTML = '<div class="chart-loading">Not connected to Asana yet.</div>';
    document.getElementById("chartSummary").style.display = "none";
    setTimeout(function() { panel.classList.add("loaded"); }, 50);
    return;
  }
  var cacheKey = prop.code + "-" + numWeeks;
  panel.classList.add("visible");
  panel.classList.remove("loaded");
  document.getElementById("chartContent").innerHTML = '<div class="chart-loading">Fetching ' + numWeeks + ' weeks of data…</div>';
  document.getElementById("chartSummary").style.display = "none";

  if (trendDataCache[cacheKey]) {
    drawChart(trendDataCache[cacheKey], prop.name, numWeeks);
    setTimeout(function() { panel.classList.add("loaded"); }, 50);
    return;
  }

  try {
    var tasks = await getAllTasksForTrend(prop.gid, numWeeks);
    var buckets = buildWeekBuckets(numWeeks);
    bucketTasks(tasks, buckets);
    trendDataCache[cacheKey] = buckets;
    drawChart(buckets, prop.name, numWeeks);
    setTimeout(function() { panel.classList.add("loaded"); }, 50);
  } catch(err) {
    document.getElementById("chartContent").innerHTML =
      '<div style="font-size:11px;color:var(--danger);text-align:center;padding:40px 0">Failed to load trend data: ' + err.message + '</div>';
    panel.classList.add("loaded");
  }
}

function hideTrendChart() {
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
        '<div class="property-code">' + prop.code + '</div>' +
        '<div class="property-name">' + prop.name + '</div>' +
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
  if (!prop.gid) {
    var pill = document.getElementById("pill-" + prop.code);
    if (pill) { pill.textContent = "Not Connected"; pill.className = "card-status-pill pill-alert"; }
    var woList = document.getElementById("wo-list-" + prop.code);
    if (woList) { woList.innerHTML = '<div style="font-size:11px;color:var(--text-muted)">This facility isn\'t connected to Asana yet — add its Asana IDs on the Admin tab to see Work Orders here.</div>'; }
    return;
  }
  try {
    var results = await Promise.all([
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
          return '<li class="overdue-item"><div class="overdue-dot"></div><div class="overdue-name">' + t.name + '</div>' +
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
          return '<li class="overdue-item"><div class="overdue-dot" style="background:var(--accent2)"></div><div class="overdue-name">' + t.name + '</div></li>';
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
              '<div class="rt-room-name">' + t.name + '</div>' +
              (due  ? '<div class="rt-room-due' + (due.overdue ? ' overdue' : '') + '">Due ' + due.label + (due.overdue ? ' — OVERDUE' : '') + '</div>' : '') +
              (note ? '<div class="rt-room-note">' + note + '</div>' : '') +
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
    if (woList) { woList.innerHTML = '<div style="font-size:11px;color:var(--danger)">Failed to load: ' + err.message + '</div>'; }
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
  trendDataCache = {};
  currentTrendProp = null;
  currentWeeks = 12;
  document.querySelectorAll(".range-btn").forEach(function(b) { b.classList.remove("active"); });
  var defaultBtn = document.querySelector(".range-btn[data-weeks='12']");
  if (defaultBtn) defaultBtn.classList.add("active");
  document.getElementById("grid").innerHTML = "";
  hideTrendChart();
  setStatus("Connecting to Asana API…", "loading");
  visibleProperties().forEach(function(prop, i) { buildCard(prop, i); });
  setStatus("Fetching data for all properties…", "loading");
  await Promise.all(visibleProperties().map(function(prop) { return loadCard(prop); }));
  var now = new Date();
  document.getElementById("lastUpdated").textContent =
    "Updated " + now.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
    " at " + now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  setStatus("✓ All properties loaded", "done");
  document.getElementById("viewSelector").style.display = "flex";
  // Re-apply current view selection if already on a single property
  var sel = document.getElementById("viewSelect").value;
  if (sel !== "all") applyView(sel);
  setTimeout(function() { setStatus(""); }, 3000);
}
