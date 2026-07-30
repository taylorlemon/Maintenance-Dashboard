// Vendors tab: vendor list, contract uploads/expirations, CSV export.

let vendorsPropertyFilter = "all";
let vendorData = { vendors: [], contracts: [] };
let expandedVendorId = null;

// ── Vendors and contracts ────────────────────────────────────────────────────

async function loadVendorsData() {
  await Promise.all([loadVendors(), loadVendorContracts()]);
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

function vendorsForFilter() {
  return vendorData.vendors.filter(function(v) { return vendorsPropertyFilter === "all" || v.property_code === vendorsPropertyFilter; });
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
  var myVendors = vendorData.vendors.filter(function(v) { return currentProfile.role === "admin" || myPropertyCodes.indexOf(v.property_code) !== -1; });
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
  if (list.length === 0) { body.innerHTML = '<tr><td colspan="7" style="color:var(--text-muted)">No vendors yet.</td></tr>'; return; }

  var propName = {};
  PROPERTIES.forEach(function(pr) { propName[pr.code] = pr.name; });
  var canEdit = currentProfile.role !== "viewer";

  body.innerHTML = list.map(function(v) {
    var contracts = contractsForVendor(v.id);
    var soonest = contracts.slice().sort(function(a, b) { return new Date(a.expires_on) - new Date(b.expires_on); })[0];
    var contractSummary = contracts.length === 0
      ? "None on file"
      : contracts.length + " on file" + (soonest ? " — next expires " + formatDateOnly(soonest.expires_on) : "");
    var mainRow = '<tr data-vendor-id="' + v.id + '">' +
      '<td>' + escapeHtml(v.name) + '</td>' +
      '<td>' + escapeHtml(v.trade || '—') + '</td>' +
      '<td>' + escapeHtml(v.contact_name || '—') + '</td>' +
      '<td>' + escapeHtml(v.phone || '—') + '</td>' +
      '<td>' + escapeHtml(v.email || '—') + '</td>' +
      '<td>' + contractSummary + '</td>' +
      '<td><button type="button" class="table-action-btn" onclick="toggleVendorExpand(\'' + v.id + '\')">' +
        (expandedVendorId === v.id ? 'Hide Contracts' : 'View / Upload Contracts') + '</button></td>' +
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

    var detailRow = '<tr><td colspan="7">' +
      '<div style="background:var(--bg-alt);border-radius:8px;padding:16px;">' +
        (v.notes ? '<div style="margin-bottom:12px;font-size:13px;">' + escapeHtml(v.notes) + '</div>' : '') +
        '<div style="font-size:11px;text-transform:uppercase;color:var(--text-muted);margin-bottom:8px;">' + (propName[v.property_code] || v.property_code) + ' — Contracts</div>' +
        contractRows +
        uploadForm +
        deleteVendorBtn +
      '</div>' +
      '</td></tr>';

    return mainRow + detailRow;
  }).join("");
}

function toggleVendorExpand(id) {
  expandedVendorId = expandedVendorId === id ? null : id;
  renderVendors();
}

async function handleAddVendor(evt) {
  evt.preventDefault();
  if (!requireEditAccess()) return;
  var payload = {
    property_code: document.getElementById("vendorPropertyInput").value,
    name: document.getElementById("vendorNameInput").value.trim(),
    trade: document.getElementById("vendorTradeInput").value.trim() || null,
    contact_name: document.getElementById("vendorContactNameInput").value.trim() || null,
    phone: document.getElementById("vendorPhoneInput").value.trim() || null,
    email: document.getElementById("vendorEmailInput").value.trim() || null,
    notes: document.getElementById("vendorNotesInput").value.trim() || null,
    created_by: capexSession.user.id
  };
  if (!payload.name || !payload.property_code) { alert("Enter a vendor name."); return; }
  var res = await sb.from("vendors").insert(payload);
  if (res.error) { alert("Failed to add vendor: " + res.error.message); return; }
  evt.target.reset();
  await loadVendors();
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

async function exportVendorsCSV(btnEl) {
  var list = vendorsForFilter();
  if (list.length === 0) { alert("No vendors to export yet."); return; }

  var originalText = btnEl.textContent;
  btnEl.disabled = true;
  btnEl.textContent = "Exporting…";

  try {
    var propName = {};
    PROPERTIES.forEach(function(pr) { propName[pr.code] = pr.name; });

    var header = ["Property", "Vendor Name", "Trade", "Contact Name", "Phone", "Email", "Notes", "Contracts On File", "Next Expiration"];
    var rows = list.map(function(v) {
      var contracts = contractsForVendor(v.id);
      var soonest = contracts.slice().sort(function(a, b) { return new Date(a.expires_on) - new Date(b.expires_on); })[0];
      return [
        propName[v.property_code] || v.property_code,
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
    var communityLabel = vendorsPropertyFilter === "all" ? "All Properties" : (propName[vendorsPropertyFilter] || vendorsPropertyFilter);
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
