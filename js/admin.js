// Admin tab: managing facilities and user access (admin-only).

// ── Admin: sub-tabs ──────────────────────────────────────────────────────

var adminView = "facilities"; // "company" | "facilities" | "users" | "expenses"

// Adding, changing and removing facilities is the Executive's job (each one
// needs Asana set up by hand), and the database refuses it from anyone else —
// so other Admins don't get the Facilities view at all and start on Users.
// The Company view (settings, Asana key, health check) is the Executive's too.
function applyFacilitiesAccess() {
  var allowed = isExecutive();
  document.querySelector('#adminViewToggle [data-view="facilities"]').style.display = allowed ? "" : "none";
  document.querySelector('#adminViewToggle [data-view="company"]').style.display = allowed ? "" : "none";
  if (!allowed && (adminView === "facilities" || adminView === "company")) showAdminView("users");
  else renderAdminView();
}

function showAdminView(view) {
  adminView = view;
  document.querySelectorAll("#adminViewToggle .range-btn").forEach(function(b) {
    b.classList.toggle("active", b.getAttribute("data-view") === view);
  });
  renderAdminView();
}

function renderAdminView() {
  document.getElementById("adminCompanyGroup").style.display = adminView === "company" ? "" : "none";
  if (adminView === "company") loadCompanySettings();
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
  if (!PROPERTIES.length) { body.innerHTML = '<tr><td colspan="7">No facilities yet.</td></tr>'; return; }
  body.innerHTML = PROPERTIES.map(function(p) {
    var asanaStatus = p.gid
      ? '<span style="color:var(--success)">Connected</span>'
      : '<span style="color:var(--text-muted)">Not set up</span>';
    var complianceStatus = p.complianceGid
      ? '<span style="color:var(--success)">Connected</span>'
      : '<span style="color:var(--text-muted)">Not set up</span>';
    var capexStatus = p.capexSection
      ? '<span style="color:var(--success)">' + escapeHtml(p.capexSection) + '</span>'
      : '<span style="color:var(--text-muted)">Not set up</span>';
    return '<tr data-code="' + escapeHtml(p.code) + '">' +
      '<td>' + escapeHtml(p.name) + '</td>' +
      '<td>' + escapeHtml(p.code) + '</td>' +
      '<td>' + escapeHtml(p.timeZone) + '</td>' +
      '<td>' + asanaStatus + '</td>' +
      '<td>' + complianceStatus + '</td>' +
      '<td>' + capexStatus + '</td>' +
      '<td style="white-space:nowrap;"><button type="button" class="admin-save-btn facility-edit-btn">Edit</button> ' +
        '<button type="button" class="admin-save-btn facility-remove-btn" style="color:var(--danger);border-color:var(--danger);">Remove</button></td>' +
      '</tr>';
  }).join("");
  body.querySelectorAll(".facility-remove-btn").forEach(function(btn) {
    btn.addEventListener("click", function() { removeFacility(btn); });
  });
  body.querySelectorAll(".facility-edit-btn").forEach(function(btn) {
    btn.addEventListener("click", function() { startEditFacility(btn.closest("tr").getAttribute("data-code")); });
  });
}

// Editing reuses the "Add a Facility" form: it's filled in with the facility's
// current details and saves changes instead of adding. The code can't change
// (projects, expenses and logins all refer to it).
var editingFacility = null;

function startEditFacility(code) {
  var p = PROPERTIES.find(function(x) { return x.code === code; });
  if (!p) return;
  editingFacility = code;
  document.getElementById("newFacilityName").value = p.name;
  document.getElementById("newFacilityCode").value = p.code;
  document.getElementById("newFacilityCode").disabled = true;
  document.getElementById("newFacilityTimeZone").value = p.timeZone || "America/Denver";
  document.getElementById("newFacilityGid").value = p.gid || "";
  document.getElementById("newFacilityPmGid").value = p.pmGid || "";
  document.getElementById("newFacilityRtGid").value = p.rtGid || "";
  document.getElementById("newFacilityComplianceGid").value = p.complianceGid || "";
  document.getElementById("newFacilityCapexSection").value = p.capexSection || "";
  document.querySelector("#addFacilityForm button[type='submit']").textContent = "Save Changes";
  document.getElementById("facilityEditCancel").style.display = "";
  var form = document.getElementById("addFacilityForm");
  form.closest(".config-panel").querySelector(".config-title").textContent = "Edit " + p.name;
  form.scrollIntoView({ behavior: "smooth", block: "center" });
}

function cancelEditFacility() {
  editingFacility = null;
  var form = document.getElementById("addFacilityForm");
  form.reset();
  document.getElementById("newFacilityCode").disabled = false;
  document.querySelector("#addFacilityForm button[type='submit']").textContent = "Add Facility";
  document.getElementById("facilityEditCancel").style.display = "none";
  form.closest(".config-panel").querySelector(".config-title").textContent = "Add a Facility";
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
  loadAll(); // so Work Orders shows the change straight away
}

async function handleAddFacility(evt) {
  evt.preventDefault();
  var name = document.getElementById("newFacilityName").value.trim();
  var code = document.getElementById("newFacilityCode").value.trim().toUpperCase();
  var gid = document.getElementById("newFacilityGid").value.trim() || null;
  var pmGid = document.getElementById("newFacilityPmGid").value.trim() || null;
  var rtGid = document.getElementById("newFacilityRtGid").value.trim() || null;
  var complianceGid = document.getElementById("newFacilityComplianceGid").value.trim() || null;
  var timeZone = document.getElementById("newFacilityTimeZone").value;
  var capexSection = document.getElementById("newFacilityCapexSection").value.trim() || null;
  if (!name || !code) { alert("Enter both a name and a code."); return; }
  if (editingFacility) {
    var upd = await sb.from("properties").update({
      name: name, time_zone: timeZone, asana_capex_section_name: capexSection,
      asana_project_gid: gid, asana_pm_section_gid: pmGid, asana_rt_section_gid: rtGid, asana_compliance_section_gid: complianceGid
    }).eq("code", editingFacility);
    if (upd.error) { alert("Failed to save: " + upd.error.message); return; }
    cancelEditFacility();
    await loadAdminFacilities();
    populatePropertySelects();
    loadAll();
    return;
  }
  if (!confirm('Add "' + name + '" (' + code + ') as a new facility?')) return;
  var btn = document.querySelector("#addFacilityForm button[type='submit']");
  btn.textContent = "Adding…"; btn.disabled = true;
  var res = await sb.from("properties").insert({
    code: code, name: name, company_id: currentCompanyId(),
    asana_project_gid: gid, asana_pm_section_gid: pmGid, asana_rt_section_gid: rtGid,
    asana_compliance_section_gid: complianceGid, time_zone: timeZone, asana_capex_section_name: capexSection
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
  loadAll();
}

// ── Admin: Company settings and health check (Executive only) ───────────────
// The company's Asana key is only ever sent in, never read back: the page just
// learns whether one is saved.

async function loadCompanySettings() {
  var res = await sb.from("companies").select("name, asana_token_secret, asana_capex_project_gid, paused_at").eq("id", currentCompanyId()).single();
  if (res.error) return;
  document.getElementById("companySettingName").value = res.data.name;
  document.getElementById("companySettingCapexGid").value = res.data.asana_capex_project_gid || "";
  var status = document.getElementById("companyAsanaKeyStatus");
  status.textContent = res.data.asana_token_secret ? "saved" : "not added yet";
  status.style.color = res.data.asana_token_secret ? "var(--success)" : "var(--warn)";
  document.getElementById("companyHealthResults").innerHTML = "";

  // Your own company can't be paused or removed (the database refuses too).
  var own = currentCompanyId() === currentProfile.company_id;
  document.getElementById("companyLeavePanel").style.display = own ? "none" : "";
  document.getElementById("companyOwnNote").style.display = own ? "" : "none";
  var paused = !!res.data.paused_at;
  var status = document.getElementById("companyLeaveStatus");
  status.textContent = paused
    ? "Paused since " + new Date(res.data.paused_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) + ". Their people can't see anything and get no emails."
    : "Active.";
  status.style.color = paused ? "var(--warn)" : "";
  document.getElementById("companyPauseBtn").textContent = paused ? "Un-pause Company" : "Pause Company";
  // Removing only works once paused, so until then the box and button are greyed out.
  var confirmBox = document.getElementById("companyRemoveConfirm");
  document.getElementById("companyRemoveBtn").disabled = !paused;
  confirmBox.disabled = !paused;
  confirmBox.value = "";
  confirmBox.placeholder = paused ? 'Type "' + res.data.name + '" here' : "Pause the company first";
}

async function toggleCompanyPaused() {
  var name = companyName(currentCompanyId());
  var pausing = document.getElementById("companyPauseBtn").textContent.indexOf("Un-pause") === -1;
  if (!confirm(pausing
    ? 'Pause ' + name + '? Their people will see nothing and get no emails until you un-pause them. Nothing is deleted.'
    : 'Un-pause ' + name + '? Their people get their access and emails back straight away.')) return;
  var res = await sb.rpc("set_company_paused", { c: currentCompanyId(), pause: pausing });
  if (res.error) { alert("Couldn't change it: " + res.error.message); return; }
  await loadCompanies();
  await loadCompanySettings();
}

// Everything of this company's, as spreadsheets plus its uploaded files, in one
// zip. The Executive can already read all of it, so it's built right here.
async function downloadCompanyData() {
  var btn = document.getElementById("companyDownloadBtn");
  var original = btn.textContent;
  btn.disabled = true;
  try {
    var cid = currentCompanyId(), name = companyName(cid);
    var codes = PROPERTIES.map(function(p) { return p.code; });
    // The database hands back at most 1,000 rows at a time, so ask page by page.
    async function all(table, filter) {
      var out = [];
      for (var from = 0; ; from += 1000) {
        var res = await filter(sb.from(table).select("*")).range(from, from + 999);
        if (res.error) throw new Error(table + ": " + res.error.message);
        out = out.concat(res.data);
        if (res.data.length < 1000) return out;
      }
    }
    function csv(rows) {
      if (!rows.length) return "";
      var cols = Object.keys(rows[0]);
      return cols.join(",") + "\r\n" + rows.map(function(r) {
        return cols.map(function(c) { return csvField(r[c] !== null && typeof r[c] === "object" ? JSON.stringify(r[c]) : r[c]); }).join(",");
      }).join("\r\n");
    }
    btn.textContent = "Gathering records…";
    var none = ["__none__"];
    var c = codes.length ? codes : none;
    var data = {
      "buildings": await all("properties", function(q) { return q.eq("company_id", cid); }),
      "people": await all("profiles", function(q) { return q.eq("company_id", cid); }),
      "projects": await all("projects", function(q) { return q.in("property_code", c); }),
      "expenses": await all("expenses", function(q) { return q.in("property_code", c); }),
      "to-dos": await all("todos", function(q) { return q.in("property_code", c); }),
      "yearly budgets": await all("annual_budgets", function(q) { return q.in("property_code", c); }),
      "work order history": await all("work_order_daily_stats", function(q) { return q.in("property_code", c); }),
      "vendors": await all("vendors", function(q) { return q.eq("company_id", cid); })
    };
    var projectIds = data["projects"].map(function(p) { return p.id; });
    var vendorIds = data["vendors"].map(function(v) { return v.id; });
    data["people's buildings"] = await all("profile_properties", function(q) { return q.in("property_code", c); });
    data["project history"] = await all("project_log", function(q) { return q.in("project_id", projectIds.length ? projectIds : none); });
    data["vendor buildings"] = await all("vendor_properties", function(q) { return q.in("vendor_id", vendorIds.length ? vendorIds : none); });
    data["vendor contracts"] = await all("vendor_contracts", function(q) { return q.in("vendor_id", vendorIds.length ? vendorIds : none); });
    // Just the useful columns for people (not internal ids or settings).
    data["people"] = data["people"].map(function(p) { return { email: p.email, role: p.role, created_at: p.created_at }; });

    var zip = new JSZip();
    Object.keys(data).forEach(function(k) { zip.file(k + ".csv", csv(data[k])); });

    // Uploaded files, in folders named after their project or vendor.
    var safe = function(s) { return String(s || "").replace(/[\/:*?"<>|]/g, "-").slice(0, 80); };
    var folders = [];
    data["projects"].forEach(function(p) {
      folders.push({ bucket: "receipts", id: p.id, dest: "files/receipts/" + safe(p.property_code + " - " + p.name) });
      folders.push({ bucket: "approvals", id: p.id, dest: "files/approvals/" + safe(p.property_code + " - " + p.name) });
    });
    data["vendors"].forEach(function(v) { folders.push({ bucket: "vendor-contracts", id: v.id, dest: "files/vendor contracts/" + safe(v.name) }); });
    var fileCount = 0;
    for (var i = 0; i < folders.length; i++) {
      btn.textContent = "Collecting files… (" + (i + 1) + " of " + folders.length + ")";
      var f = folders[i];
      var list = await sb.storage.from(f.bucket).list(f.id, { limit: 1000 });
      for (var j = 0; j < (list.data || []).length; j++) {
        var file = list.data[j];
        var dl = await sb.storage.from(f.bucket).download(f.id + "/" + file.name);
        if (dl.error) throw new Error("Couldn't download " + file.name + ": " + dl.error.message);
        zip.file(f.dest + "/" + file.name, dl.data);
        fileCount++;
      }
    }
    zip.file("README.txt", name + " — everything stored in StoneAnchor, downloaded " + new Date().toLocaleString("en-US") + ".\r\n\r\n" +
      "Each .csv file opens in Excel or Google Sheets. Uploaded files are in the \"files\" folder (" + fileCount + " files).\r\n" +
      "Work orders, maintenance and compliance items live in the company's own Asana and aren't included here.\r\n");

    btn.textContent = "Building zip file…";
    var blob = await zip.generateAsync({ type: "blob" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = safe(name) + " - StoneAnchor data - " + new Date().toISOString().slice(0, 10) + ".zip";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (e) {
    alert("Couldn't build the download: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

async function removeCompany() {
  var cid = currentCompanyId(), name = companyName(cid);
  var typed = document.getElementById("companyRemoveConfirm").value;
  if (typed.trim().toLowerCase() !== name.trim().toLowerCase()) {
    alert('Type the company\'s name exactly ("' + name + '") in the red-outlined box just above the button, then click Remove again.');
    document.getElementById("companyRemoveConfirm").focus();
    return;
  }
  if (!confirm("Permanently remove " + name + " and everything of theirs? This cannot be undone. Have you downloaded their data?")) return;
  var btn = document.getElementById("companyRemoveBtn");
  btn.textContent = "Removing…"; btn.disabled = true;
  var res = await sb.functions.invoke("manage-users", { body: { action: "removeCompany", companyId: cid, confirmName: typed } });
  btn.textContent = "Remove Company Permanently"; btn.disabled = false;
  if (res.error) { alert("Couldn't remove the company: " + (await edgeFunctionErrorMessage(res.error))); return; }
  var r = res.data.removed;
  alert(name + " has been removed (" + r.buildings + " buildings, " + r.logins + " logins, " + r.files + " files).");
  activeCompany = null;
  rememberCompany(null);
  activeCommunity = null;
  rememberCommunity(null);
  await loadCompanies();
  await loadProperties();
  showCompanyPicker();
}

async function saveCompanySettings(evt) {
  evt.preventDefault();
  var name = document.getElementById("companySettingName").value.trim();
  if (!name) return;
  var res = await sb.from("companies").update({
    name: name,
    asana_capex_project_gid: document.getElementById("companySettingCapexGid").value.trim() || null
  }).eq("id", currentCompanyId());
  if (res.error) { alert("Failed to save: " + res.error.message); return; }
  await loadCompanies();
  showCompanyName();
  applyCommunityLock();
  alert("Saved.");
}

async function saveCompanyAsanaKey(evt) {
  evt.preventDefault();
  var input = document.getElementById("companySettingAsanaKey");
  if (!input.value.trim()) { alert("Paste the new Asana key first."); return; }
  var res = await sb.rpc("set_company_asana_token", { c: currentCompanyId(), token: input.value });
  input.value = "";
  if (res.error) { alert("Couldn't save the key: " + res.error.message); return; }
  await loadCompanySettings();
  alert("Asana key saved. Run the health check to make sure it works.");
}

async function runCompanyHealthCheck() {
  var out = document.getElementById("companyHealthResults");
  var btn = document.getElementById("companyHealthBtn");
  btn.textContent = "Checking…"; btn.disabled = true;
  out.innerHTML = "";
  var db = await sb.rpc("company_health", { c: currentCompanyId() });
  var asana = await sb.functions.invoke("asana-proxy", { body: { action: "checkCompanyAsana", companyId: currentCompanyId() } });
  btn.textContent = "Run Health Check"; btn.disabled = false;
  if (db.error) { out.textContent = "Couldn't run the check: " + db.error.message; return; }
  if (asana.error) { out.textContent = "Couldn't reach Asana: " + (await edgeFunctionErrorMessage(asana.error)); return; }

  var h = db.data, a = asana.data, lines = [];
  function line(ok, text, fix) { lines.push({ ok: ok, text: text, fix: ok ? "" : fix }); }
  line(h.asanaKeySaved, "An Asana key is saved", "Add the company's Asana key above.");
  if (h.asanaKeySaved) line(a.keyWorks, a.keyWorks ? "Asana accepts the key (signed in as " + a.asanaUser + ")" : "Asana accepts the key", a.problem || "Get a new key from the company and save it above.");
  line(h.capexBoardSet && a.capexBoard !== false, "The CapEx To-Dos board is set and Asana can open it", "Check the CapEx To-Dos project ID above.");
  line(h.buildings > 0, h.buildings + (h.buildings === 1 ? " building" : " buildings"), "Add the company's buildings on Admin → Facilities.");
  (a.buildings || []).forEach(function(b) {
    var broken = [];
    if (!b.workOrders) broken.push("Work Orders ID");
    if (!b.maintenance) broken.push("Preventive Maintenance ID");
    if (!b.roomTurns) broken.push("Room Turns ID");
    if (!b.compliance) broken.push("Compliance section ID");
    if (!b.capexSection) broken.push("CapEx section name");
    line(!broken.length, b.name + ": every Asana link works", "Fix on Admin → Facilities → Edit: " + broken.join(", ") + ".");
  });
  line(h.admins > 0, h.admins + (h.admins === 1 ? " Admin" : " Admins"), "Invite their first Admin on Admin → Users, then make them an Admin.");
  line(h.peopleWithNoBuildings.length === 0, "Everyone who isn't an Admin has at least one building",
    "No buildings yet (they see nothing until given some): " + h.peopleWithNoBuildings.join(", "));
  line(h.crossCompanyAssignments === 0 && h.crossCompanyVendorLinks === 0, "Nothing is linked to another company's buildings",
    "Something is linked across companies — this shouldn't be possible. Stop and get help before going further.");
  line(true, h.people + (h.people === 1 ? " login" : " logins") + " and " + h.vendors + (h.vendors === 1 ? " vendor" : " vendors"), "");

  out.innerHTML = lines.map(function(l) {
    return '<div style="display:flex;gap:10px;padding:6px 0;border-bottom:1px solid var(--border);">' +
      '<span style="font-weight:700;color:' + (l.ok ? "var(--success)" : "var(--danger)") + ';">' + (l.ok ? "✓" : "✗") + '</span>' +
      '<span>' + escapeHtml(l.text) + (l.fix ? '<br><span style="color:var(--text-muted);font-size:12px;">' + escapeHtml(l.fix) + '</span>' : '') + '</span></div>';
  }).join("");
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
  var res = await sb.functions.invoke("manage-users", { body: { action: "invite", email: email, companyId: currentCompanyId() } });
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
  var res = await sb.from("profiles").select("*").eq("company_id", currentCompanyId()).order("email");
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
    // Nobody but the Executive can change their own access or the Executive's —
    // the database refuses it, so those rows are shown locked.
    var isMe = p.id === capexSession.user.id;
    var locked = !isExecutive() && (isMe || p.is_executive);
    var dis = locked ? ' disabled' : '';
    var facilityChecks = PROPERTIES.map(function(prop) {
      var checked = myCodes.indexOf(prop.code) !== -1 ? ' checked' : '';
      return '<label style="display:flex;align-items:center;gap:6px;font-weight:normal;">' +
        '<input type="checkbox" class="admin-facility-check" value="' + escapeHtml(prop.code) + '"' + checked + dis + ' /> ' + escapeHtml(prop.name) + '</label>';
    }).join("");
    var roleOptions = ['admin', 'editor', 'viewer', 'staff'].map(function(r) {
      var label = { admin: 'Admin', editor: 'Editor', viewer: 'Viewer', staff: 'Staff' }[r];
      return '<option value="' + r + '"' + (p.role === r ? ' selected' : '') + '>' + label + '</option>';
    }).join("");
    var note = isMe ? ' <span style="color:var(--text-muted)">(you)</span>' : (p.is_executive ? ' <span style="color:var(--text-muted)">(Executive)</span>' : '');
    return '<tr data-id="' + escapeHtml(p.id) + '" data-email="' + escapeHtml(p.email) + '">' +
      '<td>' + escapeHtml(p.email) + note + '</td>' +
      '<td><div style="display:flex;flex-direction:column;gap:4px;">' + (facilityChecks || '<span style="color:var(--text-muted)">No facilities yet</span>') + '</div></td>' +
      '<td><select class="admin-role-select"' + dis + '>' + roleOptions + '</select></td>' +
      '<td>' + (locked ? '' : '<button type="button" class="admin-save-btn">Save</button>') + '</td>' +
      '<td>' + (locked || isMe ? '' : '<button type="button" class="admin-save-btn user-remove-btn" style="color:var(--danger);border-color:var(--danger);">Remove</button>') + '</td>' +
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
