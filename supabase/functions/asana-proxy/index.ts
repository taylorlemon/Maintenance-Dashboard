// Asana proxy — used by both the Work Orders and Building Compliance tabs.
//
// This runs on Supabase's servers, not in anyone's browser. It's what keeps
// the Asana key genuinely private: the key lives only in this function's
// secrets (set via the Supabase Dashboard, see deploy notes), and every
// request is checked against the signed-in person's assigned company before
// it's allowed through. index.html no longer holds an Asana key at all — it
// calls this function instead, once per Asana API request it needs to make.
//
// Deploy notes live in supabase-schema.sql's neighboring README section /
// the message Claude gave when this was built. In short: create this
// function in the Supabase Dashboard (Edge Functions), paste this file in,
// deploy it, then add a secret named ASANA_TOKEN with the Asana key as its
// value (Edge Functions -> Secrets). SUPABASE_URL and SUPABASE_ANON_KEY are
// provided automatically by the platform — no need to set those.
//
// Each company has its own Asana (see supabase/multi-company/02-...): every
// request uses the key belonging to the company of the facility it's about,
// so one company's key is never used for another company's facilities.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { companyAsanaLookup, type CompanyAsana } from "../_shared/companies.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

type PropertyRow = {
  code: string; companyId: string; gid: string | null; pmGid: string | null; rtGid: string | null;
  complianceGid: string | null; capexSection: string | null;
};
type AsanaFor = (companyId: string) => Promise<CompanyAsana>;

function propertyForGid(properties: PropertyRow[], gid: string) {
  return properties.find((p) => p.gid === gid || p.pmGid === gid || p.rtGid === gid);
}

// Building Compliance sections all live inside one shared Asana project (not
// one project per facility, like Work Orders), so a section's parent project
// can't be used to tell which facility it belongs to — every facility's
// compliance section resolves to the same parent. Match the section id
// directly against the facility's own stored compliance section id instead.
function propertyForComplianceSection(properties: PropertyRow[], sectionGid: string) {
  return properties.find((p) => p.complianceGid === sectionGid);
}

// Room-turn data ("Rent Ready" / "To Be Turned" / "Currently") lives in
// Asana *sections*, whose IDs are looked up dynamically per project. To check
// whether a section belongs to a facility the caller's allowed to see, ask
// Asana which project the section lives under, then check that project. Each
// company's Asana is asked with its own key, and the answer only counts if
// that project belongs to that same company's facilities.
async function propertyForOtherSection(properties: PropertyRow[], sectionGid: string, asanaFor: AsanaFor): Promise<PropertyRow | undefined> {
  for (const companyId of new Set(properties.map((p) => p.companyId))) {
    const { token } = await asanaFor(companyId);
    if (!token) continue;
    const res = await fetch(`https://app.asana.com/api/1.0/sections/${sectionGid}?opt_fields=project.gid`, {
      headers: { Authorization: "Bearer " + token, Accept: "application/json" },
    });
    if (!res.ok) continue;
    const parentGid = (await res.json())?.data?.project?.gid;
    const match = parentGid ? propertyForGid(properties.filter((p) => p.companyId === companyId), parentGid) : undefined;
    if (match) return match;
  }
  return undefined;
}

// CapEx to-dos are mirrored into each company's own CapEx to-dos board in
// Asana (companies.asana_capex_project_gid), filed under the facility's own
// section (properties.asana_capex_section_name). Section names don't follow
// a pattern (e.g. "Valencia at the Lakes" -> "Escalante by the lakes"), so
// they're stored per facility; if one is renamed in Asana, update it there.
async function createCapexTodoTask(
  body: { propertyCode?: unknown; title?: unknown; projectName?: unknown },
  role: string,
  isAdmin: boolean,
  myCodes: string[],
  properties: PropertyRow[],
  asanaFor: AsanaFor,
): Promise<Response> {
  if (role === "viewer") return jsonResponse({ error: "You have view-only access and can't create tasks." }, 403);

  const propertyCode = typeof body.propertyCode === "string" ? body.propertyCode : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const projectName = typeof body.projectName === "string" ? body.projectName.trim() : "";

  // Only facilities the database lets this person see are in `properties`.
  const prop = properties.find((p) => p.code === propertyCode);
  if (!prop || (!isAdmin && !myCodes.includes(propertyCode))) {
    return jsonResponse({ error: "Not allowed to create tasks for that facility." }, 403);
  }
  if (!title) return jsonResponse({ error: "Missing to-do title." }, 400);
  const sectionName = prop.capexSection;
  const { token: ASANA_TOKEN, capexProjectGid: CAPEX_TODOS_PROJECT_GID } = await asanaFor(prop.companyId);
  if (!sectionName || !ASANA_TOKEN || !CAPEX_TODOS_PROJECT_GID) {
    return jsonResponse({ error: "This facility's company isn't connected to a CapEx to-dos board in Asana yet." }, 400);
  }

  const sectionsRes = await fetch(
    `https://app.asana.com/api/1.0/projects/${CAPEX_TODOS_PROJECT_GID}/sections?opt_fields=name,gid`,
    { headers: { Authorization: "Bearer " + ASANA_TOKEN, Accept: "application/json" } },
  );
  if (!sectionsRes.ok) return jsonResponse({ error: "Could not read the CapEx to-dos board's sections from Asana." }, 502);
  const sectionsJson = await sectionsRes.json();
  const section = (sectionsJson?.data ?? []).find((s: { name: string; gid: string }) => s.name === sectionName);
  if (!section) return jsonResponse({ error: `Could not find the "${sectionName}" section on the Asana board — has it been renamed?` }, 502);

  // Two calls, not one: Asana's "create with memberships" shape is
  // inconsistent about being accepted depending on the workspace/plan, but
  // "create in the project, then move it into the section" always works.
  const createRes = await fetch("https://app.asana.com/api/1.0/tasks", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + ASANA_TOKEN,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      data: {
        name: title,
        notes: projectName ? "From CapEx project: " + projectName : undefined,
        projects: [CAPEX_TODOS_PROJECT_GID],
      },
    }),
  });
  if (!createRes.ok) return jsonResponse({ error: await asanaErrorMessage(createRes) }, 502);
  const createJson = await createRes.json();
  const taskGid = createJson?.data?.gid;
  if (!taskGid) return jsonResponse({ error: "Asana didn't return a task id after creating the task." }, 502);

  const moveRes = await fetch(`https://app.asana.com/api/1.0/sections/${section.gid}/addTask`, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + ASANA_TOKEN,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ data: { task: taskGid } }),
  });
  if (!moveRes.ok) {
    return jsonResponse({ error: "Task was created but couldn't be filed into its section: " + await asanaErrorMessage(moveRes) }, 502);
  }

  return jsonResponse({ ok: true, taskGid: taskGid }, 200);
}

// The Executive's "Test Asana connection" (Admin tab → Company): does this
// company's key work, and does each facility's Asana link answer the same
// requests the dashboard makes? Reports yes/no per item, never the key itself.
// deno-lint-ignore no-explicit-any
async function checkCompanyAsana(companyId: unknown, admin: any, asanaFor: AsanaFor): Promise<Response> {
  if (typeof companyId !== "string") return jsonResponse({ error: "Missing company." }, 400);
  const { token, capexProjectGid } = await asanaFor(companyId);
  if (!token) return jsonResponse({ keyWorks: false, problem: "No Asana key is saved for this company yet." }, 200);

  const ask = async (path: string) => {
    const res = await fetch("https://app.asana.com/api/1.0" + path, { headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
    return res.ok ? (await res.json()).data : null;
  };
  const me = await ask("/users/me?opt_fields=name");
  if (!me) return jsonResponse({ keyWorks: false, problem: "Asana didn't accept this company's key. It may have been typed wrong, or revoked." }, 200);

  const capexSections: { name: string }[] | null = capexProjectGid ? await ask(`/projects/${capexProjectGid}/sections?opt_fields=name`) : null;
  const { data: props } = await admin.from("properties")
    .select("code, name, asana_project_gid, asana_pm_section_gid, asana_rt_section_gid, asana_compliance_section_gid, asana_capex_section_name")
    .eq("company_id", companyId).order("name");
  const ok = async (gid: string | null, path: (g: string) => string) => !!gid && (await ask(path(gid))) !== null;
  const buildings = [];
  for (const p of props ?? []) {
    buildings.push({
      code: p.code, name: p.name,
      workOrders: await ok(p.asana_project_gid, (g) => `/tasks?project=${g}&completed_since=now&opt_fields=name&limit=1`),
      maintenance: await ok(p.asana_pm_section_gid, (g) => `/tasks?project=${g}&completed_since=now&opt_fields=name&limit=1`),
      roomTurns: await ok(p.asana_rt_section_gid, (g) => `/projects/${g}/sections?opt_fields=name`),
      compliance: await ok(p.asana_compliance_section_gid, (g) => `/tasks?section=${g}&opt_fields=name&limit=1`),
      capexSection: !!capexSections && !!p.asana_capex_section_name && capexSections.some((s) => s.name === p.asana_capex_section_name),
    });
  }
  return jsonResponse({ keyWorks: true, asanaUser: me.name, capexBoard: capexSections !== null, buildings }, 200);
}

// Asana's error responses look like {"errors":[{"message":"...","help":"..."}]},
// not the {"error": "..."} shape the rest of this function returns — translate
// so the real reason reaches the browser instead of a generic fallback message.
async function asanaErrorMessage(res: Response): Promise<string> {
  try {
    const json = await res.json();
    const first = json?.errors?.[0];
    if (first?.message) return "Asana said: " + first.message;
  } catch (e) { /* not JSON — fall through */ }
  return "Asana request failed with status " + res.status + ".";
}

// Checking a to-do off (or back on) here also updates its matching Asana
// task, if it has one. The to-do is looked up through the caller's own
// authenticated Supabase client (sb), the same one used earlier in this
// request — so the database's own Row Level Security rules decide whether
// this person is even allowed to see that to-do, rather than trusting a
// task id handed in from the browser.
// deno-lint-ignore no-explicit-any
async function completeCapexTodoTask(sb: any, body: { todoId?: unknown; completed?: unknown }, role: string, properties: PropertyRow[], asanaFor: AsanaFor): Promise<Response> {
  if (role === "viewer") return jsonResponse({ error: "You have view-only access and can't update tasks." }, 403);

  const todoId = typeof body.todoId === "string" ? body.todoId : "";
  const completed = body.completed === true;
  if (!todoId) return jsonResponse({ error: "Missing to-do id." }, 400);

  const { data: todo, error: todoErr } = await sb.from("todos").select("asana_task_gid, property_code").eq("id", todoId).single();
  if (todoErr || !todo) return jsonResponse({ error: "Couldn't find that to-do, or you don't have access to it." }, 404);
  if (!todo.asana_task_gid) return jsonResponse({ ok: true, skipped: true }, 200);
  const prop = properties.find((p) => p.code === todo.property_code);
  const ASANA_TOKEN = prop ? (await asanaFor(prop.companyId)).token : null;
  if (!ASANA_TOKEN) return jsonResponse({ error: "This facility's company isn't connected to Asana yet." }, 400);

  const updateRes = await fetch(`https://app.asana.com/api/1.0/tasks/${todo.asana_task_gid}`, {
    method: "PUT",
    headers: {
      Authorization: "Bearer " + ASANA_TOKEN,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ data: { completed: completed } }),
  });
  if (!updateRes.ok) return jsonResponse({ error: await asanaErrorMessage(updateRes) }, 502);

  return jsonResponse({ ok: true }, 200);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  try {
    const sb = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });

    const { data: userData, error: userErr } = await sb.auth.getUser();
    if (userErr || !userData.user) return jsonResponse({ error: "Not signed in." }, 401);

    const { data: profile, error: profileErr } = await sb
      .from("profiles")
      .select("role, is_executive")
      .eq("id", userData.user.id)
      .single();
    if (profileErr || !profile) return jsonResponse({ error: "No profile found for this account." }, 403);
    // Staff (techs, front desk) only use StoneAnchor's own task lists, never Asana.
    if (profile.role === "staff") return jsonResponse({ error: "Staff logins don't use Asana." }, 403);

    // "Admin" here means every facility the database lets this person see —
    // their own company's for an Admin, every company's for the Executive.
    const isAdmin = profile.role === "admin" || profile.is_executive === true;
    // Only used to read each company's Asana key; never to decide what this
    // person may see (that's the database rules, through `sb` above).
    const asanaFor = companyAsanaLookup(createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!));

    // Facilities and which ones this person can see now live in the database
    // (see supabase-schema.sql) instead of a fixed list here, so a facility
    // added on the Admin tab works immediately without redeploying this file.
    const { data: propertyRows, error: propertiesErr } = await sb
      .from("properties")
      .select("code, company_id, asana_project_gid, asana_pm_section_gid, asana_rt_section_gid, asana_compliance_section_gid, asana_capex_section_name");
    if (propertiesErr) return jsonResponse({ error: "Failed to load facilities: " + propertiesErr.message }, 500);
    const properties: PropertyRow[] = (propertyRows ?? []).map((p) => ({
      code: p.code, companyId: p.company_id, gid: p.asana_project_gid, pmGid: p.asana_pm_section_gid, rtGid: p.asana_rt_section_gid,
      complianceGid: p.asana_compliance_section_gid, capexSection: p.asana_capex_section_name,
    }));

    let myCodes: string[] = [];
    if (!isAdmin) {
      const { data: myProps, error: myPropsErr } = await sb
        .from("profile_properties")
        .select("property_code")
        .eq("profile_id", userData.user.id);
      if (myPropsErr) return jsonResponse({ error: "Failed to load your facility access: " + myPropsErr.message }, 500);
      myCodes = (myProps ?? []).map((r) => r.property_code);
    }

    const body = await req.json().catch(() => ({}));

    if (body.action === "checkCompanyAsana") {
      if (profile.is_executive !== true) return jsonResponse({ error: "Only the Executive can run this check." }, 403);
      return await checkCompanyAsana(body.companyId, createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!), asanaFor);
    }
    if (body.action === "createCapexTodoTask") {
      return await createCapexTodoTask(body, profile.role, isAdmin, myCodes, properties, asanaFor);
    }
    if (body.action === "completeCapexTodoTask") {
      return await completeCapexTodoTask(sb, body, profile.role, properties, asanaFor);
    }

    const path = body.path;
    if (!path || typeof path !== "string" || !path.startsWith("/")) {
      return jsonResponse({ error: "Missing or invalid \"path\"." }, 400);
    }

    // Only the exact request shapes this app actually makes are allowed, and
    // the id that decides what Asana returns is the one that gets authorized.
    //
    // An earlier version scanned the whole path for any "project=<digits>" or
    // "/projects/<digits>" and authorized whatever it found. That could be
    // fooled: "/tasks/<someone else's task>?project=<a project I can see>"
    // passed the check because an allowed id appeared somewhere in the string,
    // while Asana went on to return the other community's task. Matching the
    // route exactly closes that off — "/tasks/<id>" is simply not a shape this
    // proxy will forward.
    //
    // The shapes index.html uses (see js/workorders.js and js/compliance.js):
    //   /tasks?project=<gid>&...            open + recently-completed + trend
    //   /tasks?section=<gid>&...            room-turn columns, compliance tasks
    //   /projects/<gid>/sections?...        room-turn section lookup
    const queryStart = path.indexOf("?");
    const route = queryStart === -1 ? path : path.slice(0, queryStart);
    const params = new URLSearchParams(queryStart === -1 ? "" : path.slice(queryStart + 1));

    let projectGid: string | null = null;
    let sectionGid: string | null = null;

    const sectionsRoute = route.match(/^\/projects\/(\d+)\/sections$/);

    if (route === "/tasks") {
      // Exactly one scoping id, so a second one can't be smuggled alongside it.
      const projectValues = params.getAll("project");
      const sectionValues = params.getAll("section");
      if (projectValues.length + sectionValues.length !== 1) {
        return jsonResponse({ error: "Request must name exactly one Asana project or section." }, 400);
      }
      const value = projectValues[0] ?? sectionValues[0];
      if (!/^\d+$/.test(value)) {
        return jsonResponse({ error: "Invalid Asana id." }, 400);
      }
      if (projectValues.length === 1) projectGid = value; else sectionGid = value;
    } else if (sectionsRoute) {
      projectGid = sectionsRoute[1];
    } else {
      return jsonResponse({ error: "That kind of Asana request isn't allowed." }, 400);
    }

    function checkAllowed(prop: PropertyRow | undefined, label: string) {
      if (!prop) return jsonResponse({ error: "Unrecognized Asana " + label + "." }, 400);
      if (!isAdmin && !myCodes.includes(prop.code)) {
        return jsonResponse({ error: "Not allowed to view that community's data." }, 403);
      }
      return null;
    }

    // The facility the request is about decides whose Asana key is used.
    // Compliance sections are matched directly against each facility's stored
    // section id first (they all share one parent Asana project per company,
    // so can't be told apart by it); any other section falls back to asking
    // Asana which project it belongs to.
    let target: PropertyRow | undefined;
    if (projectGid) {
      target = propertyForGid(properties, projectGid);
    } else if (sectionGid) {
      target = propertyForComplianceSection(properties, sectionGid) ?? await propertyForOtherSection(properties, sectionGid, asanaFor);
    }
    const failure = checkAllowed(target, projectGid ? "project" : "section");
    if (failure) return failure;

    const { token } = await asanaFor(target!.companyId);
    if (!token) return jsonResponse({ error: "This facility's company isn't connected to Asana yet." }, 400);
    const asanaRes = await fetch("https://app.asana.com/api/1.0" + path, {
      headers: { Authorization: "Bearer " + token, Accept: "application/json" },
    });
    const responseBody = await asanaRes.text();
    return new Response(responseBody, {
      status: asanaRes.status,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return jsonResponse({ error: String(e) }, 500);
  }
});
