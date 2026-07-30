// Vendor contract expiration alerts.
//
// This runs on Supabase's servers, not in anyone's browser, and isn't
// triggered by visiting the page — the database calls it once a day on its
// own schedule (see the "Daily contract-expiration email check" section near
// the bottom of supabase-schema.sql). It looks for vendor contracts that
// have newly come within WARNING_DAYS of expiring and haven't been emailed
// about yet, sends one digest email to every Admin, and marks those
// contracts so they're never emailed about twice.
//
// Deploy notes: create this function in the Supabase Dashboard (Edge
// Functions), paste this file in, deploy it, then add a secret named
// RESEND_API_KEY with your Resend API key (Edge Functions -> Secrets).
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically by
// the platform. This function uses the service role key (not the anon key)
// because it needs to see every facility's contracts and every Admin's
// email address, regardless of which facilities any one person can see.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

// Shared secret proving the caller is the database's nightly scheduler.
// This function is deployed with JWT verification turned off (it isn't called
// by a signed-in person), which without this check left it callable by anyone
// who knew the URL — enough to spam every Admin's inbox or burn through the
// email quota so real alerts stop sending. Set with:
//   supabase secrets set ALERT_SECRET=<value>
// and pass the same value as the x-alert-secret header from the cron job (see
// the "Daily contract-expiration email check" section of supabase-schema.sql).
const ALERT_SECRET = Deno.env.get("ALERT_SECRET");

// Change this once you've verified your own domain in Resend — see the
// message Claude gave when this was built for why an unverified account
// can't email a whole list of Admins.
const FROM_ADDRESS = "Property Pulse <onboarding@resend.dev>";
const WARNING_DAYS = 30;

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function escapeHtml(s: string) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string
  ));
}

Deno.serve(async (req) => {
  try {
    if (!ALERT_SECRET) return jsonResponse({ error: "ALERT_SECRET secret isn't set on this function yet." }, 500);
    if (req.headers.get("x-alert-secret") !== ALERT_SECRET) {
      return jsonResponse({ error: "Not authorized." }, 401);
    }
    if (!RESEND_API_KEY) return jsonResponse({ error: "RESEND_API_KEY secret isn't set on this function yet." }, 500);

    const sb = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + WARNING_DAYS);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const { data: contracts, error: contractsErr } = await sb
      .from("vendor_contracts")
      .select("id, expires_on, file_name, vendors(name, property_code, properties(name))")
      .is("expiration_alert_sent_at", null)
      .lte("expires_on", cutoffStr);
    if (contractsErr) return jsonResponse({ error: contractsErr.message }, 500);

    if (!contracts || contracts.length === 0) {
      return jsonResponse({ ok: true, alertsSent: 0 }, 200);
    }

    const { data: admins, error: adminsErr } = await sb.from("profiles").select("email").eq("role", "admin");
    if (adminsErr) return jsonResponse({ error: adminsErr.message }, 500);
    const adminEmails = (admins ?? []).map((a) => a.email).filter(Boolean);

    if (adminEmails.length > 0) {
      const rows = contracts.map((c: any) => {
        const vendor = Array.isArray(c.vendors) ? c.vendors[0] : c.vendors;
        const propertyRaw = vendor?.properties;
        const property = Array.isArray(propertyRaw) ? propertyRaw[0] : propertyRaw;
        const propertyName = property?.name ?? vendor?.property_code ?? "";
        return "<li>" + escapeHtml(vendor?.name ?? "Unknown vendor") + " (" + escapeHtml(propertyName) + ") — \"" +
          escapeHtml(c.file_name) + "\" expires " + c.expires_on + "</li>";
      }).join("");

      const html = "<p>The following vendor contracts expire within " + WARNING_DAYS + " days:</p><ul>" + rows + "</ul>" +
        "<p>Open the Vendors tab in Property Pulse to review or upload a renewal.</p>";

      const emailRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: "Bearer " + RESEND_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: FROM_ADDRESS,
          to: adminEmails,
          subject: contracts.length + " vendor contract" + (contracts.length === 1 ? "" : "s") + " expiring soon",
          html: html,
        }),
      });
      if (!emailRes.ok) {
        const errText = await emailRes.text();
        return jsonResponse({ error: "Resend request failed: " + errText }, 500);
      }
    }

    const ids = contracts.map((c: any) => c.id);
    const { error: updateErr } = await sb
      .from("vendor_contracts")
      .update({ expiration_alert_sent_at: new Date().toISOString() })
      .in("id", ids);
    if (updateErr) return jsonResponse({ error: updateErr.message }, 500);

    return jsonResponse({ ok: true, alertsSent: contracts.length }, 200);
  } catch (e) {
    return jsonResponse({ error: String(e) }, 500);
  }
});
