// Projects & CapEx tab: annual budgets, projects, expenses, to-dos,
// approvals, receipts, and CSV export.


// ── CapEx: Projects / Expenses / To-Dos (Supabase) ───────────────────────────

let capexPropertyFilter = "all";
let capexProjectView = "active"; // "active" | "completed"
let capexData = { projects: [], expenses: [], todos: [], annualBudgets: [] };

var PROJ_TYPE_LABEL = { improvement: "Improvement", repair_replacement: "Repair/Replacement" };
var EXP_CATEGORY_LABEL = { improvement: "Improvement", repair_replacement: "Repair/Replacement", other: "Other" };

function currentYear() { return new Date().getFullYear(); }

// Two horizontal bars (Budget, Actual) scaled to whichever value is larger.
function barsCompareRows(budget, actual) {
  var maxVal = Math.max(budget, actual, 1);
  var budgetPct = Math.round(budget / maxVal * 100);
  var actualPct = Math.round(actual / maxVal * 100);
  var over = budget > 0 && actual > budget;
  return '<div class="bar-row"><div class="bar-row-label">Budget</div><div class="bar-track"><div class="bar-fill budget" style="width:' + budgetPct + '%"></div></div><div class="bar-row-value">$' + budget.toLocaleString() + '</div></div>' +
    '<div class="bar-row"><div class="bar-row-label">Actual</div><div class="bar-track"><div class="bar-fill actual' + (over ? ' over' : '') + '" style="width:' + actualPct + '%"></div></div><div class="bar-row-value">$' + actual.toLocaleString() + '</div></div>';
}

function barsCompareHtml(budget, actual) {
  return '<div class="bars-compare">' + barsCompareRows(budget, actual) + '</div>';
}
















function applyCapexPropertyFilter(val) {
  capexPropertyFilter = val;
  renderProjects();
  renderExpenses();
}


async function loadCapexData() {
  await Promise.all([loadProjects(), loadExpenses(), loadTodos(), loadAnnualBudgets()]);
}

async function loadProjects() {
  var res = await sb.from("projects").select("*").order("created_at", { ascending: false });
  if (res.error) { console.error(res.error); return; }
  capexData.projects = res.data;
  populateProjectSelects();
  renderProjects();
}

async function loadExpenses() {
  var res = await sb.from("expenses").select("*").order("expense_date", { ascending: false });
  if (res.error) { console.error(res.error); return; }
  capexData.expenses = res.data;
  renderExpenses();
  renderProjects();
}

async function loadTodos() {
  var res = await sb.from("todos").select("*").order("due_date", { ascending: true });
  if (res.error) { console.error(res.error); return; }
  capexData.todos = res.data;
  renderProjects();
}

async function loadAnnualBudgets() {
  var res = await sb.from("annual_budgets").select("*");
  if (res.error) { console.error(res.error); return; }
  capexData.annualBudgets = res.data;
  renderProjects();
}


// The Add Expense project list only ever shows projects for whichever property is
// currently selected in that same form — otherwise it's easy to log an expense
// against the wrong community's project.
function populateProjectSelects() {
  var sel = document.getElementById("expProjectInput");
  var propCode = document.getElementById("expPropertyInput").value;
  var current = sel.value;
  var options = capexData.projects.filter(function(p) { return p.property_code === propCode && p.status !== "completed"; });
  sel.innerHTML = '<option value="">— None —</option>' +
    options.map(function(p) { return '<option value="' + p.id + '">' + p.name + '</option>'; }).join("");
  sel.value = options.some(function(p) { return p.id === current; }) ? current : "";
}

function projectsForFilter() {
  return capexData.projects.filter(function(p) { return capexPropertyFilter === "all" || p.property_code === capexPropertyFilter; });
}

function spentForProject(projectId) {
  return capexData.expenses
    .filter(function(e) { return e.project_id === projectId; })
    .reduce(function(s, e) { return s + Number(e.amount); }, 0);
}

// While viewing one community, lock the Add Project / Add Expense property pickers
// to that community so entries can't accidentally land on the wrong property.
function syncFormPropertyLocks() {
  var locked = capexPropertyFilter !== "all";
  ["projPropertyInput", "expPropertyInput"].forEach(function(id) {
    var el = document.getElementById(id);
    if (locked) { el.value = capexPropertyFilter; }
    el.disabled = locked;
  });
  populateProjectSelects();
}

function renderProjects() {
  var isAll = capexPropertyFilter === "all";
  var showingCompleted = capexProjectView === "completed";
  syncFormPropertyLocks();

  document.getElementById("projectsPanel").style.display = showingCompleted ? "none" : "";
  document.getElementById("expensesPanel").style.display = showingCompleted ? "none" : "";
  document.getElementById("propertyFinancialPanel").style.display = (isAll && !showingCompleted) ? "" : "none";
  document.getElementById("annualBudgetPanel").style.display = (!isAll && !showingCompleted) ? "" : "none";
  document.getElementById("projectCards").style.display = (!isAll && !showingCompleted) ? "" : "none";
  document.getElementById("completedProjectsPanel").style.display = showingCompleted ? "" : "none";

  if (showingCompleted) {
    renderCompletedProjects();
  } else if (isAll) {
    renderPropertyFinancialOverview();
  } else {
    renderProjectBoxes();
    renderAnnualBudgetBar();
  }
}

// "All Properties" view — a financial-only readout, one box per property.
// This year's spending for a property, split by each expense's own category —
// not the linked project's type — so the category picked on the expense itself is
// what drives the bar (fixes categories like "Landscaping" not showing up anywhere).
function annualActualBreakdown(propertyCode, year) {
  var improveAmt = 0, repairAmt = 0, otherAmt = 0;
  capexData.expenses.forEach(function(e) {
    if (e.property_code !== propertyCode) return;
    if (!e.expense_date || e.expense_date.slice(0, 4) !== String(year)) return;
    var amt = Number(e.amount);
    if (e.category === "improvement") improveAmt += amt;
    else if (e.category === "repair_replacement") repairAmt += amt;
    else otherAmt += amt;
  });
  return { improveAmt: improveAmt, repairAmt: repairAmt, otherAmt: otherAmt };
}

function renderPropertyFinancialOverview() {
  var year = currentYear();
  var container = document.getElementById("propertyFinancialGrid");
  container.innerHTML = PROPERTIES.map(function(prop) {
    var projects = capexData.projects.filter(function(p) { return p.property_code === prop.code && p.status !== "completed"; });
    var rows = projects.length === 0
      ? '<div class="rt-empty">No active projects.</div>'
      : projects.map(function(p) {
          var spent = spentForProject(p.id);
          var budget = Number(p.budget) || 0;
          var remaining = Math.max(0, budget - spent);
          return '<div class="property-financial-row type-stripe ' + p.project_type + '">' +
            '<div class="property-financial-name">' +
              '<span class="type-badge ' + p.project_type + '">' + (PROJ_TYPE_LABEL[p.project_type] || p.project_type) + '</span>' +
              '<span>' + p.name + '</span>' +
            '</div>' +
            barsCompareHtml(budget, spent) +
            '<div class="budget-label" style="margin-top:6px"><span>$' + spent.toLocaleString() + ' spent</span><span>$' + remaining.toLocaleString() + ' remaining</span></div>' +
          '</div>';
        }).join("");

    var budgetRow = capexData.annualBudgets.find(function(b) { return b.property_code === prop.code && b.year === year; });
    var annualBudget = budgetRow ? Number(budgetRow.budget) : 0;
    var breakdown = annualActualBreakdown(prop.code, year);
    var notice = annualBudget === 0
      ? '<div class="no-overdue" style="color:var(--text-muted);margin-bottom:8px;">No ' + year + ' budget set.</div>'
      : '';

    return '<div class="property-financial-box">' +
      '<div class="property-financial-header"><span>' + prop.name + '</span><span class="property-annual-summary muted">' + year + ' CapEx</span></div>' +
      '<div class="property-annual-bar">' + notice + annualBudgetBarsHtml(annualBudget, breakdown.improveAmt, breakdown.repairAmt, breakdown.otherAmt) + '</div>' +
      rows +
    '</div>';
  }).join("");
}

// Single-property view — one box per project.
function renderProjectBoxes() {
  var container = document.getElementById("projectCards");
  var list = projectsForFilter().filter(function(p) { return p.status !== "completed"; });
  if (list.length === 0) { container.innerHTML = '<div class="no-overdue" style="color:var(--text-muted)">No active projects.</div>'; return; }

  function todoRow(t) {
    return '<div class="rt-room' + (t.completed ? ' is-done' : '') + '">' +
      '<label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;">' +
        '<input type="checkbox" ' + (t.completed ? 'checked' : '') + ' onchange="toggleTodo(\'' + t.id + '\', this.checked)" />' +
        '<span><div class="rt-room-name">' + t.title + '</div>' +
        (t.due_date ? '<div class="rt-room-due">Due ' + t.due_date + '</div>' : '') +
        '</span>' +
      '</label>' +
    '</div>';
  }

  container.innerHTML = list.map(function(p) {
    var spent = spentForProject(p.id);
    var budget = Number(p.budget) || 0;
    var todos = capexData.todos.filter(function(t) { return t.project_id === p.id; });
    var openTodos = todos.filter(function(t) { return !t.completed; });
    var doneTodos = todos.filter(function(t) { return t.completed; });

    return '<div class="project-card type-stripe ' + p.project_type + '">' +
      approveRowHtml(p) +
      '<span class="type-badge ' + p.project_type + '">' + (PROJ_TYPE_LABEL[p.project_type] || p.project_type) + '</span>' +
      barsCompareHtml(budget, spent) +
      budgetEditHtml(p, budget) +
      projectNameHtml(p) +
      '<textarea class="project-card-description" placeholder="Describe this project…" onblur="saveProjectDescription(\'' + p.id + '\', this.value)">' + (p.description || '') + '</textarea>' +
      '<label class="project-card-complete"><input type="checkbox" onclick="event.preventDefault(); handleMarkCompleteClick(\'' + p.id + '\'); return false;" /> Mark Complete</label>' +
      '<div class="project-card-todos">' +
        (openTodos.length ? openTodos.map(todoRow).join("") : '<div class="rt-empty">No open to-dos</div>') +
        doneTodos.map(todoRow).join("") +
        '<div class="project-todo-add">' +
          '<input type="text" placeholder="Add a to-do…" id="projTodoInput-' + p.id + '" onkeydown="if(event.key===\'Enter\') addProjectTodo(\'' + p.id + '\', \'' + p.property_code + '\')" />' +
          '<button type="button" onclick="addProjectTodo(\'' + p.id + '\', \'' + p.property_code + '\')">+ Add</button>' +
        '</div>' +
      '</div>' +
      '<div class="project-card-receipts">' +
        '<div class="section-title" style="font-size:10px;margin-bottom:8px;">Receipts</div>' +
        '<div id="receipts-' + p.id + '"><div class="skeleton" style="height:16px;width:60%;"></div></div>' +
        '<div class="project-todo-add">' +
          '<input type="file" accept="image/*,.pdf" id="receiptInput-' + p.id + '" style="display:none" onchange="uploadReceipt(\'' + p.id + '\', this)" />' +
          '<button type="button" style="width:100%" onclick="document.getElementById(\'receiptInput-' + p.id + '\').click()">+ Upload Receipts / Bids</button>' +
        '</div>' +
        '<div class="project-todo-add" style="margin-top:6px;">' +
          '<button type="button" style="width:100%" onclick="downloadAllDocuments(\'' + p.id + '\', this)">&#8681; Download All Documents</button>' +
        '</div>' +
      '</div>' +
      '<div class="project-card-receipts">' +
        historyToggleHtml(p.id, "history") +
      '</div>' +
    '</div>';
  }).join("");

  list.forEach(function(p) { loadProjectReceipts(p.id); });
}



// The "Approved" checkbox + (once approved) the who/where/when/file readout.
// Checking it opens the approval popup; unchecking it asks for confirmation and
// clears these live fields — the permanent record stays in the project's History.
// A project not yet approved also gets a "Deny" button next to the checkbox; once
// denied, the checkbox is replaced with a matching denial readout and an "Un-deny"
// link, so a project is only ever approved or denied, never both at once.
function approveRowHtml(p) {
  if (p.denied) {
    var denyFileLink = p.denial_file_path
      ? ' — <a href="#" data-path="' + escapeHtml(p.denial_file_path) + '" onclick="viewStoredFile(event, this, \'approvals\')">View file</a>'
      : "";
    return '<div style="display:flex;align-items:center;gap:10px;">' +
        '<div class="approve-row is-denied">Denied</div>' +
        '<button type="button" class="table-action-btn" onclick="handleUndenyClick(\'' + p.id + '\')">Un-deny</button>' +
      '</div>' +
      '<div class="approved-info">By ' + escapeHtml(p.denied_by) + ' — ' + escapeHtml(p.denied_location) +
        ' — ' + (p.denied_date ? formatDateOnly(p.denied_date) : "—") + denyFileLink + '</div>';
  }

  var rowClass = p.approved ? "approve-row is-approved" : "approve-row";
  var html = '<div style="display:flex;align-items:center;gap:10px;">' +
    '<label class="' + rowClass + '"><input type="checkbox" ' + (p.approved ? "checked" : "") +
      ' onclick="event.preventDefault(); handleApprovalToggle(\'' + p.id + '\'); return false;" /> Approved</label>' +
    (p.approved ? '' : '<button type="button" class="table-action-btn" onclick="handleDenyClick(\'' + p.id + '\')">Deny</button>') +
    '</div>';
  if (p.approved) {
    var fileLink = p.approval_file_path
      ? ' — <a href="#" data-path="' + escapeHtml(p.approval_file_path) + '" onclick="viewStoredFile(event, this, \'approvals\')">View file</a>'
      : "";
    html += '<div class="approved-info">By ' + escapeHtml(p.approved_by) + ' — ' + escapeHtml(p.approved_location) +
      ' — ' + (p.approved_date ? formatDateOnly(p.approved_date) : "—") + fileLink + '</div>';
  }
  return html;
}

// Project name — click "Edit" to fix a typo or rename after something shifts.
// Name-only edit, on the active project card; not editable from Completed Projects.
function projectNameHtml(p) {
  return '<div class="project-card-name" id="nameRow-' + p.id + '" style="margin-top:4px;display:flex;align-items:center;gap:8px;">' +
      '<span>' + escapeHtml(p.name) + '</span>' +
      '<button type="button" class="budget-edit-link" onclick="startEditName(\'' + p.id + '\')">Edit</button>' +
    '</div>' +
    '<div class="budget-edit-form" id="nameForm-' + p.id + '" style="display:none;margin-top:4px;">' +
      '<input class="config-input" type="text" id="nameInput-' + p.id + '" value="' + escapeHtml(p.name) + '" />' +
      '<div class="budget-edit-form-actions">' +
        '<button type="button" class="config-btn" onclick="saveProjectName(\'' + p.id + '\')">Save</button>' +
        '<button type="button" class="modal-cancel-btn" onclick="cancelEditName(\'' + p.id + '\')">Cancel</button>' +
      '</div>' +
    '</div>';
}

function startEditName(id) {
  document.getElementById("nameRow-" + id).style.display = "none";
  document.getElementById("nameForm-" + id).style.display = "flex";
}

function cancelEditName(id) {
  document.getElementById("nameRow-" + id).style.display = "";
  document.getElementById("nameForm-" + id).style.display = "none";
}

async function saveProjectName(id) {
  if (!requireEditAccess()) return;
  var input = document.getElementById("nameInput-" + id);
  var newVal = input.value.trim();
  if (!newVal) { alert("Enter a project name."); return; }
  var p = capexData.projects.find(function(pr) { return pr.id === id; });
  if (newVal === p.name) { cancelEditName(id); return; }
  var res = await sb.from("projects").update({ name: newVal }).eq("id", id);
  if (res.error) { alert("Failed to update name: " + res.error.message); return; }
  await loadProjects();
}

// Budget is only editable from the active project card, not from Completed Projects.
function budgetEditHtml(p, budget) {
  return '<div class="budget-edit-row" id="budgetRow-' + p.id + '"><button type="button" class="budget-edit-link" onclick="startEditBudget(\'' + p.id + '\')">Edit Budget</button></div>' +
    '<div class="budget-edit-form" id="budgetForm-' + p.id + '" style="display:none;">' +
      '<input class="config-input" type="number" step="0.01" id="budgetInput-' + p.id + '" value="' + budget + '" />' +
      '<div class="budget-edit-form-actions">' +
        '<button type="button" class="config-btn" onclick="saveProjectBudget(\'' + p.id + '\')">Save</button>' +
        '<button type="button" class="modal-cancel-btn" onclick="cancelEditBudget(\'' + p.id + '\')">Cancel</button>' +
      '</div>' +
    '</div>';
}

// Shared by both the active project cards and the Completed Projects list — "prefix"
// keeps their container element ids from colliding when the same project shows up
// nowhere near each other in the DOM.
function historyToggleHtml(id, prefix) {
  return '<div class="section-title history-toggle" style="font-size:10px;margin-bottom:8px;" onclick="toggleProjectHistory(\'' + id + '\', \'' + prefix + '\')">History ▾</div>' +
    '<div id="' + prefix + '-' + id + '" style="display:none;"></div>';
}

// History — completed projects only, read-only aside from moving back to active.
function completedProjectsForFilter() {
  return capexData.projects
    .filter(function(p) { return p.status === "completed" && (capexPropertyFilter === "all" || p.property_code === capexPropertyFilter); })
    .sort(function(a, b) { return new Date(b.completed_at || 0) - new Date(a.completed_at || 0); });
}

function renderCompletedProjects() {
  var tbody = document.getElementById("completedProjectsBody");
  var list = completedProjectsForFilter();
  if (list.length === 0) { tbody.innerHTML = '<tr><td colspan="8" style="color:var(--text-muted)">No completed projects yet.</td></tr>'; return; }
  var propName = {};
  PROPERTIES.forEach(function(pr) { propName[pr.code] = pr.name; });

  tbody.innerHTML = list.map(function(p) {
    var spent = spentForProject(p.id);
    var budget = Number(p.budget) || 0;
    var over = budget > 0 && spent > budget;
    var completedDate = p.completed_at
      ? new Date(p.completed_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
      : "—";
    return '<tr>' +
      '<td>' + (propName[p.property_code] || p.property_code) + '</td>' +
      '<td><span class="type-badge ' + p.project_type + '">' + (PROJ_TYPE_LABEL[p.project_type] || p.project_type) + '</span></td>' +
      '<td>' + p.name + '</td>' +
      '<td style="text-align:right">$' + budget.toLocaleString() + '</td>' +
      '<td style="text-align:right' + (over ? ';color:var(--danger);font-weight:700' : '') + '">$' + spent.toLocaleString() + (over ? ' <span style="font-size:9px;">(OVER)</span>' : '') + '</td>' +
      '<td>' + completedDate + '</td>' +
      '<td>' + approveRowHtml(p) + '</td>' +
      '<td style="display:flex;gap:6px;">' +
        '<button type="button" class="table-action-btn" onclick="toggleCompletedReceipts(\'' + p.id + '\')">Receipts</button>' +
        '<button type="button" class="table-action-btn" onclick="toggleCompletedHistory(\'' + p.id + '\')">History</button>' +
        '<button type="button" class="table-action-btn" onclick="downloadAllDocuments(\'' + p.id + '\', this)">Download All</button>' +
        '<button type="button" class="table-action-btn" onclick="toggleProjectComplete(\'' + p.id + '\', false)">Move Back to Active</button>' +
      '</td>' +
    '</tr>' +
    '<tr id="completed-receipts-row-' + p.id + '" style="display:none;">' +
      '<td colspan="8" style="background:var(--bg);">' +
        '<div id="completed-receipts-' + p.id + '"><div class="skeleton" style="height:16px;width:200px;"></div></div>' +
      '</td>' +
    '</tr>' +
    '<tr id="completed-history-row-' + p.id + '" style="display:none;">' +
      '<td colspan="8" style="background:var(--bg);">' +
        '<div id="completed-history-' + p.id + '"></div>' +
      '</td>' +
    '</tr>';
  }).join("");
}

function toggleCompletedReceipts(projectId) {
  var row = document.getElementById("completed-receipts-row-" + projectId);
  if (!row) return;
  var isHidden = row.style.display === "none" || !row.style.display;
  row.style.display = isHidden ? "table-row" : "none";
  if (isHidden) loadProjectReceipts(projectId, "completed-receipts-" + projectId);
}

function toggleCompletedHistory(projectId) {
  var row = document.getElementById("completed-history-row-" + projectId);
  if (!row) return;
  var isHidden = row.style.display === "none" || !row.style.display;
  row.style.display = isHidden ? "table-row" : "none";
  if (isHidden) loadProjectHistory(projectId, "completed-history-" + projectId);
}


// Completed Projects export — CSV download (Google Sheets: File > Import > Upload).
// Attachments are summarized as a single Yes/No rather than included, since the
// files themselves live in Supabase storage, not something a spreadsheet can hold.
async function exportCompletedProjectsCSV(btnEl) {
  var list = completedProjectsForFilter();
  if (list.length === 0) { alert("No completed projects to export yet."); return; }

  var originalText = btnEl.textContent;
  btnEl.disabled = true;
  btnEl.textContent = "Exporting…";

  try {
    var propName = {};
    PROPERTIES.forEach(function(pr) { propName[pr.code] = pr.name; });

    var hasAttachments = await Promise.all(list.map(async function(p) {
      var res = await sb.storage.from("receipts").list(p.id);
      var hasReceipts = (res.data || []).length > 0;
      return hasReceipts || !!p.approval_file_path;
    }));

    var header = ["Property", "Project Type", "Project Name", "Description", "Budget", "Amount Spent", "Over Budget", "Completed Date", "Approved", "Approved By", "Approved Location", "Approved Date", "Has Attachments"];
    var rows = list.map(function(p, i) {
      var spent = spentForProject(p.id);
      var budget = Number(p.budget) || 0;
      var over = budget > 0 && spent > budget;
      var completedDate = p.completed_at
        ? new Date(p.completed_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
        : "";
      return [
        propName[p.property_code] || p.property_code,
        PROJ_TYPE_LABEL[p.project_type] || p.project_type,
        p.name,
        p.description || "",
        budget,
        spent,
        over ? "Yes" : "No",
        completedDate,
        p.approved ? "Yes" : "No",
        p.approved ? (p.approved_by || "") : "",
        p.approved ? (p.approved_location || "") : "",
        p.approved && p.approved_date ? formatDateOnly(p.approved_date) : "",
        hasAttachments[i] ? "Yes" : "No"
      ].map(csvField).join(",");
    });

    var csv = "﻿" + [header.map(csvField).join(","), rows.join("\r\n")].join("\r\n");
    var blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    var communityLabel = capexPropertyFilter === "all" ? "All Properties" : (propName[capexPropertyFilter] || capexPropertyFilter);
    var fileSafeCommunity = communityLabel.replace(/[\\/:*?"<>|]/g, "-");
    a.download = "completed-projects-" + fileSafeCommunity + "-" + new Date().toISOString().slice(0, 10) + ".csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (e) {
    alert("Failed to export completed projects: " + e.message);
  } finally {
    btnEl.disabled = false;
    btnEl.textContent = originalText;
  }
}

// Two-color (three, counting untied "General" spending) stacked Actual bar, showing
// where CapEx money went this year rather than just how much.
function annualBudgetBarsHtml(budget, improveAmt, repairAmt, otherAmt) {
  var totalActual = improveAmt + repairAmt + otherAmt;
  var maxVal = Math.max(budget, totalActual, 1);
  var budgetPct = Math.round(budget / maxVal * 100);
  var over = budget > 0 && totalActual > budget;

  function segment(amt, cls) {
    var pct = Math.round(amt / maxVal * 100);
    if (pct <= 0) return '';
    return '<div class="bar-segment ' + cls + '" style="width:' + pct + '%">' + (pct >= 8 ? '$' + amt.toLocaleString() : '') + '</div>';
  }

  return '<div class="bar-row"><div class="bar-row-label">Budget</div><div class="bar-track"><div class="bar-fill budget" style="width:' + budgetPct + '%"></div></div><div class="bar-row-value">$' + budget.toLocaleString() + '</div></div>' +
    '<div class="bar-row"><div class="bar-row-label">Actual</div><div class="bar-track bar-track-segmented">' +
      segment(improveAmt, "seg-improve") + segment(repairAmt, "seg-repair") + segment(otherAmt, "seg-other") +
    '</div><div class="bar-row-value' + (over ? ' over-label' : '') + '">$' + totalActual.toLocaleString() + '</div></div>' +
    '<div class="chart-legend" style="margin-top:10px;">' +
      '<div class="chart-legend-item"><div class="chart-legend-swatch" style="background:var(--type-improve);"></div>Improvement</div>' +
      '<div class="chart-legend-item"><div class="chart-legend-swatch" style="background:var(--type-repair);"></div>Repair/Replacement</div>' +
      '<div class="chart-legend-item"><div class="chart-legend-swatch" style="background:var(--text-muted);"></div>Other</div>' +
    '</div>';
}

// Community-wide annual budget bar (single-property view only).
function renderAnnualBudgetBar() {
  if (capexPropertyFilter === "all") return;
  var year = currentYear();
  document.getElementById("annualBudgetYearLabel").textContent = year + " CapEx";
  var row = capexData.annualBudgets.find(function(b) { return b.property_code === capexPropertyFilter && b.year === year; });
  var budget = row ? Number(row.budget) : 0;
  document.getElementById("annualBudgetInput").value = row ? row.budget : "";

  var breakdown = annualActualBreakdown(capexPropertyFilter, year);

  var notice = budget === 0
    ? '<div class="no-overdue" style="color:var(--text-muted);margin-bottom:8px;">No ' + year + ' budget set for this property yet — enter one above.</div>'
    : '';
  document.getElementById("annualBudgetBars").innerHTML = notice + annualBudgetBarsHtml(budget, breakdown.improveAmt, breakdown.repairAmt, breakdown.otherAmt);
}

async function saveAnnualBudget() {
  if (!requireEditAccess()) return;
  if (capexPropertyFilter === "all") return;
  var val = document.getElementById("annualBudgetInput").value;
  if (!val || Number(val) <= 0) { alert("Enter a budget amount greater than 0."); return; }
  var year = currentYear();
  var propName = (PROPERTIES.find(function(p) { return p.code === capexPropertyFilter; }) || {}).name || capexPropertyFilter;
  var ok = confirm("Set " + propName + "'s " + year + " CapEx budget to $" + Number(val).toLocaleString() + "? This replaces the current amount.");
  if (!ok) return;
  var res = await sb.from("annual_budgets").upsert({
    property_code: capexPropertyFilter,
    year: year,
    budget: val,
    created_by: capexSession.user.id
  }, { onConflict: "property_code,year" });
  if (res.error) { alert("Failed to save budget: " + res.error.message); return; }
  await loadAnnualBudgets();
}

async function saveProjectDescription(id, value) {
  if (!requireEditAccess()) return;
  var res = await sb.from("projects").update({ description: value }).eq("id", id);
  if (res.error) { alert("Failed to save description: " + res.error.message); }
}

// Confirms before marking a project complete — checking this box moves it straight
// to the Completed Projects list, so a stray click shouldn't be able to do that.
function handleMarkCompleteClick(id) {
  if (!requireEditAccess()) return;
  var p = capexData.projects.find(function(pr) { return pr.id === id; });
  if (!p) return;
  var ok = confirm('Is "' + p.name + '" totally completed? Are you sure you want to mark this project as complete?');
  if (ok) toggleProjectComplete(id, true);
}

async function toggleProjectComplete(id, checked) {
  if (!requireEditAccess()) return;
  var res = await sb.from("projects").update({
    status: checked ? "completed" : "in_progress",
    completed_at: checked ? new Date().toISOString() : null
  }).eq("id", id);
  if (res.error) { alert("Failed to update: " + res.error.message); return; }
  await logProjectEvent(id, "status_changed", checked ? "Marked complete" : "Moved back to active");
  await loadProjects();
}

// Writes one permanent, never-deleted row to the project's history. Failures here are
// logged to the console rather than shown to Taylor — the underlying action (approval,
// status change, budget edit) already succeeded, so there's nothing to undo.
async function logProjectEvent(projectId, eventType, summary, metadata) {
  var res = await sb.from("project_log").insert({
    project_id: projectId,
    event_type: eventType,
    summary: summary,
    metadata: metadata || null,
    created_by: capexSession.user.id
  });
  if (res.error) { console.error("Failed to log project event:", res.error); }
}

async function loadProjectHistory(projectId, containerId) {
  var container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '<div class="skeleton" style="height:16px;width:60%;"></div>';
  var res = await sb.from("project_log").select("*").eq("project_id", projectId).order("created_at", { ascending: false });
  if (!container.isConnected) return; // view may have changed while this was in flight
  if (res.error || !res.data || res.data.length === 0) {
    container.innerHTML = '<div class="rt-empty">No history yet.</div>';
    return;
  }
  container.innerHTML = res.data.map(function(entry) {
    var when = new Date(entry.created_at).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
    var fileLink = (entry.metadata && entry.metadata.file_path)
      ? ' <a href="#" data-path="' + escapeHtml(entry.metadata.file_path) + '" onclick="viewStoredFile(event, this, \'approvals\')">View file</a>'
      : "";
    return '<div class="history-entry"><div class="history-entry-time">' + when + '</div><div class="history-entry-summary">' + escapeHtml(entry.summary) + fileLink + '</div></div>';
  }).join("");
}

function toggleProjectHistory(id, prefix) {
  var container = document.getElementById(prefix + "-" + id);
  if (!container) return;
  var isHidden = container.style.display === "none" || !container.style.display;
  container.style.display = isHidden ? "" : "none";
  if (isHidden) loadProjectHistory(id, prefix + "-" + id);
}


var currentApprovalProjectId = null;
var currentApprovalMode = "approve"; // "approve" | "deny" — which action the shared popup is currently for

function handleApprovalToggle(id) {
  if (!requireEditAccess()) return;
  var p = capexData.projects.find(function(pr) { return pr.id === id; });
  if (!p) return;
  if (p.approved) {
    var ok = confirm('Remove approval for "' + p.name + '"? This clears the approver, location, date, and file from the project — the History log keeps a permanent record either way.');
    if (ok) removeApproval(id);
  } else {
    openApprovalModal(id, "approve");
  }
}

function handleDenyClick(id) {
  if (!requireEditAccess()) return;
  openApprovalModal(id, "deny");
}

function handleUndenyClick(id) {
  if (!requireEditAccess()) return;
  var p = capexData.projects.find(function(pr) { return pr.id === id; });
  if (!p) return;
  var ok = confirm('Un-deny "' + p.name + '"? This clears the denial info from the project and lets it be approved or denied again — the History log keeps a permanent record either way.');
  if (ok) removeDenial(id);
}

// Shared by both Approve and Deny — same three questions and optional file either
// way, just relabeled and saved to different fields depending on currentApprovalMode.
function openApprovalModal(id, mode) {
  var p = capexData.projects.find(function(pr) { return pr.id === id; });
  if (!p) return;
  currentApprovalProjectId = id;
  currentApprovalMode = mode;
  var isDeny = mode === "deny";
  document.getElementById("approvalModalTitle").textContent = isDeny ? "Deny Project" : "Approve Project";
  document.getElementById("approvalByLabel").textContent = isDeny ? "Denied By" : "Approved By";
  document.getElementById("approvalLocationLabel").textContent = isDeny ? "Denied Where" : "Approved Where";
  document.getElementById("approvalDateLabel").textContent = isDeny ? "Denied When" : "Approved When";
  document.getElementById("approvalModalProjectName").textContent = p.name;
  document.getElementById("approvalByInput").value = "";
  document.getElementById("approvalLocationInput").value = "";
  document.getElementById("approvalDateInput").value = new Date().toISOString().slice(0, 10);
  document.getElementById("approvalFileInput").value = "";
  var err = document.getElementById("approvalModalError");
  err.style.display = "none"; err.textContent = "";
  document.getElementById("approvalModalOverlay").style.display = "flex";
}

function closeApprovalModal() {
  document.getElementById("approvalModalOverlay").style.display = "none";
  currentApprovalProjectId = null;
}

async function submitApprovalModal(evt) {
  evt.preventDefault();
  if (!requireEditAccess()) return;
  var id = currentApprovalProjectId;
  if (!id) return;
  var isDeny = currentApprovalMode === "deny";
  var by = document.getElementById("approvalByInput").value.trim();
  var where = document.getElementById("approvalLocationInput").value.trim();
  var when = document.getElementById("approvalDateInput").value;
  var err = document.getElementById("approvalModalError");

  if (!by || !where || !when) {
    err.textContent = (isDeny ? "Denied By, Where, and When are all required." : "Approved By, Where, and When are all required.");
    err.style.display = "block";
    return;
  }

  var saveBtn = document.getElementById("approvalModalSaveBtn");
  saveBtn.disabled = true; saveBtn.textContent = "Saving…";

  var file = document.getElementById("approvalFileInput").files[0];
  var filePath = null;
  if (file) {
    filePath = id + "/" + Date.now() + "-" + file.name;
    var uploadRes = await sb.storage.from("approvals").upload(filePath, file);
    if (uploadRes.error) {
      err.textContent = "Failed to upload file: " + uploadRes.error.message;
      err.style.display = "block";
      saveBtn.disabled = false; saveBtn.textContent = "Save";
      return;
    }
  }

  // Denying a project also marks it complete — there's nothing left to do on a
  // denied project, so it moves straight to the Completed Projects list.
  var updatePayload = isDeny
    ? { denied: true, denied_by: by, denied_location: where, denied_date: when, denial_file_path: filePath, status: "completed", completed_at: new Date().toISOString() }
    : { approved: true, approved_by: by, approved_location: where, approved_date: when, approval_file_path: filePath };

  var res = await sb.from("projects").update(updatePayload).eq("id", id);

  if (res.error) {
    err.textContent = "Failed to save " + (isDeny ? "denial" : "approval") + ": " + res.error.message;
    err.style.display = "block";
    saveBtn.disabled = false; saveBtn.textContent = "Save";
    return;
  }

  await logProjectEvent(id, isDeny ? "denial_granted" : "approval_granted",
    (isDeny ? "Denied by " : "Approved by ") + by + " (" + where + ") on " + formatDateOnly(when),
    filePath ? { file_path: filePath } : null);
  if (isDeny) {
    await logProjectEvent(id, "status_changed", "Marked complete (denied)");
  }

  saveBtn.disabled = false; saveBtn.textContent = "Save";
  closeApprovalModal();
  await loadProjects();
}

async function removeApproval(id) {
  if (!requireEditAccess()) return;
  var p = capexData.projects.find(function(pr) { return pr.id === id; });
  var res = await sb.from("projects").update({
    approved: false,
    approved_by: null,
    approved_location: null,
    approved_date: null,
    approval_file_path: null
  }).eq("id", id);
  if (res.error) { alert("Failed to remove approval: " + res.error.message); return; }
  await logProjectEvent(id, "approval_removed", "Approval removed" + (p && p.approved_by ? " (previously approved by " + p.approved_by + ")" : ""));
  await loadProjects();
}

async function removeDenial(id) {
  if (!requireEditAccess()) return;
  var p = capexData.projects.find(function(pr) { return pr.id === id; });
  // Denying a project auto-completes it, so undoing the denial also moves it back
  // to the active list — there's nothing else that would have completed it.
  var res = await sb.from("projects").update({
    denied: false,
    denied_by: null,
    denied_location: null,
    denied_date: null,
    denial_file_path: null,
    status: "in_progress",
    completed_at: null
  }).eq("id", id);
  if (res.error) { alert("Failed to un-deny: " + res.error.message); return; }
  await logProjectEvent(id, "denial_removed", "Denial removed" + (p && p.denied_by ? " (previously denied by " + p.denied_by + ")" : ""));
  await logProjectEvent(id, "status_changed", "Moved back to active (un-denied)");
  await loadProjects();
}

function startEditBudget(id) {
  document.getElementById("budgetRow-" + id).style.display = "none";
  document.getElementById("budgetForm-" + id).style.display = "flex";
}

function cancelEditBudget(id) {
  document.getElementById("budgetRow-" + id).style.display = "";
  document.getElementById("budgetForm-" + id).style.display = "none";
}

async function saveProjectBudget(id) {
  if (!requireEditAccess()) return;
  var input = document.getElementById("budgetInput-" + id);
  var newVal = Number(input.value);
  if (input.value === "" || isNaN(newVal) || newVal < 0) { alert("Enter a valid budget amount."); return; }
  var p = capexData.projects.find(function(pr) { return pr.id === id; });
  var oldVal = Number(p.budget) || 0;
  if (newVal === oldVal) { cancelEditBudget(id); return; }
  var ok = confirm('Change budget for "' + p.name + '" from $' + oldVal.toLocaleString() + " to $" + newVal.toLocaleString() + "?");
  if (!ok) return;
  var res = await sb.from("projects").update({ budget: newVal }).eq("id", id);
  if (res.error) { alert("Failed to update budget: " + res.error.message); return; }
  await logProjectEvent(id, "budget_changed", "Budget changed from $" + oldVal.toLocaleString() + " to $" + newVal.toLocaleString());
  await loadProjects();
}

var RECEIPT_PREVIEW_COUNT = 5;

async function loadProjectReceipts(projectId, containerId) {
  var container = document.getElementById(containerId || ("receipts-" + projectId));
  if (!container) return;
  var res = await sb.storage.from("receipts").list(projectId, { sortBy: { column: "created_at", order: "desc" } });
  if (!container.isConnected) return; // view may have changed while this was in flight
  if (res.error || !res.data || res.data.length === 0) {
    container.innerHTML = '<div class="rt-empty">No receipts uploaded</div>';
    return;
  }
  await renderProjectReceiptRows(container, projectId, res.data, false);
}

async function renderProjectReceiptRows(container, projectId, files, showAll) {
  var visible = showAll ? files : files.slice(0, RECEIPT_PREVIEW_COUNT);
  var rows = await Promise.all(visible.map(async function(file) {
    var signed = await sb.storage.from("receipts").createSignedUrl(projectId + "/" + file.name, 3600);
    var url = signed.data ? signed.data.signedUrl : "#";
    var label = file.name.replace(/^\d+-/, "");
    return '<div class="receipt-row"><a href="' + url + '" target="_blank" rel="noopener">' + label + '</a></div>';
  }));
  if (!container.isConnected) return;
  var html = rows.join("");
  if (!showAll && files.length > RECEIPT_PREVIEW_COUNT) {
    html += '<button type="button" style="width:100%;margin-top:6px;" onclick="expandProjectReceipts(this, \'' + projectId + '\')">View all Receipts (' + files.length + ')</button>';
  }
  container.innerHTML = html;
}

async function expandProjectReceipts(btnEl, projectId) {
  var container = btnEl.parentElement;
  var res = await sb.storage.from("receipts").list(projectId, { sortBy: { column: "created_at", order: "desc" } });
  if (res.error || !res.data) return;
  await renderProjectReceiptRows(container, projectId, res.data, true);
}

// Builds the standalone "Project Summary" PDF bundled into every documents zip —
// the title, description, budget vs. spending, every to-do, every expense, and the
// full history log, all laid out as a real, selectable PDF document so anyone who
// receives the zip (no dashboard access needed) can open it and see the whole story
// of the project.
function buildProjectSummaryPdf(p, todos, expenses, historyEntries) {
  var propName = {};
  PROPERTIES.forEach(function(pr) { propName[pr.code] = pr.name; });

  var budget = Number(p.budget) || 0;
  var spent = expenses.reduce(function(s, e) { return s + Number(e.amount); }, 0);
  var remaining = budget - spent;
  var money = function(n) { return "$" + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };

  var doc = new jspdf.jsPDF({ unit: "pt", format: "letter" });
  var pageWidth = doc.internal.pageSize.getWidth();
  var pageHeight = doc.internal.pageSize.getHeight();
  var margin = 40;
  var contentWidth = pageWidth - margin * 2;
  var y = margin;

  function ensureSpace(h) {
    if (y + h > pageHeight - margin) {
      doc.addPage();
      y = margin;
    }
  }

  // Draws a section rule + label, and leaves y pointing at the top of the section body.
  function heading(text) {
    ensureSpace(50);
    y += 18;
    doc.setDrawColor(221, 221, 221);
    doc.setLineWidth(0.5);
    doc.line(margin, y, pageWidth - margin, y);
    y += 16;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(68, 68, 68);
    doc.text(text.toUpperCase(), margin, y);
    y += 10;
  }

  function emptyNote(text) {
    doc.setFont("helvetica", "italic");
    doc.setFontSize(10);
    doc.setTextColor(136, 136, 136);
    doc.text(text, margin, y + 12);
    y += 26;
  }

  // Title + subtitle
  doc.setFont("helvetica", "bold");
  doc.setFontSize(20);
  doc.setTextColor(26, 26, 26);
  doc.text(p.name || "Project", margin, y + 16);
  y += 30;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  doc.setTextColor(102, 102, 102);
  var subtitle = (propName[p.property_code] || p.property_code || "") + "   —   " +
    (PROJ_TYPE_LABEL[p.project_type] || p.project_type || "") + "   —   " +
    (p.status === "completed" ? "Completed" : "Active") +
    (p.completed_at ? " on " + new Date(p.completed_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "");
  doc.text(subtitle, margin, y);
  y += 26;

  // Status badge
  var statusText, statusColor, statusMeta;
  if (p.denied) {
    statusText = "Denied"; statusColor = [163, 40, 47];
    statusMeta = "By " + (p.denied_by || "—") + "   —   " + (p.denied_location || "—") + "   —   " + (p.denied_date ? formatDateOnly(p.denied_date) : "—");
  } else if (p.approved) {
    statusText = "Approved"; statusColor = [23, 122, 60];
    statusMeta = "By " + (p.approved_by || "—") + "   —   " + (p.approved_location || "—") + "   —   " + (p.approved_date ? formatDateOnly(p.approved_date) : "—");
  } else {
    statusText = "Not yet approved"; statusColor = [102, 102, 102];
    statusMeta = "";
  }
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  var badgeWidth = doc.getTextWidth(statusText) + 16;
  doc.setFillColor(statusColor[0], statusColor[1], statusColor[2]);
  doc.roundedRect(margin, y - 11, badgeWidth, 16, 8, 8, "F");
  doc.setTextColor(255, 255, 255);
  doc.text(statusText, margin + 8, y);
  if (statusMeta) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(85, 85, 85);
    doc.text(statusMeta, margin + badgeWidth + 10, y);
  }
  y += 28;

  // Summary boxes: Budget / Spent / Remaining
  var boxGap = 12;
  var boxWidth = (contentWidth - boxGap * 2) / 3;
  var boxHeight = 46;
  ensureSpace(boxHeight + 10);
  [
    { label: "Budget", value: money(budget), over: false },
    { label: "Spent", value: money(spent), over: budget > 0 && spent > budget },
    { label: "Remaining", value: money(remaining), over: remaining < 0 }
  ].forEach(function(b, i) {
    var bx = margin + i * (boxWidth + boxGap);
    doc.setFillColor(247, 247, 247);
    doc.roundedRect(bx, y, boxWidth, boxHeight, 4, 4, "F");
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(136, 136, 136);
    doc.text(b.label.toUpperCase(), bx + 12, y + 17);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(15);
    doc.setTextColor(b.over ? 163 : 26, b.over ? 40 : 26, b.over ? 47 : 26);
    doc.text(b.value, bx + 12, y + 36);
  });
  y += boxHeight + 10;

  // Description
  heading("Description");
  var descText = p.description || "No description was recorded.";
  doc.setFont("helvetica", p.description ? "normal" : "italic");
  doc.setFontSize(10);
  var descLines = doc.splitTextToSize(descText, contentWidth - 24);
  var descHeight = descLines.length * 13 + 16;
  ensureSpace(descHeight);
  doc.setFillColor(247, 247, 247);
  doc.roundedRect(margin, y, contentWidth, descHeight, 4, 4, "F");
  doc.setTextColor(p.description ? 26 : 136, p.description ? 26 : 136, p.description ? 26 : 136);
  doc.text(descLines, margin + 12, y + 16);
  y += descHeight + 10;

  // To-Do Items
  heading("To-Do Items");
  var todosSorted = todos.slice().sort(function(a, b) {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    return (a.due_date || "").localeCompare(b.due_date || "");
  });
  if (todosSorted.length) {
    var todoBody = todosSorted.map(function(t) {
      var when = t.completed && t.completed_at
        ? "Completed " + new Date(t.completed_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
        : (t.due_date ? "Due " + formatDateOnly(t.due_date) : "—");
      return [t.completed ? "Done" : "Open", t.title || "", when];
    });
    doc.autoTable({
      startY: y,
      margin: { left: margin, right: margin },
      head: [["Status", "Item", "Date"]],
      body: todoBody,
      theme: "plain",
      styles: { fontSize: 10, cellPadding: 4, textColor: [26, 26, 26], lineColor: [238, 238, 238], lineWidth: { bottom: 0.5 } },
      headStyles: { textColor: [136, 136, 136], fontSize: 8.5, fontStyle: "bold" },
      columnStyles: { 0: { cellWidth: 60 }, 2: { cellWidth: 130 } }
    });
    y = doc.lastAutoTable.finalY + 10;
  } else {
    emptyNote("No to-do items were recorded.");
  }

  // Expenses
  heading("Expenses");
  var expensesSorted = expenses.slice().sort(function(a, b) { return (b.expense_date || "").localeCompare(a.expense_date || ""); });
  if (expensesSorted.length) {
    var expenseBody = expensesSorted.map(function(e) {
      return [
        e.expense_date ? formatDateOnly(e.expense_date) : "—",
        e.vendor || "—",
        EXP_CATEGORY_LABEL[e.category] || e.category || "—",
        e.status || "—",
        money(e.amount)
      ];
    });
    var totalRowIndex = expenseBody.length;
    expenseBody.push(["", "", "", "Total Spent", money(spent)]);
    doc.autoTable({
      startY: y,
      margin: { left: margin, right: margin },
      head: [["Date", "Vendor", "Category", "Status", "Amount"]],
      body: expenseBody,
      theme: "plain",
      styles: { fontSize: 10, cellPadding: 4, textColor: [26, 26, 26], lineColor: [238, 238, 238], lineWidth: { bottom: 0.5 } },
      headStyles: { textColor: [136, 136, 136], fontSize: 8.5, fontStyle: "bold" },
      columnStyles: { 4: { halign: "right" } },
      didParseCell: function(data) {
        if (data.section === "body" && data.row.index === totalRowIndex) {
          data.cell.styles.fontStyle = "bold";
          data.cell.styles.lineWidth = { top: 1, bottom: 0 };
          data.cell.styles.lineColor = [221, 221, 221];
        }
      }
    });
    y = doc.lastAutoTable.finalY + 10;
  } else {
    emptyNote("No expenses were recorded.");
  }

  // History
  heading("History");
  var historySorted = historyEntries.slice().sort(function(a, b) { return new Date(a.created_at) - new Date(b.created_at); });
  if (historySorted.length) {
    var historyBody = historySorted.map(function(entry) {
      var when = new Date(entry.created_at).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
      return [when, entry.summary || ""];
    });
    doc.autoTable({
      startY: y,
      margin: { left: margin, right: margin },
      head: [["When", "Event"]],
      body: historyBody,
      theme: "plain",
      styles: { fontSize: 9.5, cellPadding: 4, textColor: [26, 26, 26], lineColor: [238, 238, 238], lineWidth: { bottom: 0.5 } },
      headStyles: { textColor: [136, 136, 136], fontSize: 8.5, fontStyle: "bold" },
      columnStyles: { 0: { cellWidth: 130 } }
    });
    y = doc.lastAutoTable.finalY + 10;
  } else {
    emptyNote("No history was recorded.");
  }

  // Footer page numbers
  var pageCount = doc.internal.getNumberOfPages();
  for (var pg = 1; pg <= pageCount; pg++) {
    doc.setPage(pg);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(153, 153, 153);
    doc.text("Page " + pg + " of " + pageCount, pageWidth - margin, pageHeight - 20, { align: "right" });
  }

  return doc.output("blob");
}

// Bundles every document on a project — a Project Summary page covering the title,
// description, budget, to-dos, expenses, and history; all uploaded receipts; the
// current approval file (if any); and any earlier approval files noted in the
// project's permanent History log — into a single zip file and downloads it to the
// browser.
async function downloadAllDocuments(projectId, btnEl) {
  var p = capexData.projects.find(function(pr) { return pr.id === projectId; });
  if (!p) return;

  var originalText = btnEl.textContent;
  btnEl.disabled = true;
  btnEl.textContent = "Zipping…";

  try {
    var zip = new JSZip();

    var logRes = await sb.from("project_log").select("*").eq("project_id", projectId);
    var todos = capexData.todos.filter(function(t) { return t.project_id === projectId; });
    var expenses = capexData.expenses.filter(function(e) { return e.project_id === projectId; });
    var summaryPdf = buildProjectSummaryPdf(p, todos, expenses, logRes.data || []);
    zip.file("0 - Project Summary.pdf", summaryPdf);

    var receiptsRes = await sb.storage.from("receipts").list(projectId);
    var receiptFiles = receiptsRes.data || [];
    for (var i = 0; i < receiptFiles.length; i++) {
      var rf = receiptFiles[i];
      var rDownload = await sb.storage.from("receipts").download(projectId + "/" + rf.name);
      if (rDownload.data) {
        zip.file("Receipts/" + rf.name, rDownload.data);
      }
    }

    // Every approval file this project has ever had: the current one (if approved
    // right now) plus any older ones recorded in History when approval was removed
    // and later re-granted with a different file.
    var approvalPaths = [];
    if (p.approval_file_path) approvalPaths.push(p.approval_file_path);
    (logRes.data || []).forEach(function(entry) {
      var path = entry.metadata && entry.metadata.file_path;
      if (path && approvalPaths.indexOf(path) === -1) approvalPaths.push(path);
    });

    for (var j = 0; j < approvalPaths.length; j++) {
      var aDownload = await sb.storage.from("approvals").download(approvalPaths[j]);
      if (aDownload.data) {
        zip.file("Approvals/" + approvalPaths[j].split("/").pop(), aDownload.data);
      }
    }

    var zipBlob = await zip.generateAsync({ type: "blob" });
    var url = URL.createObjectURL(zipBlob);
    var a = document.createElement("a");
    a.href = url;
    a.download = (p.name || "project").replace(/[\\/:*?"<>|]/g, "-") + " - Documents.zip";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (e) {
    alert("Failed to build the documents download: " + e.message);
  } finally {
    btnEl.disabled = false;
    btnEl.textContent = originalText;
  }
}

async function uploadReceipt(projectId, inputEl) {
  if (!requireEditAccess()) return;
  var file = inputEl.files[0];
  if (!file) return;
  var path = projectId + "/" + Date.now() + "-" + file.name;
  var res = await sb.storage.from("receipts").upload(path, file);
  if (res.error) { alert("Failed to upload receipt: " + res.error.message); return; }
  inputEl.value = "";
  await loadProjectReceipts(projectId);
}

async function addProjectTodo(projectId, propertyCode) {
  if (!requireEditAccess()) return;
  var input = document.getElementById("projTodoInput-" + projectId);
  var title = input.value.trim();
  if (!title) return;
  var payload = {
    property_code: propertyCode,
    project_id: projectId,
    title: title,
    priority: "medium",
    created_by: capexSession.user.id
  };
  var res = await sb.from("todos").insert(payload);
  if (res.error) { alert("Failed to add to-do: " + res.error.message); return; }
  input.value = "";
  await loadTodos();

  // Mirror the to-do into Asana without making the person wait for it, and
  // without interrupting them if it fails — the to-do itself already saved.
  var project = capexData.projects.find(function(p) { return p.id === projectId; });
  asanaCreateCapexTodoTask(propertyCode, title, project ? project.name : "").catch(function(err) {
    console.error(err);
    if (typeof Sentry !== "undefined") Sentry.captureException(err);
  });
}

function renderExpenses() {
  var tbody = document.getElementById("expensesTableBody");
  var list = capexData.expenses.filter(function(e) { return capexPropertyFilter === "all" || e.property_code === capexPropertyFilter; });
  if (list.length === 0) { tbody.innerHTML = '<tr><td colspan="7" style="color:var(--text-muted)">No expenses yet.</td></tr>'; return; }
  tbody.innerHTML = list.map(function(e) {
    var proj = capexData.projects.find(function(p) { return p.id === e.project_id; });
    return '<tr><td>' + e.expense_date + '</td><td>' + e.property_code + '</td><td>' + (proj ? proj.name : '—') + '</td>' +
      '<td>' + (e.vendor || '—') + '</td><td>' + (EXP_CATEGORY_LABEL[e.category] || e.category || '—') + '</td><td>' + e.status + '</td>' +
      '<td style="text-align:right">$' + Number(e.amount).toLocaleString() + '</td></tr>';
  }).join("");
}

async function toggleTodo(id, completed) {
  if (!requireEditAccess()) return;
  var res = await sb.from("todos").update({ completed: completed, completed_at: completed ? new Date().toISOString() : null }).eq("id", id);
  if (res.error) { alert("Failed to update: " + res.error.message); return; }
  await loadTodos();
}

async function handleAddProject(evt) {
  evt.preventDefault();
  if (!requireEditAccess()) return;
  var payload = {
    property_code: document.getElementById("projPropertyInput").value,
    name: document.getElementById("projNameInput").value.trim(),
    project_type: document.getElementById("projTypeInput").value,
    status: document.getElementById("projStatusInput").value,
    budget: document.getElementById("projBudgetInput").value || null,
    target_date: document.getElementById("projTargetInput").value || null,
    created_by: capexSession.user.id
  };
  var res = await sb.from("projects").insert(payload);
  if (res.error) { alert("Failed to add project: " + res.error.message); return; }
  evt.target.reset();
  await loadProjects();
}

async function handleAddExpense(evt) {
  evt.preventDefault();
  if (!requireEditAccess()) return;
  var payload = {
    property_code: document.getElementById("expPropertyInput").value,
    project_id: document.getElementById("expProjectInput").value || null,
    vendor: document.getElementById("expVendorInput").value.trim() || null,
    category: document.getElementById("expCategoryInput").value,
    amount: document.getElementById("expAmountInput").value,
    expense_date: document.getElementById("expDateInput").value || new Date().toISOString().slice(0, 10),
    status: document.getElementById("expStatusInput").value,
    created_by: capexSession.user.id
  };
  var res = await sb.from("expenses").insert(payload);
  if (res.error) { alert("Failed to add expense: " + res.error.message); return; }
  evt.target.reset();
  await loadExpenses();
  renderProjects();
}

