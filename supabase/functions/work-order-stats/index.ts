// Work order daily stats.
//
// This runs on Supabase's servers, not in anyone's browser, and isn't
// triggered by visiting the page — the database calls it once an hour on its
// own schedule (see the "Work order daily history" section near the bottom of
// supabase-schema.sql). For every facility connected to Asana, it works out
// one row per day — work orders added, completed, still open at the end of
// the day, overdue at the end of the day, and total days-to-complete — and
// saves them in the work_order_daily_stats table. The Work Orders tab's trend
// chart and weekly history table read that table instead of asking Asana
// live, which is what makes them load quickly.
//
// Two modes (sent in the request body as { "mode": ... }):
//   "recent"   (default, what the hourly schedule sends) — rewrites today's
//              and yesterday's rows, and fills in any missing day from the
//              past week (e.g. if the schedule didn't run for a while).
//   "backfill" — rebuilds up to { "days": N } days of history (default 400)
//              from Asana's records. Never overwrites a day that was already
//              saved, and marks every row it adds as an estimate (see below).
//   "monthly-email" — sent by a separate schedule on the 1st of each month.
//              Emails each company's Admins one message per facility of
//              theirs (add { "dryRun": true } to just list them), covering the
//              month that just ended (or { "month": "YYYY-MM" }): a short
//              summary compared with the month before, plus that month's
//              day-by-day numbers attached as an Excel file. Each
//              month's file only covers that month, so together they build up
//              a copy of the history outside Supabase.
//
// Why "estimate": "added" and "completed" for a past day are exact — Asana
// keeps those dates. But "open" and "overdue" on a past day are rebuilt using
// each work order's *current* due date and only work orders that still exist,
// so they can be slightly off if a due date was changed or a task deleted
// since. Days saved by the hourly run are the real numbers as of that day.
//
// Deploy notes: deployed with JWT verification turned off (the scheduler
// isn't a signed-in person), so the x-stats-secret header is the only thing
// stopping anyone on the internet from triggering it:
//   supabase functions deploy work-order-stats --no-verify-jwt
//   supabase secrets set STATS_SECRET=<value>
// and the same value stored in the database Vault as
// "work_order_stats_secret" (the schedule reads it from there, so the value
// never has to be written into this public repository). ASANA_TOKEN is the
// same secret the asana-proxy function already uses, and RESEND_API_KEY the
// same one the contract-alerts function uses to send email. SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY are provided automatically by the platform. This
// uses the service role key because no person is signed in, and it needs to
// write every facility's rows.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import JSZip from "https://esm.sh/jszip@3.10.1";
// Sets globalThis.workOrderHistoryXlsx — shared with the dashboard page.
import "../../../js/xlsx-writer.js";
import { adminEmailsByCompany, companyAsanaLookup, dayIn, pausedCompanyIds } from "../_shared/companies.ts";

const STATS_SECRET = Deno.env.get("STATS_SECRET");
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");

// Same sender as the other email functions — keep them in step. It only
// works while stoneanchor.app stays verified in Resend; if verification
// lapses, sends fail (and are reported in this function's response)
// without blocking the others.
const FROM_ADDRESS = "StoneAnchor <reports@stoneanchor.app>";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

// Days are counted in each facility's own time zone (properties.time_zone).

const DAY_MS = 86400000;

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function dayToUtcMs(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function addDays(day: string, n: number): string {
  return new Date(dayToUtcMs(day) + n * DAY_MS).toISOString().slice(0, 10);
}

async function asanaGet(path: string, token: string) {
  // Asana limits how many requests can be made per minute; when we hit that
  // it answers 429 with how long to wait. Wait and try again rather than
  // failing the whole run. Also retry briefly on Asana's own server errors.
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch("https://app.asana.com/api/1.0" + path, {
      headers: { Authorization: "Bearer " + token, Accept: "application/json" },
    });
    if (res.ok) return await res.json();
    if (res.status === 429 || res.status >= 500) {
      const waitSec = Number(res.headers.get("Retry-After")) || 2 ** attempt;
      await new Promise((r) => setTimeout(r, waitSec * 1000));
      continue;
    }
    throw new Error(`Asana returned ${res.status} for ${path.split("?")[0]}`);
  }
  throw new Error(`Asana kept refusing requests for ${path.split("?")[0]}`);
}

type Task = { created_at: string | null; completed_at: string | null; completed: boolean; due_on: string | null };

// Every work order still open, plus every one completed since `sinceDay`.
async function fetchAsanaTasks(projectGid: string, sinceDay: string, token: string): Promise<Task[]> {
  // Start a day early so time-zone differences can't drop a task completed
  // late on the first day; anything earlier is simply ignored below.
  const since = addDays(sinceDay, -1) + "T00:00:00.000Z";
  const fields = "created_at,completed_at,completed,due_on";
  const tasks: Task[] = [];
  let offset: string | null = null;
  while (true) {
    let path = `/tasks?project=${projectGid}&completed_since=${since}&opt_fields=${fields}&limit=100`;
    if (offset) path += "&offset=" + offset;
    const page = await asanaGet(path, token);
    tasks.push(...page.data);
    if (page.next_page) offset = page.next_page.offset;
    else break;
  }
  return tasks;
}

// The same, for a building switched off Asana: its StoneAnchor Work Orders
// list(s). Cancelled tasks (entered by mistake) don't count.
async function fetchStoneAnchorTasks(sb: ReturnType<typeof createClient>, code: string, sinceDay: string): Promise<Task[]> {
  const since = addDays(sinceDay, -1) + "T00:00:00.000Z";
  const { data: lists, error: lErr } = await sb.from("task_lists").select("id").eq("property_code", code).eq("kind", "work_orders");
  if (lErr) throw new Error(lErr.message);
  if (!lists?.length) return [];
  const ids = lists.map((l: { id: string }) => l.id);
  const tasks: Task[] = [];
  // Open ones, then ones completed since `since`, a page at a time.
  for (const open of [true, false]) {
    for (let from = 0; ; from += 1000) {
      let q = sb.from("tasks").select("created_at, completed_at, due_date").in("list_id", ids).is("cancelled_at", null);
      q = open ? q.is("completed_at", null) : q.gte("completed_at", since);
      const { data, error } = await q.order("id").range(from, from + 999);
      if (error) throw new Error(error.message);
      for (const t of data ?? []) tasks.push({ created_at: t.created_at, completed_at: t.completed_at, completed: !!t.completed_at, due_on: t.due_date });
      if (!data || data.length < 1000) break;
    }
  }
  return tasks;
}

type DayRow = {
  property_code: string;
  stat_date: string;
  added: number;
  completed: number;
  open_count: number;
  overdue_count: number;
  completed_days_total: number;
  is_estimate: boolean;
  updated_at: string;
};

// One row per day from firstDay through today. Uses "difference arrays":
// rather than checking every task against every day, each task marks the day
// its open stretch starts (+1) and the day it ends (-1), and a running total
// across the days gives the open count for each one.
function computeDays(code: string, tasks: Task[], firstDay: string, today: string, isEstimate: boolean, timeZone: string): DayRow[] {
  const localDay = (iso: string) => dayIn(timeZone, iso);
  const n = Math.round((dayToUtcMs(today) - dayToUtcMs(firstDay)) / DAY_MS) + 1;
  const idx = (day: string) => Math.round((dayToUtcMs(day) - dayToUtcMs(firstDay)) / DAY_MS);
  const added = new Array(n).fill(0);
  const completed = new Array(n).fill(0);
  const daysTotal = new Array(n).fill(0);
  const openDelta = new Array(n + 1).fill(0);
  const overdueDelta = new Array(n + 1).fill(0);

  function markRange(delta: number[], from: number, toExclusive: number) {
    const a = Math.max(from, 0);
    const b = Math.min(toExclusive, n);
    if (a >= b) return;
    delta[a] += 1;
    delta[b] -= 1;
  }

  for (const t of tasks) {
    if (!t.created_at) continue;
    const createdIdx = idx(localDay(t.created_at));
    const doneIdx = t.completed && t.completed_at ? idx(localDay(t.completed_at)) : n;

    if (createdIdx >= 0 && createdIdx < n) added[createdIdx]++;
    if (doneIdx >= 0 && doneIdx < n) {
      completed[doneIdx]++;
      daysTotal[doneIdx] += (new Date(t.completed_at!).getTime() - new Date(t.created_at).getTime()) / DAY_MS;
    }
    // Open at the end of every day from the day it was created up to (but
    // not including) the day it was completed.
    markRange(openDelta, createdIdx, doneIdx);
    // Overdue = open on a day that's past its due date — same rule as the
    // "Overdue Work Orders" count on each facility card.
    if (t.due_on) markRange(overdueDelta, Math.max(createdIdx, idx(t.due_on) + 1), doneIdx);
  }

  const rows: DayRow[] = [];
  const now = new Date().toISOString();
  let open = 0, overdue = 0;
  for (let i = 0; i < n; i++) {
    open += openDelta[i];
    overdue += overdueDelta[i];
    rows.push({
      property_code: code,
      stat_date: addDays(firstDay, i),
      added: added[i],
      completed: completed[i],
      open_count: open,
      overdue_count: overdue,
      completed_days_total: Math.round(daysTotal[i] * 100) / 100,
      is_estimate: isEstimate,
      updated_at: now,
    });
  }
  return rows;
}

// ── Monthly email ─────────────────────────────────────────────────────────────

type SavedRow = {
  stat_date: string; added: number; completed: number; open_count: number;
  overdue_count: number; completed_days_total: number; is_estimate: boolean;
};

function escapeHtml(s: string) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string
  ));
}

// The attachment is built by the same file the dashboard's "Download history"
// button uses (js/xlsx-writer.js), so monthly files and downloads always have
// the same layout. Returned as base64, which is how Resend takes attachments.
async function historyXlsxBase64(code: string, name: string, rows: SavedRow[]) {
  const withCode = rows.map((r) => ({ ...r, property_code: code }));
  // deno-lint-ignore no-explicit-any
  const zip = (globalThis as any).workOrderHistoryXlsx(JSZip, name, { [code]: name }, withCode);
  return await zip.generateAsync({ type: "base64", compression: "DEFLATE" }) as string;
}

function monthTotals(rows: SavedRow[]) {
  const last = rows[rows.length - 1];
  const added = rows.reduce((s, r) => s + r.added, 0);
  const completed = rows.reduce((s, r) => s + r.completed, 0);
  const daysTotal = rows.reduce((s, r) => s + Number(r.completed_days_total), 0);
  return {
    added, completed,
    open: last ? last.open_count : null,
    overdue: last ? last.overdue_count : null,
    avgDays: completed > 0 ? daysTotal / completed : null,
  };
}

// Rows from before a facility started using Asana are saved as all zeros —
// a month made only of those has nothing worth emailing.
function hasActivity(rows: SavedRow[]) {
  return rows.some((r) => r.added > 0 || r.completed > 0 || r.open_count > 0);
}

function monthEmailHtml(name: string, monthLabel: string, prevLabel: string,
  cur: ReturnType<typeof monthTotals>, prev: ReturnType<typeof monthTotals> | null, anyEstimate: boolean) {
  const fmtDays = (v: number | null) => v == null ? "—" : Math.round(v) + " days";
  const line = (label: string, a: string | number | null, b: string | number | null) =>
    `<tr><td style="padding:6px 16px 6px 0;color:#475569">${label}</td>` +
    `<td style="padding:6px 16px;font-weight:700;color:#1e293b;text-align:right">${a ?? "—"}</td>` +
    `<td style="padding:6px 0 6px 16px;color:#64748b;text-align:right">${b ?? "—"}</td></tr>`;
  return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1e293b">
<p style="margin:0 0 4px;font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#94492f">StoneAnchor · Work Orders</p>
<h2 style="margin:0 0 16px">${escapeHtml(name)} — ${monthLabel}</h2>
<table style="border-collapse:collapse;font-size:14px">
<tr><th></th><th style="padding:0 16px 6px;text-align:right;font-size:11px;color:#64748b">${monthLabel}</th>
<th style="padding:0 0 6px 16px;text-align:right;font-size:11px;color:#64748b">${prevLabel}</th></tr>
${line("Added", cur.added, prev ? prev.added : null)}
${line("Completed", cur.completed, prev ? prev.completed : null)}
${line("Open at month end", cur.open, prev ? prev.open : null)}
${line("Overdue at month end", cur.overdue, prev ? prev.overdue : null)}
${line("Avg time to complete", fmtDays(cur.avgDays), prev ? fmtDays(prev.avgDays) : null)}
</table>
<p style="margin:16px 0 0;color:#475569">The attached spreadsheet has every day of ${monthLabel}. Save it somewhere safe — together, these monthly files are a backup copy of the work order history.</p>
${anyEstimate ? `<p style="margin:8px 0 0;font-size:12px;color:#64748b">Some days this month were rebuilt afterward from Asana's records rather than recorded on the day; they're marked in the file's Source column.</p>` : ""}
</div>`;
}

// onlyTo: send to just this one Admin (for testing) instead of every Admin.
// dryRun: send nothing, just report who would get which facility's email.
async function sendMonthlyEmails(sb: ReturnType<typeof createClient>, monthParam: string | undefined, onlyTo?: string, dryRun?: boolean) {
  if (!RESEND_API_KEY && !dryRun) return jsonResponse({ error: "RESEND_API_KEY secret isn't set on this function yet." }, 500);

  // The month that just ended (in Utah time — the schedule runs mid-morning
  // on the 1st, when every US time zone agrees), unless one was asked for.
  const today = dayIn("America/Denver");
  const month = monthParam && /^\d{4}-\d{2}$/.test(monthParam)
    ? monthParam
    : addDays(today.slice(0, 8) + "01", -1).slice(0, 7);
  const first = month + "-01";
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);   // day 0 of next month = last day of this one
  const prevFirst = addDays(first, -1).slice(0, 8) + "01";
  const label = (d: string) => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const monthLabel = label(first);
  const prevLabel = label(prevFirst);

  const adminsByCompany = await adminEmailsByCompany(sb, onlyTo);

  const { data: properties, error: propErr } = await sb.from("properties").select("code, name, company_id").order("name");
  if (propErr) return jsonResponse({ error: propErr.message }, 500);

  const results: string[] = [];
  for (const p of properties ?? []) {
    const { data: rows, error } = await sb.from("work_order_daily_stats")
      .select("stat_date,added,completed,open_count,overdue_count,completed_days_total,is_estimate")
      .eq("property_code", p.code).gte("stat_date", prevFirst).lte("stat_date", last).order("stat_date");
    if (error) { results.push(`${p.code}: failed to read history: ${error.message}`); continue; }
    const cur = (rows ?? []).filter((r) => r.stat_date >= first) as SavedRow[];
    const prev = (rows ?? []).filter((r) => r.stat_date < first) as SavedRow[];
    if (!hasActivity(cur)) { results.push(`${p.code}: skipped, no history for ${month}`); continue; }

    const recipients = adminsByCompany.get(p.company_id) ?? [];
    if (!recipients.length) { results.push(`${p.code}: skipped, no Admins to send to (or its company is paused)`); continue; }
    if (dryRun) { for (const to of recipients) results.push(`${p.code} -> ${to}: would send`); continue; }
    const html = monthEmailHtml(p.name, monthLabel, prevLabel, monthTotals(cur), hasActivity(prev) ? monthTotals(prev) : null,
      cur.some((r) => r.is_estimate));
    const attachment = await historyXlsxBase64(p.code, p.name, cur);

    // This facility's company's Admins only. One message per Admin (not one
    // message to all of them), so a failed send to one person can't stop the others.
    for (const to of recipients) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: "Bearer " + RESEND_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: FROM_ADDRESS,
          to: [to],
          subject: `${p.name} — ${monthLabel} work order summary`,
          html,
          attachments: [{ filename: `work-order-history_${p.code}_${month}.xlsx`, content: attachment }],
        }),
      });
      results.push(`${p.code} -> ${to}: ${res.ok ? "sent" : "failed (" + res.status + ")"}`);
      // Resend allows a couple of sends per second; stay under it.
      await new Promise((r) => setTimeout(r, 600));
    }
  }
  const anyFailed = results.some((r) => r.includes("failed"));
  return jsonResponse({ ok: !anyFailed, mode: "monthly-email", month, results }, anyFailed ? 500 : 200);
}

Deno.serve(async (req) => {
  try {
    if (!STATS_SECRET) return jsonResponse({ error: "STATS_SECRET secret isn't set on this function yet." }, 500);
    if (req.headers.get("x-stats-secret") !== STATS_SECRET) return jsonResponse({ error: "Not authorized." }, 401);
    let body: { mode?: string; days?: number; propertyCode?: string; month?: string; onlyTo?: string; dryRun?: boolean } = {};
    try { body = await req.json(); } catch (_) { /* empty body = defaults */ }

    const sb = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);
    if (body.mode === "monthly-email") return await sendMonthlyEmails(sb, body.month, body.onlyTo, body.dryRun);

    const mode = body.mode === "backfill" ? "backfill" : "recent";
    const asanaFor = companyAsanaLookup(sb);
    const paused = await pausedCompanyIds(sb);
    let query = sb.from("properties").select("code, company_id, time_zone, asana_project_gid, task_source")
      .or("asana_project_gid.not.is.null,task_source.eq.stoneanchor");
    if (body.propertyCode) query = query.eq("code", body.propertyCode);
    const { data: properties, error: propErr } = await query;
    if (propErr) return jsonResponse({ error: propErr.message }, 500);

    const results: Record<string, string> = {};

    await Promise.all((properties ?? []).filter((p) => !paused.has(p.company_id)).map(async (p) => {
      try {
        // Each facility's own "today", read with its own company's Asana key.
        const today = dayIn(p.time_zone);
        // A building switched off Asana is read from StoneAnchor's own lists.
        const onStoneAnchor = p.task_source === "stoneanchor";
        const { token } = onStoneAnchor ? { token: "" } : await asanaFor(p.company_id);
        if (!onStoneAnchor && !token) throw new Error("its company isn't connected to Asana");
        const fetchTasks = (sinceDay: string) =>
          onStoneAnchor ? fetchStoneAnchorTasks(sb, p.code, sinceDay) : fetchAsanaTasks(p.asana_project_gid, sinceDay, token!);
        if (mode === "backfill") {
          const days = Math.min(Math.max(Number(body.days) || 400, 1), 800);
          const firstDay = addDays(today, -days);
          const rows = computeDays(p.code, await fetchTasks(firstDay), firstDay, today, true, p.time_zone);
          const { error } = await sb.from("work_order_daily_stats")
            .upsert(rows, { onConflict: "property_code,stat_date", ignoreDuplicates: true });
          if (error) throw new Error(error.message);
          results[p.code] = `backfilled up to ${rows.length} days`;
        } else {
          // A facility with (almost) no saved history yet — usually one just
          // added — gets its past year rebuilt from Asana once, so its charts
          // aren't empty. Like "backfill", it never replaces a day already saved.
          const { count } = await sb.from("work_order_daily_stats")
            .select("stat_date", { count: "exact", head: true }).eq("property_code", p.code);
          if ((count ?? 0) < 30) {
            const yearStart = addDays(today, -400);
            const pastYear = computeDays(p.code, await fetchTasks(yearStart), yearStart, today, true, p.time_zone);
            const { error } = await sb.from("work_order_daily_stats")
              .upsert(pastYear, { onConflict: "property_code,stat_date", ignoreDuplicates: true });
            if (error) throw new Error(error.message);
          }
          const firstDay = addDays(today, -7);
          const rows = computeDays(p.code, await fetchTasks(firstDay), firstDay, today, false, p.time_zone);
          const yesterday = addDays(today, -1);
          const latest = rows.filter((r) => r.stat_date >= yesterday);
          // Older days in the past week: only fill gaps, never replace a day
          // that was already recorded at the time. Marked as estimates since
          // they're rebuilt after the fact.
          const gaps = rows.filter((r) => r.stat_date < yesterday).map((r) => ({ ...r, is_estimate: true }));
          const up = await sb.from("work_order_daily_stats").upsert(latest, { onConflict: "property_code,stat_date" });
          if (up.error) throw new Error(up.error.message);
          const fill = await sb.from("work_order_daily_stats")
            .upsert(gaps, { onConflict: "property_code,stat_date", ignoreDuplicates: true });
          if (fill.error) throw new Error(fill.error.message);
          results[p.code] = "ok";
        }
      } catch (err) {
        results[p.code] = "failed: " + (err as Error).message;
      }
    }));

    const anyFailed = Object.values(results).some((r) => r.startsWith("failed"));
    return jsonResponse({ ok: !anyFailed, mode, results }, anyFailed ? 500 : 200);
  } catch (err) {
    return jsonResponse({ error: (err as Error).message }, 500);
  }
});
