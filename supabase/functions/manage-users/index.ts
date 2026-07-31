// Admin-tab user management: invite a new login by email, or remove one
// entirely. This is the in-app replacement for doing both of those in the
// Supabase Dashboard (Authentication -> Users -> Invite user / Delete user).
//
// This runs on Supabase's servers, not in anyone's browser. Creating or
// deleting a login requires the "service role" key, which can bypass every
// security rule protecting the data — that key must never appear in the
// page itself, since this repository is public on GitHub. It lives only in
// this function's environment, and every request is checked against the
// signed-in person's own Admin status before anything happens.
//
// Deploy notes: create this function in the Supabase Dashboard (Edge
// Functions), paste this file in, and deploy it. No secrets need to be set
// by hand — SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY
// are all provided automatically by the platform.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  try {
    // Client that acts as the person making the request, used only to
    // confirm who they are and that they're an Admin.
    const callerClient = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });

    const { data: userData, error: userErr } = await callerClient.auth.getUser();
    if (userErr || !userData.user) return jsonResponse({ error: "Not signed in." }, 401);

    const { data: profile, error: profileErr } = await callerClient
      .from("profiles")
      .select("role")
      .eq("id", userData.user.id)
      .single();
    if (profileErr || !profile) return jsonResponse({ error: "No profile found for this account." }, 403);
    if (profile.role !== "admin") return jsonResponse({ error: "Only Admins can manage logins." }, 403);

    const body = await req.json().catch(() => ({}));
    const action = body.action;

    // Client with the powerful service-role key — only used after the Admin
    // check above has passed, and only for the two exact actions below.
    const adminClient = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);

    if (action === "invite") {
      const email = typeof body.email === "string" ? body.email.trim() : "";
      if (!email || !EMAIL_RE.test(email)) return jsonResponse({ error: "Enter a valid email address." }, 400);

      const { error: inviteErr } = await adminClient.auth.admin.inviteUserByEmail(email);
      if (inviteErr) return jsonResponse({ error: inviteErr.message }, 400);

      return jsonResponse({ ok: true }, 200);
    }

    if (action === "delete") {
      const targetId = typeof body.userId === "string" ? body.userId : "";
      if (!targetId) return jsonResponse({ error: "Missing userId." }, 400);
      if (targetId === userData.user.id) {
        return jsonResponse({ error: "You can't remove your own login this way." }, 400);
      }

      const { error: deleteErr } = await adminClient.auth.admin.deleteUser(targetId);
      if (deleteErr) return jsonResponse({ error: deleteErr.message }, 400);

      return jsonResponse({ ok: true }, 200);
    }

    return jsonResponse({ error: "Unknown action." }, 400);
  } catch (e) {
    return jsonResponse({ error: String(e) }, 500);
  }
});
