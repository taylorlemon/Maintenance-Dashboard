// Admin tab: managing facilities and user access (admin-only).

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
