// Asana work-order proxy.
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

type PropertyRow = { code: string; gid: string | null; pmGid: string | null; rtGid: string | null };

function propertyForGid(properties: PropertyRow[], gid: string) {
  return properties.find((p) => p.gid === gid || p.pmGid === gid || p.rtGid === gid);
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
      .select("code, asana_project_gid, asana_pm_section_gid, asana_rt_section_gid");
    if (propertiesErr) return jsonResponse({ error: "Failed to load facilities: " + propertiesErr.message }, 500);
    const properties: PropertyRow[] = (propertyRows ?? []).map((p) => ({
      code: p.code, gid: p.asana_project_gid, pmGid: p.asana_pm_section_gid, rtGid: p.asana_rt_section_gid,
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
    // The four shapes index.html uses (see js/workorders.js):
    //   /tasks?project=<gid>&...            open + recently-completed + trend
    //   /tasks?section=<gid>&...            room-turn columns
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
        return jsonResponse({ error: "Not allowed to view that community's work orders." }, 403);
      }
      return null;
    }

    if (projectGid) {
      const failure = checkAllowed(propertyForGid(properties, projectGid), "project");
      if (failure) return failure;
    } else if (sectionGid) {
      // Section ids aren't part of the facility list, so ask Asana which
      // project the section belongs to and authorize that instead.
      const parentProjectGid = await resolveSectionsParentProjectGid(sectionGid);
      const failure = checkAllowed(parentProjectGid ? propertyForGid(properties, parentProjectGid) : undefined, "section");
      if (failure) return failure;
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
