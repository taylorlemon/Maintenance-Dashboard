// Vendors tab: vendor list, which communities each vendor serves, contract
// uploads/expirations, CSV export.

let vendorsPropertyFilter = "all";
let vendorData = { vendors: [], contracts: [], vendorProperties: [] };
let expandedVendorId = null;

// ── Vendors, their communities, and contracts ───────────────────────────────

async function loadVendorsData() {
  await Promise.all([loadVendors(), loadVendorContracts(), loadVendorProperties()]);
}

async function loadVendors() {
  var res = await sb.from("vendors").select("*").order("name");
  if (res.error) { console.error(res.error); return; }
  vendorData.vendors = res.data;
  renderVendors();
}

async function loadVendorContracts() {
  var res = await sb.from("vendor_contracts").select("*").order("expires_on");
  if (res.error) { console.error(res.error); return; }
  vendorData.contracts = res.data;
  renderVendors();
}

// A vendor can now serve any number of communities (or none yet, if it's a
// freshly-added master-list entry waiting to be assigned). This table is the
// same readable-by-scope pattern as profile_properties: a non-admin only
// ever gets back the rows for communities they themselves have access to.
async function loadVendorProperties() {
  var res = await sb.from("vendor_properties").select("*");
  if (res.error) { console.error(res.error); return; }
  vendorData.vendorProperties = res.data;
  renderVendors();
}

function communityCodesForVendor(vendorId) {
  return vendorData.vendorProperties.filter(function(vp) { return vp.vendor_id === vendorId; }).map(function(vp) { return vp.property_code; });
}

function vendorsForFilter() {
  return vendorData.vendors.filter(function(v) {
    if (vendorsPropertyFilter === "all") return true;
    var codes = communityCodesForVendor(v.id);
    if (vendorsPropertyFilter === "unassigned") return codes.length === 0;
    return codes.indexOf(vendorsPropertyFilter) !== -1;
  });
}

function contractsForVendor(vendorId) {
  return vendorData.contracts.filter(function(c) { return c.vendor_id === vendorId; });
}

function applyVendorsPropertyFilter(val) {
  vendorsPropertyFilter = val;
  renderVendors();
}

// Contracts that expire within this many days count as "expiring soon" for
// the on-screen banner. This is independent of expiration_alert_sent_at,
// which only tracks whether the email has already gone out — the banner
// always reflects today's real situation.
var CONTRACT_WARNING_DAYS = 30;

function daysUntil(dateStr) {
  return daysBetween(today0(), new Date(dateStr + "T00:00:00"));
}

function renderContractsExpiringBanner() {
  var banner = document.getElementById("contractsExpiringBanner");
  var visibleVendorIds = {};
  // vendorData.vendors already only holds what this person can see (the
  // database enforces that), so any vendor here with at least one community
  // attached is fair game for the banner.
  var myVendors = vendorData.vendors.filter(function(v) { return currentProfile.role === "admin" || communityCodesForVendor(v.id).length > 0; });
  myVendors.forEach(function(v) { visibleVendorIds[v.id] = v; });

  var expiring = vendorData.contracts
    .filter(function(c) { return visibleVendorIds[c.vendor_id] && daysUntil(c.expires_on) <= CONTRACT_WARNING_DAYS; })
    .sort(function(a, b) { return new Date(a.expires_on) - new Date(b.expires_on); });

  if (expiring.length === 0) { banner.style.display = "none"; return; }

  var items = expiring.map(function(c) {
    var vendor = visibleVendorIds[c.vendor_id];
    var days = daysUntil(c.expires_on);
    var when = days < 0 ? "expired " + Math.abs(days) + "d ago" : (days === 0 ? "expires today" : "expires in " + days + "d");
    return (vendor ? vendor.name : "Vendor") + " — " + c.file_name + " (" + when + ")";
  });
  banner.textContent = expiring.length + " vendor contract" + (expiring.length === 1 ? "" : "s") + " expiring soon: " + items.join("; ");
  banner.style.display = "";
}

function renderVendors() {
  renderContractsExpiringBanner();
  var body = document.getElementById("vendorsTableBody");
  var list = vendorsForFilter();
  if (list.length === 0) { body.innerHTML = '<tr><td colspan="8" style="color:var(--text-muted)">No vendors yet.</td></tr>'; return; }

  var propName = {};
  PROPERTIES.forEach(function(pr) { propName[pr.code] = pr.name; });
  var isAdmin = currentProfile.role === "admin";
  var canEdit = currentProfile.role !== "viewer";
  var editableProperties = isAdmin ? PROPERTIES : visibleProperties();

  body.innerHTML = list.map(function(v) {
    var codes = communityCodesForVendor(v.id);
    var communitiesLabel = codes.length
      ? codes.map(function(c) { return propName[c] || c; }).join(", ")
      : '<span style="color:var(--text-muted)">Not assigned yet</span>';

    var contracts = contractsForVendor(v.id);
    var soonest = contracts.slice().sort(function(a, b) { return new Date(a.expires_on) - new Date(b.expires_on); })[0];
    var contractSummary = contracts.length === 0
      ? "None on file"
      : contracts.length + " on file" + (soonest ? " — next expires " + formatDateOnly(soonest.expires_on) : "");
    var mainRow = '<tr data-vendor-id="' + v.id + '">' +
      '<td>' + escapeHtml(v.name) + '</td>' +
      '<td>' + communitiesLabel + '</td>' +
      '<td>' + escapeHtml(v.trade || '—') + '</td>' +
      '<td>' + escapeHtml(v.contact_name || '—') + '</td>' +
      '<td>' + escapeHtml(v.phone || '—') + '</td>' +
      '<td>' + escapeHtml(v.email || '—') + '</td>' +
      '<td>' + contractSummary + '</td>' +
      '<td><button type="button" class="table-action-btn" onclick="toggleVendorExpand(\'' + v.id + '\')">' +
        (expandedVendorId === v.id ? 'Hide Details' : 'View Details') + '</button></td>' +
      '</tr>';

    if (expandedVendorId !== v.id) return mainRow;

    var contractRows = contracts.length === 0 ? '<div style="color:var(--text-muted);font-size:12px;">No contracts uploaded yet.</div>' :
      contracts.map(function(c) {
        var days = daysUntil(c.expires_on);
        var warn = days <= CONTRACT_WARNING_DAYS;
        return '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid var(--border);">' +
          '<div>' +
            '<a href="#" data-path="' + escapeHtml(c.file_path) + '" onclick="viewStoredFile(event, this, \'vendor-contracts\')">' + escapeHtml(c.file_name) + '</a>' +
            '<span style="margin-left:8px;font-size:11px;color:' + (warn ? 'var(--danger)' : 'var(--text-muted)') + '">expires ' + formatDateOnly(c.expires_on) + '</span>' +
          '</div>' +
          (canEdit ? '<button type="button" class="table-action-btn" onclick="deleteVendorContract(\'' + c.id + '\')">Delete</button>' : '') +
        '</div>';
      }).join("");

    var uploadForm = !canEdit ? "" : (
      '<div style="display:flex;align-items:flex-end;gap:12px;margin-top:12px;flex-wrap:wrap;">' +
        '<div class="capex-field">' +
          '<label class="config-label">New Contract File</label>' +
          '<input class="config-input" type="file" id="contractFileInput-' + v.id + '" />' +
        '</div>' +
        '<div class="capex-field">' +
          '<label class="config-label">Expires On</label>' +
          '<input class="config-input" type="date" id="contractExpiresInput-' + v.id + '" required />' +
        '</div>' +
        '<button type="button" class="config-btn" onclick="uploadVendorContract(\'' + v.id + '\')">Upload Contract</button>' +
      '</div>'
    );

    var deleteVendorBtn = !canEdit ? "" : '<button type="button" class="table-action-btn" style="color:var(--danger);border-color:var(--danger);margin-top:12px;" onclick="deleteVendor(\'' + v.id + '\')">Remove Vendor</button>';

    var communitiesEditor;
    if (!canEdit) {
      communitiesEditor = '<div style="font-size:13px;">' + (codes.length ? codes.map(function(c) { return propName[c] || c; }).join(", ") : 'Not assigned to a community yet.') + '</div>';
    } else {
      // Admins see every community and can attach or detach any of them.
      // Editors only ever see checkboxes for their own communities — this is
      // what keeps an Editor from reaching in and touching a community that
      // isn't theirs, even for a vendor that's shared with other communities.
      var checks = editableProperties.map(function(p) {
        var checked = codes.indexOf(p.code) !== -1 ? ' checked' : '';
        return '<label style="display:flex;align-items:center;gap:6px;font-weight:normal;">' +
          '<input type="checkbox" class="vendor-property-check" value="' + p.code + '"' + checked + ' /> ' + p.name + '</label>';
      }).join("");
      communitiesEditor = '<div class="vendor-communities-edit" style="display:flex;flex-direction:column;gap:6px;max-width:320px;">' +
        (checks || '<span style="color:var(--text-muted);font-size:13px;">No communities in your access to assign.</span>') +
        '<button type="button" class="table-action-btn" style="align-self:flex-start;margin-top:4px;" onclick="saveVendorCommunities(\'' + v.id + '\', this)">Save Communities</button>' +
        '</div>';
    }

    var detailRow = '<tr><td colspan="8">' +
      '<div style="background:var(--bg-alt);border-radius:8px;padding:16px;display:flex;gap:24px;flex-wrap:wrap;">' +
        '<div style="flex:1;min-width:220px;">' +
          (v.notes ? '<div style="margin-bottom:12px;font-size:13px;">' + escapeHtml(v.notes) + '</div>' : '') +
          '<div style="font-size:11px;text-transform:uppercase;color:var(--text-muted);margin-bottom:8px;">Contracts</div>' +
          contractRows +
          uploadForm +
          deleteVendorBtn +
        '</div>' +
        '<div style="flex:1;min-width:220px;">' +
          '<div style="font-size:11px;text-transform:uppercase;color:var(--text-muted);margin-bottom:8px;">Communities</div>' +
          communitiesEditor +
        '</div>' +
      '</div>' +
      '</td></tr>';

    return mainRow + detailRow;
  }).join("");
}

function toggleVendorExpand(id) {
  expandedVendorId = expandedVendorId === id ? null : id;
  renderVendors();
}

async function saveVendorCommunities(vendorId, btn) {
  if (!requireEditAccess()) return;
  var container = btn.closest(".vendor-communities-edit");
  var checked = Array.prototype.slice.call(container.querySelectorAll(".vendor-property-check:checked")).map(function(c) { return c.value; });
  var current = communityCodesForVendor(vendorId);
  var toAdd = checked.filter(function(code) { return current.indexOf(code) === -1; });
  var toRemove = current.filter(function(code) { return checked.indexOf(code) === -1; });
  if (!toAdd.length && !toRemove.length) return;

  btn.textContent = "Saving…"; btn.disabled = true;
  if (toAdd.length) {
    var insRes = await sb.from("vendor_properties").insert(toAdd.map(function(code) { return { vendor_id: vendorId, property_code: code }; }));
    if (insRes.error) { alert("Failed to save communities: " + insRes.error.message); btn.textContent = "Save Communities"; btn.disabled = false; return; }
  }
  if (toRemove.length) {
    var delRes = await sb.from("vendor_properties").delete().eq("vendor_id", vendorId).in("property_code", toRemove);
    if (delRes.error) { alert("Failed to save communities: " + delRes.error.message); btn.textContent = "Save Communities"; btn.disabled = false; return; }
  }
  await loadVendorProperties();
}

async function handleAddVendor(evt) {
  evt.preventDefault();
  if (!requireEditAccess()) return;
  var isAdmin = currentProfile.role === "admin";

  // Admins add a vendor straight onto the master list with no community
  // picked yet — it gets attached to whichever communities it serves later,
  // from its "Communities" section in the list below. Editors still pick at
  // least one of their own communities right away, since they've no way to
  // browse and attach an unassigned vendor afterward (that master list is
  // Admin-only, so nothing they add would stay visible to them otherwise).
  var codes = isAdmin ? [] : Array.prototype.slice.call(
    document.querySelectorAll("#vendorPropertiesCheckboxes .vendor-property-check:checked")
  ).map(function(c) { return c.value; });
  if (!isAdmin && codes.length === 0) { alert("Check at least one community this vendor serves."); return; }

  var payload = {
    id: crypto.randomUUID(),
    name: document.getElementById("vendorNameInput").value.trim(),
    trade: document.getElementById("vendorTradeInput").value.trim() || null,
    contact_name: document.getElementById("vendorContactNameInput").value.trim() || null,
    phone: document.getElementById("vendorPhoneInput").value.trim() || null,
    email: document.getElementById("vendorEmailInput").value.trim() || null,
    notes: document.getElementById("vendorNotesInput").value.trim() || null,
    created_by: capexSession.user.id
  };
  if (!payload.name) { alert("Enter a vendor name."); return; }

  var res = await sb.from("vendors").insert(payload);
  if (res.error) { alert("Failed to add vendor: " + res.error.message); return; }

  if (codes.length) {
    var linkRes = await sb.from("vendor_properties").insert(codes.map(function(code) { return { vendor_id: payload.id, property_code: code }; }));
    if (linkRes.error) {
      alert("The vendor was added, but attaching communities failed: " + linkRes.error.message + ". Removing the incomplete entry — try again.");
      await sb.from("vendors").delete().eq("id", payload.id);
      return;
    }
  }

  evt.target.reset();
  await loadVendorsData();
}

async function deleteVendor(id) {
  if (!requireEditAccess()) return;
  var v = vendorData.vendors.find(function(x) { return x.id === id; });
  var contracts = contractsForVendor(id);
  var warning = 'Remove "' + (v ? v.name : "this vendor") + '" from the system?' +
    (contracts.length ? ' This also deletes ' + contracts.length + ' contract file' + (contracts.length === 1 ? '' : 's') + ' on file for them.' : '');
  if (!confirm(warning)) return;
  var res = await sb.from("vendors").delete().eq("id", id);
  if (res.error) { alert("Failed to remove vendor: " + res.error.message); return; }
  expandedVendorId = null;
  await loadVendorsData();
}

async function uploadVendorContract(vendorId) {
  if (!requireEditAccess()) return;
  var fileInput = document.getElementById("contractFileInput-" + vendorId);
  var expiresInput = document.getElementById("contractExpiresInput-" + vendorId);
  var file = fileInput.files[0];
  if (!file) { alert("Choose a file to upload."); return; }
  if (!expiresInput.value) { alert("Enter the contract's expiration date."); return; }
  var path = vendorId + "/" + Date.now() + "-" + file.name;
  var uploadRes = await sb.storage.from("vendor-contracts").upload(path, file);
  if (uploadRes.error) { alert("Failed to upload contract: " + uploadRes.error.message); return; }
  var insRes = await sb.from("vendor_contracts").insert({
    vendor_id: vendorId,
    file_path: path,
    file_name: file.name,
    expires_on: expiresInput.value,
    uploaded_by: capexSession.user.id
  });
  if (insRes.error) { alert("Failed to save contract record: " + insRes.error.message); return; }
  await loadVendorContracts();
}

async function deleteVendorContract(id) {
  if (!requireEditAccess()) return;
  var c = vendorData.contracts.find(function(x) { return x.id === id; });
  if (!confirm('Delete "' + (c ? c.file_name : "this contract") + '"?')) return;
  if (c) { await sb.storage.from("vendor-contracts").remove([c.file_path]); }
  var res = await sb.from("vendor_contracts").delete().eq("id", id);
  if (res.error) { alert("Failed to delete contract: " + res.error.message); return; }
  await loadVendorContracts();
}

// ── Add Vendor form: community checkboxes ───────────────────────────────────
// Admins skip community picking entirely when adding a vendor (see
// handleAddVendor) — the field only shows up for Editors, listing just the
// communities they themselves have access to.
function renderVendorPropertiesCheckboxes() {
  var field = document.getElementById("vendorPropertiesField");
  var box = document.getElementById("vendorPropertiesCheckboxes");
  if (!currentProfile || currentProfile.role === "admin") {
    field.style.display = "none";
    box.innerHTML = "";
    return;
  }
  field.style.display = "";
  box.innerHTML = visibleProperties().map(function(p) {
    return '<label style="display:flex;align-items:center;gap:6px;font-weight:normal;">' +
      '<input type="checkbox" class="vendor-property-check" value="' + p.code + '" /> ' + p.name + '</label>';
  }).join("");
}

async function exportVendorsCSV(btnEl) {
  var list = vendorsForFilter();
  if (list.length === 0) { alert("No vendors to export yet."); return; }

  var originalText = btnEl.textContent;
  btnEl.disabled = true;
  btnEl.textContent = "Exporting…";

  try {
    var propName = {};
    PROPERTIES.forEach(function(pr) { propName[pr.code] = pr.name; });

    var header = ["Communities", "Vendor Name", "Trade", "Contact Name", "Phone", "Email", "Notes", "Contracts On File", "Next Expiration"];
    var rows = list.map(function(v) {
      var contracts = contractsForVendor(v.id);
      var soonest = contracts.slice().sort(function(a, b) { return new Date(a.expires_on) - new Date(b.expires_on); })[0];
      var communities = communityCodesForVendor(v.id).map(function(c) { return propName[c] || c; }).join("; ");
      return [
        communities,
        v.name,
        v.trade || "",
        v.contact_name || "",
        v.phone || "",
        v.email || "",
        v.notes || "",
        contracts.length,
        soonest ? formatDateOnly(soonest.expires_on) : ""
      ].map(csvField).join(",");
    });

    var csv = "﻿" + [header.map(csvField).join(","), rows.join("\r\n")].join("\r\n");
    var blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    var communityLabel = vendorsPropertyFilter === "all" ? "All Communities" : (vendorsPropertyFilter === "unassigned" ? "Unassigned" : (propName[vendorsPropertyFilter] || vendorsPropertyFilter));
    var fileSafeCommunity = communityLabel.replace(/[\\/:*?"<>|]/g, "-");
    a.download = "vendors-" + fileSafeCommunity + "-" + new Date().toISOString().slice(0, 10) + ".csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (e) {
    alert("Failed to export vendors: " + e.message);
  } finally {
    btnEl.disabled = false;
    btnEl.textContent = originalText;
  }
}
