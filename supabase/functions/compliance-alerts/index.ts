// Daily building compliance reminder email.
//
// This runs on Supabase's servers, not in anyone's browser — the database
// calls it once a day on its own schedule (see the "Daily compliance reminder
// email" section near the bottom of supabase-schema.sql). For every facility
// connected to the Asana compliance board, it looks at the same open
// compliance tasks the Building Compliance tab shows and, if any are overdue
// or due within the next DUE_SOON_DAYS days, emails every Admin one message
// for that facility listing them. Facilities with nothing outstanding get no
// email, so a reminder always means something needs attention.
//
// Deploy notes: deployed with JWT verification turned off (the scheduler
// isn't a signed-in person):
//   supabase functions deploy compliance-alerts --no-verify-jwt
// It's protected by the same shared scheduler secret as work-order-stats
// (STATS_SECRET, sent as the x-stats-secret header and read by the schedule
// from the database Vault as "work_order_stats_secret"), so there's no new
// secret to set. ASANA_TOKEN and RESEND_API_KEY are the same secrets the
// other functions use; SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are
// provided automatically by the platform.
//
// Request body (all optional): { "onlyTo": "someone@example.com" } sends
// just to that one Admin — for testing a change without emailing everyone.
// { "dryRun": true } sends nothing and just reports who would get what.
//
// Each company's facilities are read with that company's own Asana key, and
// their emails go to that company's Admins only.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { adminEmailsByCompany, companyAsanaLookup, dayIn, pausedCompanyIds } from "../_shared/companies.ts";

const STATS_SECRET = Deno.env.get("STATS_SECRET");
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

// Same sender as the other email functions — keep them in step. Requires
// stoneanchor.app to be verified in Resend.
const FROM_ADDRESS = "StoneAnchor <reports@stoneanchor.app>";
// Linked from each email.
const DASHBOARD_URL = "https://my.stoneanchor.app/";
// Items due within this many days are included as "due soon"; overdue items
// are always included.
const DUE_SOON_DAYS = 7;

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function escapeHtml(s: string) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string
  ));
}

const DAY_MS = 86400000;
function dayToUtcMs(day: string) {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}
function daysBetween(fromDay: string, toDay: string) {
  return Math.round((dayToUtcMs(toDay) - dayToUtcMs(fromDay)) / DAY_MS);
}
function fmtDay(day: string) {
  return new Date(dayToUtcMs(day)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

type Task = { name: string; due_on: string | null; completed: boolean };

// Open tasks in one facility's section of the compliance board — the same
// request the Building Compliance tab makes (js/compliance.js).
async function getOpenComplianceTasks(sectionGid: string, token: string): Promise<Task[]> {
  const tasks: Task[] = [];
  let offset: string | null = null;
  while (true) {
    let url = `https://app.asana.com/api/1.0/tasks?section=${sectionGid}&opt_fields=name,due_on,completed&limit=100`;
    if (offset) url += "&offset=" + offset;
    const res = await fetch(url, { headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
    if (!res.ok) throw new Error(`Asana returned ${res.status}`);
    const page = await res.json();
    tasks.push(...page.data);
    if (page.next_page) offset = page.next_page.offset;
    else break;
  }
  return tasks.filter((t) => !t.completed);
}

// The same, for a building switched off Asana: its StoneAnchor Compliance
// Tracking list (cancelled ones don't count).
async function getOpenStoneAnchorComplianceTasks(sb: ReturnType<typeof createClient>, code: string): Promise<Task[]> {
  const { data: lists, error: lErr } = await sb.from("task_lists").select("id").eq("property_code", code).eq("kind", "compliance").eq("archived", false);
  if (lErr) throw new Error(lErr.message);
  if (!lists?.length) return [];
  const { data, error } = await sb.from("tasks").select("room, title, due_date")
    .in("list_id", lists.map((l: { id: string }) => l.id)).is("completed_at", null).is("cancelled_at", null).limit(5000);
  if (error) throw new Error(error.message);
  return (data ?? []).map((t: { room: string; title: string; due_date: string | null }) => ({
    name: !t.title ? t.room : (t.room === "General" ? t.title : `${t.room} — ${t.title}`), due_on: t.due_date, completed: false,
  }));
}

function emailHtml(name: string, today: string, overdue: Task[], dueSoon: Task[]) {
  const row = (t: Task, note: string, noteColor: string) =>
    `<tr><td style="padding:7px 16px 7px 0;border-bottom:1px solid #e9e1d5;color:#29261a">${escapeHtml(t.name)}</td>` +
    `<td style="padding:7px 0;border-bottom:1px solid #e9e1d5;text-align:right;white-space:nowrap;color:${noteColor};font-weight:700">${note}</td></tr>`;
  const section = (title: string, rows: string) =>
    `<h3 style="margin:20px 0 6px;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#48473a">${title}</h3>` +
    `<table style="border-collapse:collapse;width:100%;max-width:560px;font-size:14px">${rows}</table>`;

  let body = "";
  if (overdue.length) {
    body += section(`Overdue (${overdue.length})`, overdue.map((t) => {
      const d = daysBetween(t.due_on!, today);
      return row(t, `${d} day${d === 1 ? "" : "s"} overdue`, "#cf3426");
    }).join(""));
  }
  if (dueSoon.length) {
    body += section(`Due in the next ${DUE_SOON_DAYS} days (${dueSoon.length})`, dueSoon.map((t) => {
      const d = daysBetween(today, t.due_on!);
      return row(t, d === 0 ? "Due today" : `Due ${fmtDay(t.due_on!)}`, "#c4640f");
    }).join(""));
  }
  return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#29261a">
<p style="margin:0 0 4px;font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#94492f">StoneAnchor · Building Compliance</p>
<h2 style="margin:0">${escapeHtml(name)}</h2>
${body}
<p style="margin:20px 0 0;color:#48473a">These stay on this daily email until they're marked complete. <a href="${DASHBOARD_URL}" style="color:#94492f">Open the dashboard</a></p>
</div>`;
}

Deno.serve(async (req) => {
  try {
    if (!STATS_SECRET) return jsonResponse({ error: "STATS_SECRET secret isn't set yet." }, 500);
    if (req.headers.get("x-stats-secret") !== STATS_SECRET) return jsonResponse({ error: "Not authorized." }, 401);
    let body: { onlyTo?: string; dryRun?: boolean } = {};
    try { body = await req.json(); } catch (_) { /* empty body = defaults */ }
    if (!RESEND_API_KEY && !body.dryRun) return jsonResponse({ error: "RESEND_API_KEY secret isn't set yet." }, 500);

    const sb = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);
    const adminsByCompany = await adminEmailsByCompany(sb, body.onlyTo);
    const asanaFor = companyAsanaLookup(sb);
    const paused = await pausedCompanyIds(sb);

    const { data: properties, error: propErr } = await sb.from("properties")
      .select("code, name, company_id, time_zone, asana_compliance_section_gid, task_source")
      .or("asana_compliance_section_gid.not.is.null,task_source.eq.stoneanchor").order("name");
    if (propErr) return jsonResponse({ error: propErr.message }, 500);

    const results: string[] = [];

    for (const p of properties ?? []) {
      if (paused.has(p.company_id)) { results.push(`${p.code}: skipped, its company is paused`); continue; }
      // "Today" in the facility's own time zone.
      const today = dayIn(p.time_zone);
      const onStoneAnchor = p.task_source === "stoneanchor";
      const { token } = onStoneAnchor ? { token: "" } : await asanaFor(p.company_id);
      if (!onStoneAnchor && !token) { results.push(`${p.code}: failed, its company isn't connected to Asana`); continue; }
      let tasks: Task[];
      try {
        tasks = onStoneAnchor
          ? await getOpenStoneAnchorComplianceTasks(sb, p.code)
          : await getOpenComplianceTasks(p.asana_compliance_section_gid, token!);
      } catch (err) {
        results.push(`${p.code}: failed to read ${onStoneAnchor ? "its task lists" : "Asana"}: ${(err as Error).message}`);
        continue;
      }
      // Same rules as the Building Compliance tab: overdue = due before today.
      // Tasks with no due date aren't counted (the tab doesn't show them either).
      const overdue = tasks.filter((t) => t.due_on && t.due_on < today)
        .sort((a, b) => a.due_on!.localeCompare(b.due_on!));
      const dueSoon = tasks.filter((t) => t.due_on && t.due_on >= today && daysBetween(today, t.due_on) <= DUE_SOON_DAYS)
        .sort((a, b) => a.due_on!.localeCompare(b.due_on!));
      if (!overdue.length && !dueSoon.length) { results.push(`${p.code}: all clear, no email`); continue; }

      const parts = [];
      if (overdue.length) parts.push(`${overdue.length} overdue`);
      if (dueSoon.length) parts.push(`${dueSoon.length} due this week`);
      const subject = `${p.name} — compliance: ${parts.join(", ")}`;
      const html = emailHtml(p.name, today, overdue, dueSoon);

      // This facility's company's Admins only. One message per Admin, so a
      // failed send to one person can't stop the others.
      for (const to of adminsByCompany.get(p.company_id) ?? []) {
        if (body.dryRun) { results.push(`${p.code} -> ${to}: would send`); continue; }
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: "Bearer " + RESEND_API_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ from: FROM_ADDRESS, to: [to], subject, html }),
        });
        results.push(`${p.code} -> ${to}: ${res.ok ? "sent" : "failed (" + res.status + ")"}`);
        // Resend allows a couple of sends per second; stay under it.
        await new Promise((r) => setTimeout(r, 600));
      }
    }

    const anyFailed = results.some((r) => r.includes("failed"));
    return jsonResponse({ ok: !anyFailed, dryRun: !!body.dryRun, results }, anyFailed ? 500 : 200);
  } catch (err) {
    return jsonResponse({ error: (err as Error).message }, 500);
  }
});
