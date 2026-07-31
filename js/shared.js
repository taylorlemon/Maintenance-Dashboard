// Shared across every tab: the Supabase client, the signed-in user's
// session/profile/permissions, and small helpers more than one tab uses.
// Loaded before the per-tab files (js/workorders.js, js/vendors.js,
// js/admin.js, js/capex.js).

let PROPERTIES = [];

async function loadProperties() {
  var res = await sb.from("properties").select("*").order("name");
  if (res.error) { console.error(res.error); return; }
  PROPERTIES = res.data.map(function(row) {
    return { code: row.code, name: row.name, gid: row.asana_project_gid, pmGid: row.asana_pm_section_gid, rtGid: row.asana_rt_section_gid, complianceGid: row.asana_compliance_section_gid };
  });
}

const SUPABASE_URL = "https://yjrcosafkymedmownfny.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlqcmNvc2Fma3ltZWRtb3duZm55Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ1NjMzOTYsImV4cCI6MjEwMDEzOTM5Nn0.7EkVhWlm1RSKdNf9gNYsvtkC8SBO7sHh_fDk8u6VBKU";

function daysBetween(d1, d2) {
  return Math.round((new Date(d2) - new Date(d1)) / 86400000);
}

function today0() {
  var d = new Date(); d.setHours(0,0,0,0); return d;
}

function switchTab(tab) {
  document.getElementById("tabWorkOrders").classList.toggle("active", tab === "workorders");
  document.getElementById("tabCapex").classList.toggle("active", tab === "capex");
  document.getElementById("tabVendors").classList.toggle("active", tab === "vendors");
  document.getElementById("tabCompliance").classList.toggle("active", tab === "compliance");
  document.getElementById("tabAdmin").classList.toggle("active", tab === "admin");
  document.getElementById("workOrdersPanel").style.display = tab === "workorders" ? "" : "none";
  document.getElementById("capexPanel").style.display = tab === "capex" ? "" : "none";
  document.getElementById("vendorsPanel").style.display = tab === "vendors" ? "" : "none";
  document.getElementById("compliancePanel").style.display = tab === "compliance" ? "" : "none";
  document.getElementById("adminPanel").style.display = tab === "admin" ? "" : "none";
  if (tab === "vendors") loadVendorsData();
  if (tab === "compliance") loadComplianceData();
  if (tab === "admin") { loadAdminFacilities(); loadAdminUsers(); }
}

let sb = null;
let capexSession = null;
let currentProfile = null;
let myPropertyCodes = []; // facility codes the signed-in person has been given, from profile_properties

// Goes through the "asana-proxy" Supabase Edge Function instead of calling
// Asana directly — the Asana key lives only on that server, never in this
// page, and the function itself checks that whatever project/section this
// path asks for actually belongs to a company the signed-in person can see.
// Used by both the Work Orders and Building Compliance tabs.
async function asanaFetch(path) {
  var res = await sb.functions.invoke("asana-proxy", { body: { path: path } });
  if (res.error) throw new Error("Asana request failed: " + (await edgeFunctionErrorMessage(res.error)));
  return res.data;
}

// The generic wrapper message an Edge Function call fails with ("non-2xx
// status code") hides the actual reason the function rejected the request —
// pull the real one out of the response body it sent back, when there is one.
async function edgeFunctionErrorMessage(error) {
  if (error.context && typeof error.context.json === "function") {
    try {
      var body = await error.context.json();
      // Supabase itself occasionally has a brief hiccup and hands back an
      // error with no real explanation in it — that shows up here as the
      // literal text "{}", which isn't useful to show as-is.
      if (body && body.error && body.error !== "{}") return body.error;
    } catch (e) { /* response wasn't JSON — fall back to the generic message */ }
  }
  return "Supabase might be having a brief issue on their end — wait a minute and try again. (" + error.message + ")";
}

function initSupabase() {
  if (!window.supabase || SUPABASE_URL.indexOf("YOUR_SUPABASE") === 0) return null;
  return window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

async function initAuth() {
  sb = initSupabase();
  if (!sb) {
    var note = document.getElementById("loginNote");
    note.textContent = "Supabase isn't configured yet — set SUPABASE_URL / SUPABASE_ANON_KEY near the top of the script in index.html.";
    note.style.color = "var(--danger)";
    return;
  }

  // Invite/reset emails land here with #...&type=invite (or type=recovery) in the
  // address bar. supabase-js reads that automatically and creates a session, but
  // the person still needs to pick a password — show that screen instead of login.
  var hash = window.location.hash;
  var isFirstTimeLink = hash.indexOf("type=invite") !== -1 || hash.indexOf("type=recovery") !== -1;

  var res = await sb.auth.getSession();

  if (isFirstTimeLink && res.data.session) {
    document.getElementById("loginPanel").style.display = "none";
    document.getElementById("setPasswordPanel").style.display = "block";
    history.replaceState(null, "", window.location.pathname + window.location.search);
    return;
  }

  if (res.data.session) { capexSession = res.data.session; onAuthed(); }
}

async function doSetPassword() {
  var pw = document.getElementById("newPasswordInput").value;
  var pw2 = document.getElementById("newPasswordInput2").value;
  var note = document.getElementById("setPasswordNote");
  if (!pw || pw.length < 8) { note.textContent = "Password must be at least 8 characters."; note.style.color = "var(--danger)"; return; }
  if (pw !== pw2) { note.textContent = "Those passwords don't match — try again."; note.style.color = "var(--danger)"; return; }
  note.textContent = "Saving…"; note.style.color = "var(--text-muted)";
  var res = await sb.auth.updateUser({ password: pw });
  if (res.error) { note.textContent = res.error.message; note.style.color = "var(--danger)"; return; }
  var sessionRes = await sb.auth.getSession();
  capexSession = sessionRes.data.session;
  document.getElementById("setPasswordPanel").style.display = "none";
  onAuthed();
}

async function doLogin() {
  var email = document.getElementById("loginEmailInput").value.trim();
  var password = document.getElementById("loginPasswordInput").value;
  if (!email || !password) { alert("Enter your email and password."); return; }
  var note = document.getElementById("loginNote");
  note.textContent = "Signing in…"; note.style.color = "var(--text-muted)";
  var res = await sb.auth.signInWithPassword({ email: email, password: password });
  if (res.error) { note.textContent = res.error.message; note.style.color = "var(--danger)"; return; }
  capexSession = res.data.session;
  onAuthed();
}

async function doSignOut() {
  await sb.auth.signOut();
  capexSession = null;
  currentProfile = null;
  document.getElementById("mainApp").style.display = "none";
  document.getElementById("welcomeScreen").style.display = "block";
  document.getElementById("unassignedPanel").style.display = "none";
  document.getElementById("loginPanel").style.display = "block";
  document.getElementById("loginEmailInput").value = "";
  document.getElementById("loginPasswordInput").value = "";
}

// A signed-in person's row in the "profiles" table — their role (admin,
// editor, or viewer). Created automatically when they're invited; see
// supabase-schema.sql. Which facilities they can see lives separately, in
// profile_properties, loaded by loadMyPropertyCodes() below.
async function loadMyProfile() {
  var res = await sb.from("profiles").select("*").eq("id", capexSession.user.id).single();
  if (res.error) { console.error(res.error); return null; }
  return res.data;
}

async function loadMyPropertyCodes() {
  var res = await sb.from("profile_properties").select("property_code").eq("profile_id", capexSession.user.id);
  if (res.error) { console.error(res.error); return []; }
  return res.data.map(function(row) { return row.property_code; });
}

// Everything a signed-in person is allowed to see: every facility for an
// admin, or just the facilities they've been assigned for everyone else.
function visibleProperties() {
  if (!currentProfile || currentProfile.role === "admin") return PROPERTIES;
  return PROPERTIES.filter(function(p) { return myPropertyCodes.indexOf(p.code) !== -1; });
}

// Removes every option from a property dropdown except the facilities a
// non-admin is allowed to see. Locks the dropdown only if that leaves them
// with exactly one choice.
function restrictSelectToProperties(selectEl, codes) {
  Array.prototype.slice.call(selectEl.options).forEach(function(opt) {
    if (opt.value === "all" || opt.value === "") return;
    if (codes.indexOf(opt.value) === -1) opt.remove();
  });
  if (codes.length === 1) {
    selectEl.value = codes[0];
    selectEl.disabled = true;
  } else {
    selectEl.disabled = false;
  }
}

// Viewers can look at every tab except Admin, but can't add, edit, upload,
// or delete anything — hide the two main "add new" forms and the budget
// editor. The mutating functions themselves also refuse to run for a
// Viewer (see requireEditAccess), so this is a convenience, not the only
// thing standing in the way — the database enforces this too.
function applyViewerReadOnly() {
  var isViewer = currentProfile.role === "viewer";
  document.body.classList.toggle("role-viewer", isViewer);
  document.getElementById("projectForm").style.display = isViewer ? "none" : "";
  document.getElementById("expenseForm").style.display = isViewer ? "none" : "";
  document.getElementById("vendorForm").style.display = isViewer ? "none" : "";
  var budgetSet = document.querySelector(".annual-budget-set");
  if (budgetSet) budgetSet.style.display = isViewer ? "none" : "";
}

function requireEditAccess() {
  if (currentProfile && currentProfile.role === "viewer") {
    alert("You have view-only access and can't make changes here.");
    return false;
  }
  return true;
}

function applyAccessRestrictions() {
  var isAdmin = currentProfile.role === "admin";
  document.getElementById("tabAdmin").style.display = isAdmin ? "" : "none";
  applyViewerReadOnly();
  if (isAdmin) return;
  restrictSelectToProperties(document.getElementById("viewSelect"), myPropertyCodes);
  restrictSelectToProperties(document.getElementById("capexPropertySelect"), myPropertyCodes);
  restrictSelectToProperties(document.getElementById("projPropertyInput"), myPropertyCodes);
  restrictSelectToProperties(document.getElementById("expPropertyInput"), myPropertyCodes);
  restrictSelectToProperties(document.getElementById("vendorsPropertySelect"), myPropertyCodes);
  if (myPropertyCodes.length === 1) { capexPropertyFilter = myPropertyCodes[0]; vendorsPropertyFilter = myPropertyCodes[0]; }
}

async function onAuthed() {
  document.getElementById("loginPanel").style.display = "none";
  document.getElementById("setPasswordPanel").style.display = "none";
  document.getElementById("signedInAs").textContent = "Signed in as " + capexSession.user.email;

  currentProfile = await loadMyProfile();
  myPropertyCodes = currentProfile ? await loadMyPropertyCodes() : [];

  if (!currentProfile || (currentProfile.role !== "admin" && myPropertyCodes.length === 0)) {
    document.getElementById("unassignedPanel").style.display = "block";
    document.getElementById("welcomeScreen").style.display = "block";
    document.getElementById("mainApp").style.display = "none";
    return;
  }

  document.getElementById("unassignedPanel").style.display = "none";
  document.getElementById("welcomeScreen").style.display = "none";
  document.getElementById("mainApp").style.display = "block";
  await loadProperties();
  populatePropertySelects();
  applyAccessRestrictions();
  loadCapexData();
  loadAll();
}

function propertyOptionsHtml(allOption) {
  var opts = allOption ? '<option value="all">' + allOption + '</option>' : "";
  return opts + PROPERTIES.map(function(p) { return '<option value="' + p.code + '">' + p.name + '</option>'; }).join("");
}

// Rebuilds every property dropdown from the current facility list. Called
// after sign-in and again any time a facility is added or removed on the
// Admin tab, so every dropdown across the app stays current.
function populatePropertySelects() {
  document.getElementById("viewSelect").innerHTML = propertyOptionsHtml("All Properties — Overview");
  document.getElementById("capexPropertySelect").innerHTML = propertyOptionsHtml("All Properties");
  document.getElementById("projPropertyInput").innerHTML = propertyOptionsHtml(null);
  document.getElementById("expPropertyInput").innerHTML = propertyOptionsHtml(null);
  // "Unassigned" only means anything to an Admin (it's the master-list vendors
  // with no community attached yet) — restrictSelectToProperties strips it
  // back out for anyone else, same as it does for every other option here.
  document.getElementById("vendorsPropertySelect").innerHTML = propertyOptionsHtml("All Communities") + '<option value="unassigned">Unassigned</option>';
  renderVendorPropertiesCheckboxes();
}

// Escapes text pulled from the database (names, notes, uploaded filenames) before it
// gets dropped into innerHTML, so a stray quote or "<" in someone's typed input can't
// break the page or inject markup.
function escapeHtml(str) {
  return String(str == null ? "" : str).replace(/[&<>"']/g, function(c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

function formatDateOnly(dateStr) {
  return new Date(dateStr + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// Wraps a value for CSV: quotes it (doubling any inner quotes) whenever it
// contains a comma, quote, or line break, so the file stays one column per field.
function csvField(val) {
  var s = (val === null || val === undefined) ? "" : String(val);
  if (/[",\r\n]/.test(s)) { s = '"' + s.replace(/"/g, '""') + '"'; }
  return s;
}

// Opens a signed (temporary) URL for a private file in Storage — used for both the
// live approval proof link and "View file" links inside History entries.
function viewStoredFile(event, el, bucket) {
  event.preventDefault();
  var path = el.getAttribute("data-path");
  if (!path) return;
  sb.storage.from(bucket).createSignedUrl(path, 3600).then(function(res) {
    if (res.data) { window.open(res.data.signedUrl, "_blank"); }
    else { alert("Could not open file."); }
  });
}

