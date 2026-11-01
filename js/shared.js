// Shared across every tab: the Supabase client, the signed-in user's
// session/profile/permissions, and small helpers more than one tab uses.
// Loaded before the per-tab files (js/workorders.js, js/vendors.js,
// js/admin.js, js/capex.js).

// Every facility the database lets this person see. PROPERTIES is the subset
// the site is working with right now: the same list for everyone except the
// Executive, who sees every company's facilities and works in one picked
// company at a time (see the company picker below).
let ALL_PROPERTIES = [];
let PROPERTIES = [];

async function loadProperties() {
  var res = await sb.from("properties").select("*").order("name");
  if (res.error) { console.error(res.error); return; }
  ALL_PROPERTIES = res.data.map(function(row) {
    return { code: row.code, name: row.name, companyId: row.company_id, timeZone: row.time_zone, capexSection: row.asana_capex_section_name,
      gid: row.asana_project_gid, pmGid: row.asana_pm_section_gid, rtGid: row.asana_rt_section_gid, complianceGid: row.asana_compliance_section_gid };
  });
  applyCompanyScope();
}

function applyCompanyScope() {
  PROPERTIES = isExecutive() && activeCompany
    ? ALL_PROPERTIES.filter(function(p) { return p.companyId === activeCompany; })
    : ALL_PROPERTIES;
}

// Records the database sends back can include other companies' facilities for
// the Executive; each tab keeps only the ones in the company being worked in.
function inCurrentCompany(code) {
  return PROPERTIES.some(function(p) { return p.code === code; });
}

// Which database this copy of the site talks to. The live website always uses
// the real one. Any other copy (e.g. index.html opened straight from this
// computer) uses the test project, which holds fake companies only, and shows
// a TEST banner so the two can never be mixed up.
const LIVE_HOSTS = ["my.stoneanchor.app", "taylorlemon.github.io"];
const IS_TEST_DB = LIVE_HOSTS.indexOf(location.hostname) === -1;
const SUPABASE_URL = IS_TEST_DB
  ? "https://ffxlugjlooqdakidradi.supabase.co"
  : "https://yjrcosafkymedmownfny.supabase.co";
const SUPABASE_ANON_KEY = IS_TEST_DB
  ? "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZmeGx1Z2psb29xZGFraWRyYWRpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM0MjE4NTMsImV4cCI6MjEwODk5Nzg1M30.Zh3Z5O6eGmhTST4eA1t2gjDKVAbgES01nsPPfkReM2k"
  : "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlqcmNvc2Fma3ltZWRtb3duZm55Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ1NjMzOTYsImV4cCI6MjEwMDEzOTM5Nn0.7EkVhWlm1RSKdNf9gNYsvtkC8SBO7sHh_fDk8u6VBKU";

if (IS_TEST_DB) {
  document.addEventListener("DOMContentLoaded", function() {
    var banner = document.createElement("div");
    banner.className = "test-db-banner";
    banner.textContent = "TEST COPY — fake companies only. Nothing here touches the live site.";
    document.body.insertBefore(banner, document.body.firstChild);
    document.title = "TEST — " + document.title;
  });
}

// Error tracking: reports JavaScript errors to Sentry so problems can be
// caught without waiting for someone to report them. Does nothing until a
// real DSN (Sentry's project address) replaces the placeholder below.
const SENTRY_DSN = "https://e7524e9c7b498f7f6af7ce7da5754cc8@o4511895472111616.ingest.us.sentry.io/4511895481810944";
if (typeof Sentry !== "undefined" && SENTRY_DSN.indexOf("PASTE_YOUR") === -1) {
  Sentry.init({ dsn: SENTRY_DSN });
}

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
  if (tab === "admin") { loadAdminFacilities(); loadAdminUsers(); renderExpenseAudit(); }
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

// Mirrors a CapEx to-do into the shared "CapEx To-Dos" Asana board, filed
// under the section for whichever facility the to-do belongs to. Used by
// addProjectTodo (js/capex.js). Throws on failure — callers should catch
// this and report it to Sentry rather than interrupt the person adding the
// to-do, since the to-do itself already saved successfully in Supabase.
async function asanaCreateCapexTodoTask(propertyCode, title, projectName) {
  var res = await sb.functions.invoke("asana-proxy", {
    body: { action: "createCapexTodoTask", propertyCode: propertyCode, title: title, projectName: projectName }
  });
  if (res.error) throw new Error("Asana task creation failed: " + (await edgeFunctionErrorMessage(res.error)));
  return res.data;
}

// Marks a to-do's matching Asana task complete/incomplete (if it has one —
// to-dos created before this existed, or where the initial Asana sync
// failed, simply have nothing to update). Used by toggleTodo (js/capex.js).
// Throws on failure — callers should catch this and report it to Sentry
// rather than interrupt the person checking the to-do off, since the
// checkbox itself already saved successfully in Supabase.
async function asanaSetCapexTodoCompletion(todoId, completed) {
  var res = await sb.functions.invoke("asana-proxy", {
    body: { action: "completeCapexTodoTask", todoId: todoId, completed: completed }
  });
  if (res.error) throw new Error("Asana task update failed: " + (await edgeFunctionErrorMessage(res.error)));
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
  activeCommunity = null;
  rememberCommunity(null);
  activeCompany = null;
  rememberCompany(null);
  document.getElementById("mainApp").style.display = "none";
  document.getElementById("communityPicker").style.display = "none";
  document.getElementById("companyPicker").style.display = "none";
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
  if (isAdmin) applyFacilitiesAccess();
  applyViewerReadOnly();
  if (isAdmin) return;
  restrictSelectToProperties(document.getElementById("viewSelect"), myPropertyCodes);
  restrictSelectToProperties(document.getElementById("capexPropertySelect"), myPropertyCodes);
  restrictSelectToProperties(document.getElementById("projPropertyInput"), myPropertyCodes);
  restrictSelectToProperties(document.getElementById("vendorsPropertySelect"), myPropertyCodes);
  if (myPropertyCodes.length === 1) { capexPropertyFilter = myPropertyCodes[0]; vendorsPropertyFilter = myPropertyCodes[0]; }
}

async function onAuthed() {
  document.getElementById("loginPanel").style.display = "none";
  document.getElementById("setPasswordPanel").style.display = "none";
  document.getElementById("signedInAs").textContent = "Signed in as " + capexSession.user.email;

  currentProfile = await loadMyProfile();
  myPropertyCodes = currentProfile ? await loadMyPropertyCodes() : [];

  // A paused company's people can sign in but see nothing (see
  // 04-pause-and-remove.sql) — tell them why rather than show an empty site.
  var paused = currentProfile && !currentProfile.is_executive && (await sb.rpc("my_company_paused")).data === true;
  document.getElementById("unassignedTitle").textContent = paused ? "Access Paused" : "Almost There";
  document.getElementById("unassignedNote").textContent = paused
    ? "Your company's StoneAnchor access is paused right now. Please contact StoneAnchor to restore it."
    : "Your account is set up, but you haven't been given access to any facilities yet. Ask an administrator to assign you, then sign out and back in.";
  if (paused) {
    document.getElementById("unassignedPanel").style.display = "block";
    document.getElementById("welcomeScreen").style.display = "block";
    document.getElementById("mainApp").style.display = "none";
    return;
  }

  if (!currentProfile || (currentProfile.role !== "admin" && myPropertyCodes.length === 0)) {
    document.getElementById("unassignedPanel").style.display = "block";
    document.getElementById("welcomeScreen").style.display = "block";
    document.getElementById("mainApp").style.display = "none";
    return;
  }

  document.getElementById("unassignedPanel").style.display = "none";
  document.getElementById("welcomeScreen").style.display = "none";
  await loadCompanies();
  // The Executive picks a company first, unless this browser tab already did
  // before a refresh.
  var savedCompany = rememberedCompany();
  if (isExecutive()) activeCompany = COMPANIES.some(function(c) { return c.id === savedCompany; }) ? savedCompany : null;
  await loadProperties();
  showCompanyName();
  populatePropertySelects();
  applyAccessRestrictions();
  if (isExecutive() && !activeCompany) { showCompanyPicker(); return; }
  pickCommunityOrAsk();
}

// Skip the picker when there's nothing to choose (one community, no "All"),
// or when this browser tab already picked one before a refresh.
function pickCommunityOrAsk() {
  var saved = rememberedCommunity();
  var choices = visibleProperties();
  // A company with no buildings yet (usually one just added): straight to its
  // settings, where the Executive finishes setting it up.
  if (isExecutive() && choices.length === 0) {
    chooseCommunity("all");
    showAdminView("company");
    switchTab("admin");
    return;
  }
  if (saved && isValidCommunityChoice(saved)) chooseCommunity(saved);
  else if (choices.length === 1 && currentProfile.role !== "admin") chooseCommunity(choices[0].code);
  else showCommunityPicker();
}

// ── Company picker (Executive only) ─────────────────────────────────────────
// The Executive can see every company, so after signing in they pick which
// one to work in; the community picker and every tab then show only that
// company's facilities. Everyone else belongs to exactly one company and
// never sees this screen. Remembered for this browser tab, like the community.
// Display only — the database decides who can see what.

let COMPANIES = []; // { id, name } — every company for the Executive, just their own for anyone else
let activeCompany = null; // a company id; only ever set for the Executive
var COMPANY_STORAGE_KEY = "pp.activeCompany";

function isExecutive() {
  return !!(currentProfile && currentProfile.is_executive);
}

async function loadCompanies() {
  var res = await sb.from("companies").select("id, name, paused_at").order("name");
  if (res.error) { console.error(res.error); COMPANIES = []; return; }
  COMPANIES = res.data;
}

// The company the site is showing: the Executive's pick, otherwise your own.
function currentCompanyId() {
  return isExecutive() ? activeCompany : (currentProfile && currentProfile.company_id);
}

function companyName(id) {
  var c = COMPANIES.find(function(x) { return x.id === id; });
  return c ? c.name : "";
}

// The small line above the site title on every screen.
function showCompanyName() {
  var name = companyName(currentCompanyId());
  document.querySelectorAll(".company-eyebrow").forEach(function(el) {
    el.textContent = (name ? name + " — " : "") + "Facilities Management";
  });
  document.getElementById("footerCompany").textContent = (name ? name + " — " : "") + "StoneAnchor";
  // Lionel's own staff instructions (ALIC) on the Compliance tab; other companies don't see them.
  document.getElementById("complianceLionelNote").style.display = name === "Lionel Partners" ? "" : "none";
}

function rememberedCompany() {
  try { return sessionStorage.getItem(COMPANY_STORAGE_KEY); } catch (e) { return null; }
}

function rememberCompany(id) {
  try {
    if (id) sessionStorage.setItem(COMPANY_STORAGE_KEY, id);
    else sessionStorage.removeItem(COMPANY_STORAGE_KEY);
  } catch (e) {}
}

function showCompanyPicker() {
  var html = COMPANIES.map(function(c) {
    var buildings = ALL_PROPERTIES.filter(function(p) { return p.companyId === c.id; });
    var mine = c.id === currentProfile.company_id;
    return '<button type="button" class="company-choice' + (mine ? ' company-choice-mine' : '') + '" data-id="' + escapeHtml(c.id) + '">' +
      '<span class="company-choice-name">' + escapeHtml(c.name) + (mine ? '<span class="company-choice-badge">Your company</span>' : '') +
        (c.paused_at ? '<span class="company-choice-badge company-choice-paused">Paused</span>' : '') + '</span>' +
      '<span class="company-choice-count">' + buildings.length + (buildings.length === 1 ? ' building' : ' buildings') + '</span>' +
      '<span class="company-choice-buildings">' + (buildings.map(function(p) { return escapeHtml(p.name); }).join(" · ") || "No buildings yet") + '</span>' +
      '</button>';
  }).join("");
  document.getElementById("companyChoices").innerHTML = html;
  document.getElementById("companyPickerCount").textContent = COMPANIES.length + (COMPANIES.length === 1 ? " company" : " companies");
  hideNewCompanyForm();

  // Coming from "Switch company" (not a fresh sign-in): offer a way back.
  var back = document.getElementById("companyPickerBack");
  back.style.display = activeCompany ? "" : "none";
  back.textContent = "← Back to " + companyName(activeCompany);

  document.getElementById("mainApp").style.display = "none";
  document.getElementById("communityPicker").style.display = "none";
  document.getElementById("companyPicker").style.display = "block";
}

function hideNewCompanyForm() {
  document.getElementById("newCompanyForm").reset();
  document.getElementById("newCompanyForm").style.display = "none";
  document.getElementById("addCompanyBtn").style.display = "";
}

// The Executive's "+ Add a company". The database creates it (and stores the
// Asana key in the Vault) — see create_company in supabase/multi-company/03-....
async function handleCreateCompany(evt) {
  evt.preventDefault();
  var name = document.getElementById("newCompanyName").value.trim();
  if (!name) return;
  var btn = document.querySelector("#newCompanyForm button[type='submit']");
  btn.textContent = "Creating…"; btn.disabled = true;
  var res = await sb.rpc("create_company", {
    company_name: name,
    asana_token: document.getElementById("newCompanyAsanaKey").value,
    capex_project_gid: document.getElementById("newCompanyCapexGid").value.trim()
  });
  btn.textContent = "Create Company"; btn.disabled = false;
  if (res.error) { alert("Couldn't create the company: " + res.error.message); return; }
  await loadCompanies();
  chooseCompany(res.data);
}

function chooseCompany(id) {
  var changed = id !== activeCompany;
  activeCompany = id;
  rememberCompany(id);
  document.getElementById("companyPicker").style.display = "none";
  if (!changed && activeCommunity) { chooseCommunity(activeCommunity); return; }
  // A different company: start over with its facilities and ask which community.
  activeCommunity = null;
  rememberCommunity(null);
  applyCompanyScope();
  showCompanyName();
  populatePropertySelects();
  pickCommunityOrAsk();
}

// ── Community picker ─────────────────────────────────────────────────────────
// After signing in, everyone picks one community and every tab locks to it.
// Admins can also pick "All communities", which is the side-by-side view with
// each tab's own dropdown. The choice is remembered for this browser tab only,
// so a refresh doesn't ask again but signing out (or closing the tab) does.
// This only changes what's shown — who can see what is still enforced by the
// database.

let activeCommunity = null; // a facility code, or "all"
var COMMUNITY_STORAGE_KEY = "pp.activeCommunity";

function communityLocked() {
  return !!activeCommunity && activeCommunity !== "all";
}

// The facilities a tab should show: just the picked community, or everything
// this person can see under "All communities".
function communityProperties() {
  var props = visibleProperties();
  return communityLocked() ? props.filter(function(p) { return p.code === activeCommunity; }) : props;
}

function rememberedCommunity() {
  try { return sessionStorage.getItem(COMMUNITY_STORAGE_KEY); } catch (e) { return null; }
}

function rememberCommunity(code) {
  try {
    if (code) sessionStorage.setItem(COMMUNITY_STORAGE_KEY, code);
    else sessionStorage.removeItem(COMMUNITY_STORAGE_KEY);
  } catch (e) {}
}

function isValidCommunityChoice(code) {
  if (code === "all") return currentProfile.role === "admin";
  return visibleProperties().some(function(p) { return p.code === code; });
}

// Whether there's ever anything to switch to — decides if the header shows
// the "Switch community" button.
function hasCommunityChoice() {
  return currentProfile.role === "admin" || visibleProperties().length > 1;
}

function communityLabel(code) {
  if (code === "all") return "All Communities";
  var prop = PROPERTIES.find(function(p) { return p.code === code; });
  return prop ? prop.name : (code || "");
}

function showCommunityPicker() {
  var html = visibleProperties().map(function(p) {
    return '<button type="button" class="community-choice" data-code="' + escapeHtml(p.code) + '">' +
      escapeHtml(p.name) + '<small>' + escapeHtml(p.code) + '</small></button>';
  }).join("");
  if (currentProfile.role === "admin") {
    html += '<button type="button" class="community-choice community-choice-all" data-code="all">All Communities<small>Side-by-side</small></button>';
  }
  document.getElementById("communityChoices").innerHTML = html;

  // Coming from "Switch community" (not a fresh sign-in): offer a way back.
  var back = document.getElementById("communityPickerBack");
  back.style.display = activeCommunity ? "" : "none";
  back.textContent = "← Back to " + communityLabel(activeCommunity);
  document.getElementById("communityPickerCompanies").style.display = isExecutive() ? "" : "none";

  document.getElementById("mainApp").style.display = "none";
  document.getElementById("companyPicker").style.display = "none";
  document.getElementById("communityPicker").style.display = "block";
}

function chooseCommunity(code) {
  activeCommunity = code;
  rememberCommunity(code);
  document.getElementById("communityPicker").style.display = "none";
  document.getElementById("mainApp").style.display = "block";
  applyCommunityLock();
  loadCapexData();
  loadAll();
  // Reload whichever tab is open, so it isn't left showing the old community.
  var tab = document.querySelector(".top-tab.active");
  if (tab && tab.id === "tabVendors") loadVendorsData();
  if (tab && tab.id === "tabCompliance") loadComplianceData();
  if (tab && tab.id === "tabAdmin") { loadAdminFacilities(); loadAdminUsers(); renderExpenseAudit(); }
}

// Points every tab's community dropdown at the picked community and hides
// those dropdowns, or puts them back for "All communities".
function applyCommunityLock() {
  var locked = communityLocked();
  var value = locked ? activeCommunity : "all";
  var isAdmin = currentProfile.role === "admin";

  document.getElementById("headerCommunity").style.display = "";
  document.getElementById("headerCompanyName").textContent = isExecutive() ? companyName(activeCompany) + " ›" : "";
  document.getElementById("headerCommunityName").textContent = communityLabel(activeCommunity);
  document.getElementById("switchCommunityBtn").style.display = hasCommunityChoice() ? "" : "none";
  document.getElementById("switchCompanyBtn").style.display = isExecutive() ? "" : "none";

  // Work Orders
  document.getElementById("viewSelect").value = value;
  document.getElementById("viewSelector").style.display = locked ? "none" : "flex";

  // Projects & CapEx
  capexPropertyFilter = value;
  var capexSelect = document.getElementById("capexPropertySelect");
  capexSelect.value = value;
  capexSelect.closest(".view-selector").style.display = locked ? "none" : "";

  // Vendors: Admins keep a way to reach vendors with no community attached
  // yet, so they can still be assigned to one.
  vendorsPropertyFilter = value;
  var vendorsSelect = document.getElementById("vendorsPropertySelect");
  if (isAdmin) {
    vendorsSelect.innerHTML = locked
      ? '<option value="' + escapeHtml(activeCommunity) + '">' + escapeHtml(communityLabel(activeCommunity)) + '</option><option value="unassigned">Unassigned</option>'
      : propertyOptionsHtml("All Communities") + '<option value="unassigned">Unassigned</option>';
  }
  vendorsSelect.value = value;
  vendorsSelect.closest(".view-selector").style.display = locked && !isAdmin ? "none" : "";
  renderVendorPropertiesCheckboxes();

  // Admin tab's Expense Audit list
  var auditSelect = document.getElementById("expenseAuditPropertySelect");
  auditSelect.value = value;
  auditSelect.closest(".capex-field").style.display = locked ? "none" : "";
}

function propertyOptionsHtml(allOption) {
  var opts = allOption ? '<option value="all">' + allOption + '</option>' : "";
  return opts + PROPERTIES.map(function(p) { return '<option value="' + escapeHtml(p.code) + '">' + escapeHtml(p.name) + '</option>'; }).join("");
}

// Rebuilds every property dropdown from the current facility list. Called
// after sign-in and again any time a facility is added or removed on the
// Admin tab, so every dropdown across the app stays current.
function populatePropertySelects() {
  document.getElementById("viewSelect").innerHTML = propertyOptionsHtml("All Properties — Overview");
  document.getElementById("capexPropertySelect").innerHTML = propertyOptionsHtml("All Properties");
  document.getElementById("projPropertyInput").innerHTML = propertyOptionsHtml(null);
  // "Unassigned" only means anything to an Admin (it's the master-list vendors
  // with no community attached yet) — restrictSelectToProperties strips it
  // back out for anyone else, same as it does for every other option here.
  document.getElementById("vendorsPropertySelect").innerHTML = propertyOptionsHtml("All Communities") + '<option value="unassigned">Unassigned</option>';
  document.getElementById("expenseAuditPropertySelect").innerHTML = propertyOptionsHtml("All Properties");
  renderVendorPropertiesCheckboxes();
  // Rebuilding the dropdowns (e.g. after a facility is added on the Admin
  // tab) resets them to "All" — put the picked community back.
  if (activeCommunity) applyCommunityLock();
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

