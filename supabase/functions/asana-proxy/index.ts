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

// Same 4 communities as the PROPERTIES list in index.html. These IDs aren't
// secret (they're already public in the page) — this copy exists purely so
// the function can check "does the project/section being asked for actually
// belong to the company this person is allowed to see?"
const PROPERTIES = [
  { code: "CP", gid: "1210546579390444", pmGid: "1210546579390447", rtGid: "1210546579390440" },
  { code: "VDR", gid: "1210546579390437", pmGid: "1210546579390434", rtGid: "1210546579390431" },
  { code: "VCH", gid: "1210546583182221", pmGid: "1210546583182224", rtGid: "1210546583182227" },
  { code: "VATL", gid: "1213560305303692", pmGid: "1213560305303695", rtGid: "1213560305303689" },
];

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

function propertyForGid(gid: string) {
  return PROPERTIES.find((p) => p.gid === gid || p.pmGid === gid || p.rtGid === gid);
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
      .select("property_code, role")
      .eq("id", userData.user.id)
      .single();
    if (profileErr || !profile) return jsonResponse({ error: "No profile found for this account." }, 403);

    const isAdmin = profile.role === "admin";

    const body = await req.json().catch(() => ({}));
    const path = body.path;
    if (!path || typeof path !== "string" || !path.startsWith("/")) {
      return jsonResponse({ error: "Missing or invalid \"path\"." }, 400);
    }

    // Every Asana project/section referenced in this request must belong to
    // a company the caller is allowed to see (all of them, if admin).
    // Projects (gid/pmGid/rtGid) are checked directly against the fixed
    // list; sections are resolved back to their parent project first, since
    // section IDs aren't part of that fixed list.
    const projectGidPattern = /project=(\d+)|\/projects\/(\d+)/g;
    const sectionGidPattern = /section=(\d+)/g;
    const projectGids: string[] = [];
    const sectionGids: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = projectGidPattern.exec(path))) projectGids.push(match[1] || match[2]);
    while ((match = sectionGidPattern.exec(path))) sectionGids.push(match[1]);

    if (projectGids.length === 0 && sectionGids.length === 0) {
      return jsonResponse({ error: "Request must reference a specific community's Asana project or section." }, 400);
    }

    function checkAllowed(prop: typeof PROPERTIES[number] | undefined, label: string) {
      if (!prop) return jsonResponse({ error: "Unrecognized Asana " + label + "." }, 400);
      if (!isAdmin && prop.code !== profile.property_code) {
        return jsonResponse({ error: "Not allowed to view that community's work orders." }, 403);
      }
      return null;
    }

    for (const gid of projectGids) {
      const failure = checkAllowed(propertyForGid(gid), "project");
      if (failure) return failure;
    }

    for (const sectionGid of sectionGids) {
      const parentProjectGid = await resolveSectionsParentProjectGid(sectionGid);
      const failure = checkAllowed(parentProjectGid ? propertyForGid(parentProjectGid) : undefined, "section");
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
