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
      .select("role, company_id, is_executive")
      .eq("id", userData.user.id)
      .single();
    if (profileErr || !profile) return jsonResponse({ error: "No profile found for this account." }, 403);
    const isExecutive = profile.is_executive === true;
    if (profile.role !== "admin" && !isExecutive) return jsonResponse({ error: "Only Admins can manage logins." }, 403);

    const body = await req.json().catch(() => ({}));
    const action = body.action;

    // Client with the powerful service-role key — only used after the Admin
    // check above has passed, and only for the two exact actions below.
    const adminClient = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);

    if (action === "invite") {
      const email = typeof body.email === "string" ? body.email.trim() : "";
      if (!email || !EMAIL_RE.test(email)) return jsonResponse({ error: "Enter a valid email address." }, 400);
      // Their name, stamped on the notes and history they add (04-names.sql).
      const fullName = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";

      // A new login joins the inviting Admin's company. The Executive invites
      // into whichever company they're working in (sent from the page, and
      // checked to be a real company).
      let companyId: string | null = profile.company_id;
      if (isExecutive && typeof body.companyId === "string") {
        const { data: co } = await adminClient.from("companies").select("id").eq("id", body.companyId).maybeSingle();
        if (!co) return jsonResponse({ error: "Unknown company." }, 400);
        companyId = co.id;
      }
      if (!companyId) return jsonResponse({ error: "Your login isn't attached to a company." }, 400);

      const { data: invited, error: inviteErr } = await adminClient.auth.admin.inviteUserByEmail(email);
      if (inviteErr) return jsonResponse({ error: inviteErr.message }, 400);

      // Until this runs the new profile has no company, which means it can see
      // nothing at all — so a failure here leaves them locked out, never in.
      const { error: companyErr } = await adminClient.from("profiles").update({ company_id: companyId, full_name: fullName || null }).eq("id", invited.user.id);
      if (companyErr) return jsonResponse({ error: "Invited, but couldn't attach them to the company: " + companyErr.message }, 500);

      return jsonResponse({ ok: true }, 200);
    }

    // The Executive's "Remove company permanently" (Admin → Company). Only for a
    // paused company that no Executive belongs to, and only when its name has
    // been typed in to confirm. Deletes its uploaded files and logins here, then
    // everything else in the database (remove_company_rows, 04-pause-and-remove.sql).
    // Their own Asana is never touched. Safe to run again if it stops partway.
    if (action === "removeCompany") {
      if (!isExecutive) return jsonResponse({ error: "Only the Executive can remove a company." }, 403);
      const companyId = typeof body.companyId === "string" ? body.companyId : "";
      const { data: co } = await adminClient.from("companies").select("id, name, paused_at").eq("id", companyId).maybeSingle();
      if (!co) return jsonResponse({ error: "Unknown company." }, 404);
      if (!co.paused_at) return jsonResponse({ error: "Pause the company first." }, 400);
      if (typeof body.confirmName !== "string" || body.confirmName.trim().toLowerCase() !== co.name.trim().toLowerCase()) {
        return jsonResponse({ error: "The name you typed doesn't match the company's name." }, 400);
      }
      const { count: execCount } = await adminClient.from("profiles").select("id", { count: "exact", head: true })
        .eq("company_id", co.id).eq("is_executive", true);
      if (execCount) return jsonResponse({ error: "A company an Executive belongs to can't be removed." }, 400);

      // Uploaded files live in folders named after their project or vendor.
      const { data: props } = await adminClient.from("properties").select("code").eq("company_id", co.id);
      const codes = (props ?? []).map((p: { code: string }) => p.code);
      const { data: projects } = codes.length
        ? await adminClient.from("projects").select("id").in("property_code", codes) : { data: [] };
      const { data: vendors } = await adminClient.from("vendors").select("id").eq("company_id", co.id);
      let filesRemoved = 0;
      const clearFolders = async (bucket: string, folders: string[]) => {
        for (const folder of folders) {
          const { data: files } = await adminClient.storage.from(bucket).list(folder, { limit: 1000 });
          const paths = (files ?? []).map((f: { name: string }) => `${folder}/${f.name}`);
          if (paths.length) {
            const { error } = await adminClient.storage.from(bucket).remove(paths);
            if (error) throw new Error(`Couldn't delete files in ${bucket}: ${error.message}`);
            filesRemoved += paths.length;
          }
        }
      };
      const projectIds = (projects ?? []).map((p: { id: string }) => p.id);
      await clearFolders("receipts", projectIds);
      await clearFolders("approvals", projectIds);
      await clearFolders("vendor-contracts", (vendors ?? []).map((v: { id: string }) => v.id));

      // Records before logins: projects, expenses and so on remember who
      // created them, and a login can't be deleted while records still point at
      // it. Note who the company's people are first, since removing the records
      // also detaches them from the company.
      const { data: people } = await adminClient.from("profiles").select("id").eq("company_id", co.id);
      const { error: rowsErr } = await adminClient.rpc("remove_company_rows", { c: co.id });
      if (rowsErr) return jsonResponse({ error: rowsErr.message }, 500);

      const failed: string[] = [];
      for (const p of people ?? []) {
        const { error } = await adminClient.auth.admin.deleteUser(p.id);
        if (error) failed.push(error.message);
      }
      // Their data is gone either way; a login that couldn't be deleted belongs
      // to no company and can see nothing, but say so rather than hide it.
      if (failed.length) {
        return jsonResponse({ error: `The company was removed, but ${failed.length} login(s) couldn't be deleted (${failed[0]}). They can't see anything.` }, 500);
      }
      return jsonResponse({ ok: true, removed: { buildings: codes.length, logins: (people ?? []).length, files: filesRemoved } }, 200);
    }

    if (action === "delete") {
      const targetId = typeof body.userId === "string" ? body.userId : "";
      if (!targetId) return jsonResponse({ error: "Missing userId." }, 400);
      if (targetId === userData.user.id) {
        return jsonResponse({ error: "You can't remove your own login this way." }, 400);
      }

      // Only people in your own company (any company for the Executive), never
      // the Executive, and never a company's last Admin.
      const { data: target } = await adminClient.from("profiles").select("role, company_id, is_executive").eq("id", targetId).maybeSingle();
      if (!target) return jsonResponse({ error: "No such login." }, 404);
      if (!isExecutive && target.company_id !== profile.company_id) {
        return jsonResponse({ error: "You can only remove logins in your own company." }, 403);
      }
      if (target.is_executive) return jsonResponse({ error: "The Executive's login can't be removed here." }, 403);
      if (target.role === "admin" && target.company_id) {
        const { count } = await adminClient.from("profiles").select("id", { count: "exact", head: true })
          .eq("company_id", target.company_id).eq("role", "admin").neq("id", targetId);
        if (!count) return jsonResponse({ error: "That's the company's last Admin. Make someone else an Admin first." }, 400);
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
