// Building Compliance tab: pulls overdue and upcoming compliance tasks per
// community from Asana (via the asana-proxy Supabase Edge Function), the
// same way the Work Orders tab does. View-only — nothing here can be edited.

function complianceDaysOverdue(due) {
  var today = today0();
  return Math.round((today - new Date(due)) / 86400000);
}

function complianceFmtDue(due) {
  return new Date(due).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

async function getComplianceTasks(sectionGid) {
  var fields = "name,due_on,completed";
  var tasks = [], offset = null;
  while (true) {
    var url = "/tasks?section=" + sectionGid + "&opt_fields=" + fields + "&limit=100";
    if (offset) url += "&offset=" + offset;
    var data = await asanaFetch(url);
    tasks = tasks.concat(data.data);
    if (data.next_page) { offset = data.next_page.offset; } else { break; }
  }
  return tasks.filter(function(t) { return !t.completed; });
}

function buildComplianceCard(prop, index) {
  var card = document.createElement("div");
  card.className = "card";
  card.id = "compliance-card-" + prop.code;
  card.innerHTML =
    '<div class="card-header">' +
      '<div>' +
        '<div class="property-code">' + prop.code + '</div>' +
        '<div class="property-name">' + prop.name + '</div>' +
      '</div>' +
      '<div class="card-status-pill pill-loading" id="compliance-pill-' + prop.code + '">Loading…</div>' +
    '</div>' +
    '<div class="metrics">' +
      '<div class="metric"><div class="metric-value" id="compliance-overdue-' + prop.code + '">—</div><div class="metric-label">Overdue</div></div>' +
      '<div class="metric"><div class="metric-value" id="compliance-upcoming-' + prop.code + '">—</div><div class="metric-label">Due Next<br>30 Days</div></div>' +
    '</div>' +
    '<div class="section-block">' +
      '<div class="section-title">Overdue</div>' +
      '<div id="compliance-overdue-list-' + prop.code + '"><div class="skeleton" style="height:12px;width:80%;margin-bottom:6px;"></div><div class="skeleton" style="height:12px;width:60%;"></div></div>' +
    '</div>' +
    '<div class="section-block">' +
      '<div class="section-title">Due in Next 30 Days</div>' +
      '<div id="compliance-upcoming-list-' + prop.code + '"><div class="skeleton" style="height:12px;width:70%;"></div></div>' +
    '</div>';

  document.getElementById("complianceGrid").appendChild(card);
  setTimeout(function() { card.classList.add("loaded"); }, 50 + index * 80);
}

async function loadComplianceCard(prop) {
  if (!prop.complianceGid) {
    var pill = document.getElementById("compliance-pill-" + prop.code);
    if (pill) { pill.textContent = "Not Connected"; pill.className = "card-status-pill pill-alert"; }
    var list = document.getElementById("compliance-overdue-list-" + prop.code);
    if (list) { list.innerHTML = '<div style="font-size:11px;color:var(--text-muted)">This facility isn\'t connected to the compliance board yet — add its Asana section ID on the Admin tab.</div>'; }
    var upcoming = document.getElementById("compliance-upcoming-list-" + prop.code);
    if (upcoming) upcoming.innerHTML = "";
    return;
  }
  try {
    var tasks = await getComplianceTasks(prop.complianceGid);
    var now = today0();
    var in30 = new Date(now); in30.setDate(in30.getDate() + 30);

    var overdue = tasks
      .filter(function(t) { return t.due_on && new Date(t.due_on) < now; })
      .sort(function(a, b) { return new Date(a.due_on) - new Date(b.due_on); });

    var upcoming = tasks
      .filter(function(t) { return t.due_on && new Date(t.due_on) >= now && new Date(t.due_on) <= in30; })
      .sort(function(a, b) { return new Date(a.due_on) - new Date(b.due_on); });

    document.getElementById("compliance-overdue-" + prop.code).textContent = overdue.length;
    document.getElementById("compliance-upcoming-" + prop.code).textContent = upcoming.length;

    var overdueEl = document.getElementById("compliance-overdue-" + prop.code);
    overdueEl.className = "metric-value " + (overdue.length === 0 ? "success" : overdue.length <= 3 ? "warn" : "danger");

    var card = document.getElementById("compliance-card-" + prop.code);
    var pill = document.getElementById("compliance-pill-" + prop.code);
    if (overdue.length === 0) {
      card.classList.add("all-clear");
      pill.textContent = "All Clear"; pill.className = "card-status-pill pill-ok";
    } else {
      if (overdue.length > 3) card.classList.add("has-overdue");
      pill.textContent = overdue.length + " Overdue";
      pill.className = "card-status-pill " + (overdue.length <= 3 ? "pill-warn" : "pill-alert");
    }

    var overdueListEl = document.getElementById("compliance-overdue-list-" + prop.code);
    overdueListEl.innerHTML = overdue.length === 0
      ? '<div class="no-overdue">✓ No overdue items</div>'
      : '<ul class="overdue-list">' + overdue.map(function(t) {
          return '<li class="overdue-item"><div class="overdue-dot"></div><div class="overdue-name">' + t.name + '</div>' +
            '<div style="font-family:\'Share Tech Mono\',monospace;font-size:10px;color:var(--text-dim);white-space:nowrap">' + complianceDaysOverdue(t.due_on) + 'd overdue</div></li>';
        }).join("") + '</ul>';

    var upcomingListEl = document.getElementById("compliance-upcoming-list-" + prop.code);
    upcomingListEl.innerHTML = upcoming.length === 0
      ? '<div class="no-overdue">✓ Nothing due soon</div>'
      : '<ul class="overdue-list">' + upcoming.map(function(t) {
          return '<li class="overdue-item"><div class="overdue-dot" style="background:var(--accent2)"></div><div class="overdue-name">' + t.name + '</div>' +
            '<div style="font-family:\'Share Tech Mono\',monospace;font-size:10px;color:var(--text-dim);white-space:nowrap">Due ' + complianceFmtDue(t.due_on) + '</div></li>';
        }).join("") + '</ul>';

  } catch (err) {
    console.error(prop.code, err);
    var pill = document.getElementById("compliance-pill-" + prop.code);
    if (pill) { pill.textContent = "Error"; pill.className = "card-status-pill pill-alert"; }
    var list = document.getElementById("compliance-overdue-list-" + prop.code);
    if (list) { list.innerHTML = '<div style="font-size:11px;color:var(--danger)">Failed to load: ' + err.message + '</div>'; }
  }
}

async function loadComplianceData() {
  document.getElementById("complianceGrid").innerHTML = "";
  visibleProperties().forEach(function(prop, i) { buildComplianceCard(prop, i); });
  await Promise.all(visibleProperties().map(function(prop) { return loadComplianceCard(prop); }));
}
