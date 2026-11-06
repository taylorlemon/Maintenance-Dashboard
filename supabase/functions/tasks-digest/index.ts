// Daily 6am work order email for each building's Staff (techs and front desk).
//
// This runs on Supabase's servers, not in anyone's browser. The database calls
// it every hour (see supabase/tasks/02-daily-email-schedule.sql). Each
// building is checked once a day, on the first run at or after 6am in its own
// time zone (later runs before noon only retry if the sending failed). For each one
// it lists the open work orders, PM and room turns that are urgent, overdue or
// due today, and sends that list to every Staff login on the building. Nothing
// is assigned to anyone, so everyone on the building gets the same email.
// Buildings with nothing urgent, overdue or due today get no email, and the
// task_digest_sends table makes sure no building gets two on the same day.
//
// Deploy notes: deployed with JWT verification turned off (the scheduler
// isn't a signed-in person):
//   supabase functions deploy tasks-digest --no-verify-jwt
// It's protected by the same shared scheduler secret as the other daily emails
// (STATS_SECRET, sent as the x-stats-secret header). RESEND_API_KEY is the same
// secret the other email functions use; SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY are provided automatically by the platform.
//
// Request body (all optional):
//   { "dryRun": true }          sends nothing, just reports who would get what
//   { "onlyTo": "a@b.com" }     sends just to that one Staff login (for testing)
//   { "anyHour": true }         don't wait for 6am (for testing)
//   { "only": "LP-LAK" }        just that one building (for testing)
//   { "dryRun": true, "preview": true }  also returns each email's HTML
// Test sends (dryRun / onlyTo / anyHour) don't count as the day's email.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { dayIn, pausedCompanyIds } from "../_shared/companies.ts";

const STATS_SECRET = Deno.env.get("STATS_SECRET");
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

// Same sender as the other email functions — keep them in step.
const FROM_ADDRESS = "StoneAnchor <reports@stoneanchor.app>";
const DASHBOARD_URL = "https://my.stoneanchor.app/";
// The local hour the email goes out.
const SEND_HOUR = 6;
// A morning email that couldn't go out (e.g. a failed send) is retried each
// hour until this hour; after that it waits for tomorrow rather than arrive late.
const LAST_HOUR = 12;
// The lists Staff work from (the same ones their screen shows).
const STAFF_KINDS = ["work_orders", "pm", "room_turns"];
const KIND_ORDER: Record<string, number> = { work_orders: 0, pm: 1, room_turns: 2 };

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

// The hour (0–23) it is right now in a building's time zone.
function hourIn(timeZone: string) {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: timeZone || "America/Denver", hour: "numeric", hourCycle: "h23" }).format(new Date());
  return Number(h);
}

type Task = { list_id: string; room: string; title: string; due_date: string | null; urgent: boolean };
type List = { id: string; name: string; kind: string; sort_order: number };

// Overdue first (oldest first), then due today, then urgent with a later or no date.
function rank(t: Task, today: string) {
  if (t.due_date && t.due_date < today) return 0;
  if (t.due_date === today) return 1;
  return 2;
}

function emailHtml(name: string, today: string, lists: List[], items: Task[], openWorkOrders: number, counts: { urgent: number; overdue: number; today: number }) {
  const tag = (t: Task) => {
    const bits: string[] = [];
    if (t.due_date && t.due_date < today) {
      const d = daysBetween(t.due_date, today);
      bits.push(`<span style="color:#cf3426;font-weight:700">${d} day${d === 1 ? "" : "s"} overdue</span>`);
    } else if (t.due_date === today) {
      bits.push(`<span style="color:#c4640f;font-weight:700">Due today</span>`);
    }
    if (t.urgent) bits.push(`<span style="background:#f6e0d6;color:#94492f;font-weight:700;border-radius:3px;padding:1px 6px;font-size:12px">URGENT</span>`);
    return bits.join(" &nbsp;");
  };
  const row = (t: Task) =>
    `<tr><td style="width:90px;padding:7px 10px 7px 0;border-bottom:1px solid #e9e1d5;white-space:nowrap;vertical-align:top"><span style="font-weight:700;border:1px solid #d9cfbf;background:#f5efe6;border-radius:3px;padding:1px 6px;font-size:13px">${escapeHtml(t.room)}</span></td>` +
    `<td style="padding:7px 12px 7px 0;border-bottom:1px solid #e9e1d5;color:#29261a;vertical-align:top">${escapeHtml(t.title || "(no description)")}</td>` +
    `<td style="padding:7px 0;border-bottom:1px solid #e9e1d5;text-align:right;white-space:nowrap;vertical-align:top">${tag(t)}</td></tr>`;

  let body = "";
  for (const l of lists) {
    const mine = items.filter((t) => t.list_id === l.id)
      .sort((a, b) => rank(a, today) - rank(b, today) || (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999"));
    if (!mine.length) continue;
    body += `<h3 style="margin:22px 0 6px;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#48473a">${escapeHtml(l.name)} (${mine.length})</h3>` +
      `<table style="border-collapse:collapse;width:100%;max-width:620px;font-size:14px">${mine.map(row).join("")}</table>`;
  }

  const stat = (n: number, label: string, color: string) =>
    `<td style="padding:10px 18px 10px 0"><div style="font-size:26px;font-weight:700;color:${color}">${n}</div><div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#48473a">${label}</div></td>`;
  return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#29261a">
<p style="margin:0 0 4px;font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#94492f">StoneAnchor · Today's work orders</p>
<h2 style="margin:0">${escapeHtml(name)}</h2>
<table style="border-collapse:collapse;margin-top:8px"><tr>
${stat(openWorkOrders, "Open work orders", "#29261a")}${stat(counts.urgent, "Urgent", "#94492f")}${stat(counts.overdue, "Overdue", "#cf3426")}${stat(counts.today, "Due today", "#c4640f")}
</tr></table>
${body}
<p style="margin:24px 0 0"><a href="${DASHBOARD_URL}" style="background:#94492f;color:#ffffff;text-decoration:none;font-weight:700;padding:10px 18px;border-radius:6px;display:inline-block">Open StoneAnchor</a></p>
<p style="margin:18px 0 0;color:#8a8574;font-size:12px">Sent every morning to the maintenance team for ${escapeHtml(name)} when something is urgent, overdue or due today. Check items off in StoneAnchor and they drop off tomorrow's email.</p>
</div>`;
}

Deno.serve(async (req) => {
  try {
    if (!STATS_SECRET) return jsonResponse({ error: "STATS_SECRET secret isn't set yet." }, 500);
    if (req.headers.get("x-stats-secret") !== STATS_SECRET) return jsonResponse({ error: "Not authorized." }, 401);
    let body: { onlyTo?: string; dryRun?: boolean; anyHour?: boolean; only?: string; preview?: boolean } = {};
    try { body = await req.json(); } catch (_) { /* empty body = defaults */ }
    if (!RESEND_API_KEY && !body.dryRun) return jsonResponse({ error: "RESEND_API_KEY secret isn't set yet." }, 500);
    const isTest = !!(body.dryRun || body.onlyTo || body.anyHour);

    const sb = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);
    const paused = await pausedCompanyIds(sb);

    let propQuery = sb.from("properties").select("code, name, company_id, time_zone").order("name");
    if (body.only) propQuery = propQuery.eq("code", body.only);
    const { data: properties, error: propErr } = await propQuery;
    if (propErr) return jsonResponse({ error: propErr.message }, 500);

    const results: string[] = [];
    const previews: { code: string; subject: string; html: string }[] = [];

    for (const p of properties ?? []) {
      const hour = hourIn(p.time_zone);
      if (!body.anyHour && (hour < SEND_HOUR || hour >= LAST_HOUR)) continue;
      if (paused.has(p.company_id)) { results.push(`${p.code}: skipped, its company is paused`); continue; }
      const today = dayIn(p.time_zone);

      // Claim today's check for this building first, so later hourly runs (or a
      // retry) can't send it twice. Test sends don't claim it. If reading or
      // sending fails below, the claim is released so the next run tries again.
      if (!isTest) {
        const claim = await sb.from("task_digest_sends").insert({ property_code: p.code, day: today });
        if (claim.error) {
          if (claim.error.code !== "23505") results.push(`${p.code}: failed to record the check: ${claim.error.message}`);
          continue;   // 23505 = already done today
        }
      }
      const release = async () => {
        if (!isTest) await sb.from("task_digest_sends").delete().eq("property_code", p.code).eq("day", today);
      };

      // Who gets it: Staff logins assigned to this building, in its company.
      const { data: assigned, error: aErr } = await sb.from("profile_properties")
        .select("profiles!inner(email, role, company_id)").eq("property_code", p.code);
      if (aErr) { results.push(`${p.code}: failed to read the Staff list: ${aErr.message}`); await release(); continue; }
      // deno-lint-ignore no-explicit-any
      let to = (assigned ?? []).map((a: any) => a.profiles)
        .filter((pr: { email: string; role: string; company_id: string }) => pr && pr.role === "staff" && pr.email && pr.company_id === p.company_id)
        .map((pr: { email: string }) => pr.email);
      if (body.onlyTo) to = to.filter((e: string) => e.toLowerCase() === body.onlyTo!.toLowerCase());
      if (!to.length) { results.push(`${p.code}: no Staff logins${body.onlyTo ? " matching onlyTo" : ""}, no email`); continue; }

      const { data: lists, error: lErr } = await sb.from("task_lists").select("id, name, kind, sort_order")
        .eq("property_code", p.code).eq("archived", false).in("kind", STAFF_KINDS);
      if (lErr) { results.push(`${p.code}: failed to read the lists: ${lErr.message}`); await release(); continue; }
      if (!lists?.length) { results.push(`${p.code}: no task lists yet, no email`); continue; }
      lists.sort((a: List, b: List) => (KIND_ORDER[a.kind] - KIND_ORDER[b.kind]) || (a.sort_order - b.sort_order) || a.name.localeCompare(b.name));

      const { data: open, error: tErr } = await sb.from("tasks").select("list_id, room, title, due_date, urgent")
        .in("list_id", lists.map((l: List) => l.id)).is("completed_at", null).is("cancelled_at", null).limit(5000);
      if (tErr) { results.push(`${p.code}: failed to read the tasks: ${tErr.message}`); await release(); continue; }

      const items = (open as Task[]).filter((t) => t.urgent || (t.due_date && t.due_date <= today));
      if (!items.length) { results.push(`${p.code}: nothing urgent, overdue or due today, no email`); continue; }
      const counts = {
        urgent: items.filter((t) => t.urgent).length,
        overdue: items.filter((t) => t.due_date && t.due_date < today).length,
        today: items.filter((t) => t.due_date === today).length,
      };
      const woIds = new Set(lists.filter((l: List) => l.kind === "work_orders").map((l: List) => l.id));
      const openWorkOrders = (open as Task[]).filter((t) => woIds.has(t.list_id)).length;

      const parts = [];
      if (counts.urgent) parts.push(`${counts.urgent} urgent`);
      if (counts.overdue) parts.push(`${counts.overdue} overdue`);
      if (counts.today) parts.push(`${counts.today} due today`);
      const subject = `${p.name} — work orders: ${parts.join(", ")}`;
      const html = emailHtml(p.name, today, lists, items, openWorkOrders, counts);

      if (body.dryRun && body.preview) previews.push({ code: p.code, subject, html });
      // One message per person, so a failed send to one can't stop the others.
      let sentAny = false;
      for (const addr of to) {
        if (body.dryRun) { results.push(`${p.code} -> ${addr}: would send "${subject}"`); continue; }
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: "Bearer " + RESEND_API_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ from: FROM_ADDRESS, to: [addr], subject, html }),
        });
        if (res.ok) sentAny = true;
        results.push(`${p.code} -> ${addr}: ${res.ok ? "sent" : "failed (" + res.status + ")"}`);
        // Resend allows a couple of sends per second; stay under it.
        await new Promise((r) => setTimeout(r, 600));
      }
      // Nothing went out at all: release the claim so the next hourly run can retry.
      if (!sentAny) await release();
    }

    const anyFailed = results.some((r) => r.includes("failed"));
    return jsonResponse({ ok: !anyFailed, dryRun: !!body.dryRun, results, ...(body.preview ? { previews } : {}) }, anyFailed ? 500 : 200);
  } catch (err) {
    return jsonResponse({ error: (err as Error).message }, 500);
  }
});
