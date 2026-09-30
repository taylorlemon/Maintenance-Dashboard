// Admin tab: managing facilities and user access (admin-only).

// ── Admin: sub-tabs ──────────────────────────────────────────────────────

var adminView = "facilities"; // "facilities" | "users" | "expenses"

function renderAdminView() {
  document.getElementById("adminFacilitiesGroup").style.display = adminView === "facilities" ? "" : "none";
  document.getElementById("adminUsersGroup").style.display = adminView === "users" ? "" : "none";
  document.getElementById("adminExpenseAuditGroup").style.display = adminView === "expenses" ? "" : "none";
}

// ── Admin: facilities ────────────────────────────────────────────────────

async function loadAdminFacilities() {
  await loadProperties();
  renderAdminFacilities();
}

function renderAdminFacilities() {
  var body = document.getElementById("facilitiesTableBody");
  if (!PROPERTIES.length) { body.innerHTML = '<tr><td colspan="5">No facilities yet.</td></tr>'; return; }
  body.innerHTML = PROPERTIES.map(function(p) {
    var asanaStatus = p.gid
      ? '<span style="color:var(--success)">Connected</span>'
      : '<span style="color:var(--text-muted)">Not set up</span>';
    var complianceStatus = p.complianceGid
      ? '<span style="color:var(--success)">Connected</span>'
      : '<span style="color:var(--text-muted)">Not set up</span>';
    return '<tr data-code="' + p.code + '">' +
      '<td>' + p.name + '</td>' +
      '<td>' + p.code + '</td>' +
      '<td>' + asanaStatus + '</td>' +
      '<td>' + complianceStatus + '</td>' +
      '<td><button type="button" class="admin-save-btn facility-remove-btn" style="color:var(--danger);border-color:var(--danger);">Remove</button></td>' +
      '</tr>';
  }).join("");
  body.querySelectorAll(".facility-remove-btn").forEach(function(btn) {
    btn.addEventListener("click", function() { removeFacility(btn); });
  });
}

async function removeFacility(btn) {
  var row = btn.closest("tr");
  var code = row.getAttribute("data-code");
  var prop = PROPERTIES.find(function(p) { return p.code === code; });
  var name = prop ? prop.name : code;
  if (!confirm('Remove "' + name + '" from the system? This deletes it from every dropdown and list.')) return;
  if (!confirm('Are you 100% sure? This permanently removes "' + name + '" and cannot be undone.')) return;
  btn.textContent = "Removing…"; btn.disabled = true;
  var res = await sb.from("properties").delete().eq("code", code);
  if (res.error) {
    btn.textContent = "Remove"; btn.disabled = false;
    if (res.error.code === "23503") {
      alert('"' + name + '" still has projects, expenses, or to-dos on record, so it can\'t be removed. Clear those out first, or ask me for help archiving them.');
    } else {
      alert("Failed to remove: " + res.error.message);
    }
    return;
  }
  await loadAdminFacilities();
  populatePropertySelects();
}

async function handleAddFacility(evt) {
  evt.preventDefault();
  var name = document.getElementById("newFacilityName").value.trim();
  var code = document.getElementById("newFacilityCode").value.trim().toUpperCase();
  var gid = document.getElementById("newFacilityGid").value.trim() || null;
  var pmGid = document.getElementById("newFacilityPmGid").value.trim() || null;
  var rtGid = document.getElementById("newFacilityRtGid").value.trim() || null;
  var complianceGid = document.getElementById("newFacilityComplianceGid").value.trim() || null;
  if (!name || !code) { alert("Enter both a name and a code."); return; }
  if (!confirm('Add "' + name + '" (' + code + ') as a new facility?')) return;
  var btn = document.querySelector("#addFacilityForm button[type='submit']");
  btn.textContent = "Adding…"; btn.disabled = true;
  var res = await sb.from("properties").insert({
    code: code, name: name,
    asana_project_gid: gid, asana_pm_section_gid: pmGid, asana_rt_section_gid: rtGid,
    asana_compliance_section_gid: complianceGid
  });
  btn.textContent = "Add Facility"; btn.disabled = false;
  if (res.error) {
    if (res.error.code === "23505") { alert('A facility with the code "' + code + '" already exists. Pick a different code.'); return; }
    alert("Failed to add facility: " + res.error.message);
    return;
  }
  document.getElementById("addFacilityForm").reset();
  await loadAdminFacilities();
  populatePropertySelects();
}

// ── Admin: inviting and removing logins ──────────────────────────────────────
// Goes through the "manage-users" Supabase Edge Function instead of doing this
// directly in the browser — creating or deleting a login needs a powerful key
// that must never appear in this page. See supabase/functions/manage-users.

async function handleInviteUser(evt) {
  evt.preventDefault();
  var input = document.getElementById("newUserEmail");
  var email = input.value.trim();
  if (!email) { alert("Enter an email address."); return; }
  if (!confirm('Send an invite to "' + email + '"? They\'ll get an email with a link to set their password.')) return;
  var btn = document.querySelector("#inviteUserForm button[type='submit']");
  btn.textContent = "Inviting…"; btn.disabled = true;
  var res = await sb.functions.invoke("manage-users", { body: { action: "invite", email: email } });
  btn.textContent = "Invite"; btn.disabled = false;
  if (res.error) { alert("Failed to invite: " + (await edgeFunctionErrorMessage(res.error))); return; }
  document.getElementById("inviteUserForm").reset();
  alert('Invited "' + email + '". They\'ll show up in the list below.');
  await loadAdminUsers();
}

async function removeUser(btn) {
  var row = btn.closest("tr");
  var id = row.getAttribute("data-id");
  var email = row.getAttribute("data-email");
  if (!confirm('Permanently remove the login for "' + email + '"? This deletes their account entirely — they will no longer be able to sign in at all.')) return;
  if (!confirm('Are you 100% sure? This cannot be undone.')) return;
  btn.textContent = "Removing…"; btn.disabled = true;
  var res = await sb.functions.invoke("manage-users", { body: { action: "delete", userId: id } });
  if (res.error) {
    btn.textContent = "Remove"; btn.disabled = false;
    alert("Failed to remove: " + (await edgeFunctionErrorMessage(res.error)));
    return;
  }
  await loadAdminUsers();
}

// ── Admin: roles and facility access per login ──────────────────────────────

async function loadAdminUsers() {
  var body = document.getElementById("adminTableBody");
  var res = await sb.from("profiles").select("*").order("email");
  if (res.error) { body.innerHTML = '<tr><td colspan="5">Failed to load: ' + res.error.message + '</td></tr>'; return; }
  var ppRes = await sb.from("profile_properties").select("*");
  if (ppRes.error) { body.innerHTML = '<tr><td colspan="5">Failed to load: ' + ppRes.error.message + '</td></tr>'; return; }
  var byProfile = {};
  ppRes.data.forEach(function(row) {
    (byProfile[row.profile_id] = byProfile[row.profile_id] || []).push(row.property_code);
  });
  renderAdminUsers(res.data, byProfile);
}

function renderAdminUsers(profiles, byProfile) {
  var body = document.getElementById("adminTableBody");
  if (!profiles.length) { body.innerHTML = '<tr><td colspan="5">No logins yet.</td></tr>'; return; }
  body.innerHTML = profiles.map(function(p) {
    var myCodes = byProfile[p.id] || [];
    var facilityChecks = PROPERTIES.map(function(prop) {
      var checked = myCodes.indexOf(prop.code) !== -1 ? ' checked' : '';
      return '<label style="display:flex;align-items:center;gap:6px;font-weight:normal;">' +
        '<input type="checkbox" class="admin-facility-check" value="' + prop.code + '"' + checked + ' /> ' + prop.name + '</label>';
    }).join("");
    var roleOptions = ['admin', 'editor', 'viewer'].map(function(r) {
      var label = r === 'admin' ? 'Admin' : (r === 'editor' ? 'Editor' : 'Viewer');
      return '<option value="' + r + '"' + (p.role === r ? ' selected' : '') + '>' + label + '</option>';
    }).join("");
    return '<tr data-id="' + p.id + '" data-email="' + p.email + '">' +
      '<td>' + p.email + '</td>' +
      '<td><div style="display:flex;flex-direction:column;gap:4px;">' + (facilityChecks || '<span style="color:var(--text-muted)">No facilities yet</span>') + '</div></td>' +
      '<td><select class="admin-role-select">' + roleOptions + '</select></td>' +
      '<td><button type="button" class="admin-save-btn">Save</button></td>' +
      '<td><button type="button" class="admin-save-btn user-remove-btn" style="color:var(--danger);border-color:var(--danger);">Remove</button></td>' +
      '</tr>';
  }).join("");
  body.querySelectorAll(".admin-save-btn:not(.user-remove-btn)").forEach(function(btn) {
    btn.addEventListener("click", function() { saveAdminUser(btn); });
  });
  body.querySelectorAll(".user-remove-btn").forEach(function(btn) {
    btn.addEventListener("click", function() { removeUser(btn); });
  });
}

async function saveAdminUser(btn) {
  var row = btn.closest("tr");
  var id = row.getAttribute("data-id");
  var role = row.querySelector(".admin-role-select").value;
  var codes = Array.prototype.slice.call(row.querySelectorAll(".admin-facility-check:checked")).map(function(c) { return c.value; });
  btn.textContent = "Saving…"; btn.disabled = true; btn.classList.remove("saved");

  var roleRes = await sb.from("profiles").update({ role: role }).eq("id", id);
  if (roleRes.error) { alert("Failed to save: " + roleRes.error.message); btn.textContent = "Save"; btn.disabled = false; return; }

  var delRes = await sb.from("profile_properties").delete().eq("profile_id", id);
  if (delRes.error) { alert("Failed to save: " + delRes.error.message); btn.textContent = "Save"; btn.disabled = false; return; }

  if (codes.length) {
    var insRes = await sb.from("profile_properties").insert(codes.map(function(code) { return { profile_id: id, property_code: code }; }));
    if (insRes.error) { alert("Failed to save: " + insRes.error.message); btn.textContent = "Save"; btn.disabled = false; return; }
  }

  btn.disabled = false;
  btn.textContent = "Saved"; btn.classList.add("saved");
  setTimeout(function() { btn.textContent = "Save"; btn.classList.remove("saved"); }, 1500);
}

// ── Admin: Expense Audit ────────────────────────────────────────────────────
// Every expense in the system, admin-only — for finding and permanently deleting
// bad/test data. Expenses not tied to a project ("Unlinked") are the ones archiving
// a project (js/capex.js) can't clean up, since archiving only sets aside expenses
// actually attached to it.

// Only one row at a time can be in edit mode — keeps the table calm to look at.
var editingExpenseId = null;

function toggleExpenseEdit(id) {
  editingExpenseId = (editingExpenseId === id) ? null : id;
  renderExpenseAudit();
}

function renderExpenseAudit() {
  var tbody = document.getElementById("expenseAuditTableBody");
  if (!tbody || !currentProfile || currentProfile.role !== "admin") return;

  var propertyFilter = document.getElementById("expenseAuditPropertySelect").value || "all";
  var search = (document.getElementById("expenseAuditSearchInput").value || "").trim().toLowerCase();

  var propName = {};
  PROPERTIES.forEach(function(pr) { propName[pr.code] = pr.name; });
  var projectById = {};
  capexData.projects.forEach(function(p) { projectById[p.id] = p; });

  var list = capexData.expenses.filter(function(e) {
    if (propertyFilter !== "all" && e.property_code !== propertyFilter) return false;
    if (!search) return true;
    var project = e.project_id ? projectById[e.project_id] : null;
    var haystack = ((e.vendor || "") + " " + (project ? project.name : "")).toLowerCase();
    return haystack.indexOf(search) !== -1;
  }).sort(function(a, b) { return new Date(b.expense_date || 0) - new Date(a.expense_date || 0); });

  if (list.length === 0) { tbody.innerHTML = '<tr><td colspan="8" style="color:var(--text-muted)">No expenses match.</td></tr>'; return; }

  tbody.innerHTML = list.map(function(e) {
    var project = e.project_id ? projectById[e.project_id] : null;
    var projectLabel = project
      ? escapeHtml(project.name) + (project.archived_at ? ' <span style="color:var(--text-muted);font-size:10px;">(archived)</span>' : '')
      : '<span style="color:var(--danger);">Unlinked</span>';

    if (editingExpenseId === e.id) {
      return '<tr data-expense-id="' + e.id + '">' +
        '<td>' + (propName[e.property_code] || e.property_code) + '</td>' +
        '<td>' + projectLabel + '</td>' +
        '<td><input type="text" data-field="vendor" value="' + escapeHtml(e.vendor || '') + '" /></td>' +
        '<td>' + expenseCategorySelectHtml(e.category) + '</td>' +
        '<td><input type="number" step="0.01" min="0" data-field="amount" value="' + Number(e.amount) + '" style="text-align:right;" /></td>' +
        '<td><input type="date" data-field="expense_date" value="' + (e.expense_date || '') + '" /></td>' +
        '<td>' + expenseStatusSelectHtml(e.status) + '</td>' +
        '<td style="display:flex;gap:6px;">' +
          '<button type="button" class="admin-save-btn expense-save-btn">Save</button>' +
          '<button type="button" class="table-action-btn" onclick="toggleExpenseEdit(\'' + e.id + '\')">Cancel</button>' +
        '</td>' +
        '</tr>';
    }

    return '<tr data-expense-id="' + e.id + '">' +
      '<td>' + (propName[e.property_code] || e.property_code) + '</td>' +
      '<td>' + projectLabel + '</td>' +
      '<td>' + escapeHtml(e.vendor || '—') + '</td>' +
      '<td>' + expenseCategoryDisplayHtml(e.category) + '</td>' +
      '<td style="text-align:right">$' + Number(e.amount).toLocaleString() + '</td>' +
      '<td>' + (e.expense_date ? formatDateOnly(e.expense_date) : '—') + '</td>' +
      '<td>' + (e.status ? (e.status.charAt(0).toUpperCase() + e.status.slice(1)) : '—') + '</td>' +
      '<td style="display:flex;gap:6px;">' +
        '<button type="button" class="table-action-btn" onclick="toggleExpenseEdit(\'' + e.id + '\')">Edit</button>' +
        '<button type="button" class="table-action-btn expense-delete-btn" style="color:var(--danger);border-color:var(--danger);">Delete</button>' +
      '</td>' +
      '</tr>';
  }).join("");

  tbody.querySelectorAll(".expense-save-btn").forEach(function(btn) {
    btn.addEventListener("click", function() { saveExpenseEdit(btn); });
  });
  tbody.querySelectorAll(".expense-delete-btn").forEach(function(btn) {
    btn.addEventListener("click", function() { handleDeleteExpense(btn); });
  });
}

// Read-only version of the category cell — still flags a leftover/unrecognized value in
// red (e.g. an old "Other" entry) so it stays visible without needing to click Edit.
function expenseCategoryDisplayHtml(category) {
  var known = ["repair_replacement", "improvement"];
  if (!category) return '<span style="color:var(--danger);">No category set</span>';
  if (known.indexOf(category) === -1) return '<span style="color:var(--danger);">' + escapeHtml(EXP_CATEGORY_LABEL[category] || category) + '</span>';
  return EXP_CATEGORY_LABEL[category] || category;
}

function expenseCategorySelectHtml(current) {
  var known = ["repair_replacement", "improvement"];
  var isUnrecognized = !!current && known.indexOf(current) === -1;
  var options = known.map(function(val) {
    return '<option value="' + val + '"' + (current === val ? ' selected' : '') + '>' + EXP_CATEGORY_LABEL[val] + '</option>';
  }).join("");
  // A leftover value that doesn't match either current option — old "Other" entries, or
  // anything else that snuck in before the category picker existed — shown as-is (in red)
  // instead of silently defaulting to whichever option happens to come first, so it's never
  // accidentally re-saved as the wrong category.
  if (isUnrecognized) {
    options += '<option value="' + escapeHtml(current) + '" selected>' + escapeHtml(EXP_CATEGORY_LABEL[current] || current) + ' — pick one</option>';
  } else if (!current) {
    options += '<option value="" selected disabled>No category set — pick one</option>';
  }
  return '<select data-field="category"' + ((isUnrecognized || !current) ? ' style="border-color:var(--danger);color:var(--danger);"' : '') + '>' + options + '</select>';
}

function expenseStatusSelectHtml(current) {
  return '<select data-field="status">' +
    ['pending', 'approved', 'paid'].map(function(val) {
      var label = val.charAt(0).toUpperCase() + val.slice(1);
      return '<option value="' + val + '"' + (current === val ? ' selected' : '') + '>' + label + '</option>';
    }).join("") +
    '</select>';
}

async function saveExpenseEdit(btn) {
  var row = btn.closest("tr");
  var id = row.getAttribute("data-expense-id");
  var vendor = row.querySelector('[data-field="vendor"]').value.trim();
  var category = row.querySelector('[data-field="category"]').value;
  var amountInput = row.querySelector('[data-field="amount"]');
  var amount = Number(amountInput.value);
  var expenseDate = row.querySelector('[data-field="expense_date"]').value;
  var status = row.querySelector('[data-field="status"]').value;

  if (amountInput.value === "" || isNaN(amount) || amount <= 0) { alert("Enter a valid amount greater than 0."); return; }
  if (!expenseDate) { alert("Enter a date."); return; }

  btn.textContent = "Saving…"; btn.disabled = true;
  var res = await sb.from("expenses").update({
    vendor: vendor || null,
    category: category,
    amount: amount,
    expense_date: expenseDate,
    status: status
  }).eq("id", id);
  if (res.error) { alert("Failed to save: " + res.error.message); btn.textContent = "Save"; btn.disabled = false; return; }
  editingExpenseId = null;
  await loadExpenses();
}

async function handleDeleteExpense(btn) {
  var row = btn.closest("tr");
  var id = row.getAttribute("data-expense-id");
  var e = capexData.expenses.find(function(exp) { return exp.id === id; });
  if (!e) return;
  var propName = {};
  PROPERTIES.forEach(function(pr) { propName[pr.code] = pr.name; });
  var label = (e.vendor || "this expense") + " — $" + Number(e.amount).toLocaleString() +
    " (" + (propName[e.property_code] || e.property_code) + ", " + (e.expense_date ? formatDateOnly(e.expense_date) : "no date") + ")";
  if (!confirm("Permanently delete " + label + "?\n\nThis cannot be undone.")) return;
  if (!confirm("Are you 100% sure? This will also remove it from the property's budget totals.")) return;

  btn.textContent = "Deleting…"; btn.disabled = true;
  var res = await sb.from("expenses").delete().eq("id", id);
  if (res.error) { alert("Failed to delete: " + res.error.message); btn.textContent = "Delete"; btn.disabled = false; return; }
  await loadExpenses();
}
