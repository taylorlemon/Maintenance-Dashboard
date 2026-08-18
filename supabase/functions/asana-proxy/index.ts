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

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ASANA_TOKEN = Deno.env.get("ASANA_TOKEN");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");

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

type PropertyRow = { code: string; gid: string | null; pmGid: string | null; rtGid: string | null; complianceGid: string | null };

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
// Asana *sections*, whose IDs are looked up dynamically per project and
// aren't part of the fixed 4-community list above. To check whether a
// section belongs to a company the caller's allowed to see, ask Asana
// which project the section lives under, then check that project.
async function resolveSectionsParentProjectGid(sectionGid: string): Promise<string | null> {
  const res = await fetch(`https://app.asana.com/api/1.0/sections/${sectionGid}?opt_fields=project.gid`, {
    headers: { Authorization: "Bearer " + ASANA_TOKEN, Accept: "application/json" },
  });
  if (!res.ok) return null;
  const json = await res.json();
  return json?.data?.project?.gid ?? null;
}

// CapEx to-dos are mirrored into one shared Asana board (not one project per
// facility, like Work Orders) — see https://app.asana.com/1/1210546514185176/project/1210546410075012.
// Each facility has its own section on that board; Taylor supplied the exact
// section names below, since they don't follow a pattern that could be
// derived automatically (e.g. "Valencia at the Lakes" -> "Escalante by the
// lakes"). If a facility is renamed or a section is renamed in Asana, update
// this map to match.
const CAPEX_TODOS_PROJECT_GID = "1210546410075012";
const CAPEX_TODO_SECTION_NAME_BY_PROPERTY_CODE: Record<string, string> = {
  CP: "Cove Point Tasks To-Do",
  VDR: "Draper Tasks To-Do",
  VCH: "Cottonwood Tasks To-Do",
  VATL: "Escalante by the lakes",
};

async function createCapexTodoTask(
  body: { propertyCode?: unknown; title?: unknown; projectName?: unknown },
  role: string,
  isAdmin: boolean,
  myCodes: string[],
): Promise<Response> {
  if (role === "viewer") return jsonResponse({ error: "You have view-only access and can't create tasks." }, 403);

  const propertyCode = typeof body.propertyCode === "string" ? body.propertyCode : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const projectName = typeof body.projectName === "string" ? body.projectName.trim() : "";

  const sectionName = CAPEX_TODO_SECTION_NAME_BY_PROPERTY_CODE[propertyCode];
  if (!sectionName) return jsonResponse({ error: "Unrecognized facility — no Asana section is mapped for it." }, 400);
  if (!title) return jsonResponse({ error: "Missing to-do title." }, 400);
  if (!isAdmin && !myCodes.includes(propertyCode)) {
    return jsonResponse({ error: "Not allowed to create tasks for that facility." }, 403);
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
async function completeCapexTodoTask(sb: any, body: { todoId?: unknown; completed?: unknown }, role: string): Promise<Response> {
  if (role === "viewer") return jsonResponse({ error: "You have view-only access and can't update tasks." }, 403);

  const todoId = typeof body.todoId === "string" ? body.todoId : "";
  const completed = body.completed === true;
  if (!todoId) return jsonResponse({ error: "Missing to-do id." }, 400);

  const { data: todo, error: todoErr } = await sb.from("todos").select("asana_task_gid").eq("id", todoId).single();
  if (todoErr || !todo) return jsonResponse({ error: "Couldn't find that to-do, or you don't have access to it." }, 404);
  if (!todo.asana_task_gid) return jsonResponse({ ok: true, skipped: true }, 200);

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
    if (!ASANA_TOKEN) return jsonResponse({ error: "ASANA_TOKEN secret isn't set on this function yet." }, 500);

    const sb = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });

    const { data: userData, error: userErr } = await sb.auth.getUser();
    if (userErr || !userData.user) return jsonResponse({ error: "Not signed in." }, 401);

    const { data: profile, error: profileErr } = await sb
      .from("profiles")
      .select("role")
      .eq("id", userData.user.id)
      .single();
    if (profileErr || !profile) return jsonResponse({ error: "No profile found for this account." }, 403);

    const isAdmin = profile.role === "admin";

    // Facilities and which ones this person can see now live in the database
    // (see supabase-schema.sql) instead of a fixed list here, so a facility
    // added on the Admin tab works immediately without redeploying this file.
    const { data: propertyRows, error: propertiesErr } = await sb
      .from("properties")
      .select("code, asana_project_gid, asana_pm_section_gid, asana_rt_section_gid, asana_compliance_section_gid");
    if (propertiesErr) return jsonResponse({ error: "Failed to load facilities: " + propertiesErr.message }, 500);
    const properties: PropertyRow[] = (propertyRows ?? []).map((p) => ({
      code: p.code, gid: p.asana_project_gid, pmGid: p.asana_pm_section_gid, rtGid: p.asana_rt_section_gid,
      complianceGid: p.asana_compliance_section_gid,
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

    if (body.action === "createCapexTodoTask") {
      return await createCapexTodoTask(body, profile.role, isAdmin, myCodes);
    }
    if (body.action === "completeCapexTodoTask") {
      return await completeCapexTodoTask(sb, body, profile.role);
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

    if (projectGid) {
      const failure = checkAllowed(propertyForGid(properties, projectGid), "project");
      if (failure) return failure;
    } else if (sectionGid) {
      // Compliance sections are checked directly against each facility's
      // stored section id first (see propertyForComplianceSection) since they
      // all share one parent Asana project and can't be told apart by it.
      // Anything else (Preventive Maintenance / Room Turn sections) falls
      // back to asking Asana which project the section belongs to.
      const complianceMatch = propertyForComplianceSection(properties, sectionGid);
      if (complianceMatch) {
        const failure = checkAllowed(complianceMatch, "section");
        if (failure) return failure;
      } else {
        const parentProjectGid = await resolveSectionsParentProjectGid(sectionGid);
        const failure = checkAllowed(parentProjectGid ? propertyForGid(properties, parentProjectGid) : undefined, "section");
        if (failure) return failure;
      }
    }

    const asanaRes = await fetch("https://app.asana.com/api/1.0" + path, {
      headers: { Authorization: "Bearer " + ASANA_TOKEN, Accept: "application/json" },
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
