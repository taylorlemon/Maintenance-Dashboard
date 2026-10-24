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
// same secret the asana-proxy function already uses. SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY are provided automatically by the platform. This
// uses the service role key because no person is signed in, and it needs to
// write every facility's rows.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ASANA_TOKEN = Deno.env.get("ASANA_TOKEN");
const STATS_SECRET = Deno.env.get("STATS_SECRET");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

// Which time zone a "day" is counted in. Every facility today is in Utah. If
// a facility in another time zone is ever added, this should become a
// per-facility setting on the properties table instead.
const TIME_ZONE = "America/Denver";

const DAY_MS = 86400000;

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// "YYYY-MM-DD" for the calendar day an instant falls on, in TIME_ZONE.
const dayFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });
function localDay(iso: string | Date): string {
  return dayFormatter.format(typeof iso === "string" ? new Date(iso) : iso);
}

function dayToUtcMs(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function addDays(day: string, n: number): string {
  return new Date(dayToUtcMs(day) + n * DAY_MS).toISOString().slice(0, 10);
}

async function asanaGet(path: string) {
  // Asana limits how many requests can be made per minute; when we hit that
  // it answers 429 with how long to wait. Wait and try again rather than
  // failing the whole run. Also retry briefly on Asana's own server errors.
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch("https://app.asana.com/api/1.0" + path, {
      headers: { Authorization: "Bearer " + ASANA_TOKEN, Accept: "application/json" },
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
async function fetchTasks(projectGid: string, sinceDay: string): Promise<Task[]> {
  // Start a day early so time-zone differences can't drop a task completed
  // late on the first day; anything earlier is simply ignored below.
  const since = addDays(sinceDay, -1) + "T00:00:00.000Z";
  const fields = "created_at,completed_at,completed,due_on";
  const tasks: Task[] = [];
  let offset: string | null = null;
  while (true) {
    let path = `/tasks?project=${projectGid}&completed_since=${since}&opt_fields=${fields}&limit=100`;
    if (offset) path += "&offset=" + offset;
    const page = await asanaGet(path);
    tasks.push(...page.data);
    if (page.next_page) offset = page.next_page.offset;
    else break;
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
function computeDays(code: string, tasks: Task[], firstDay: string, today: string, isEstimate: boolean): DayRow[] {
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

Deno.serve(async (req) => {
  try {
    if (!STATS_SECRET) return jsonResponse({ error: "STATS_SECRET secret isn't set on this function yet." }, 500);
    if (req.headers.get("x-stats-secret") !== STATS_SECRET) return jsonResponse({ error: "Not authorized." }, 401);
    if (!ASANA_TOKEN) return jsonResponse({ error: "ASANA_TOKEN secret isn't set on this function yet." }, 500);

    let body: { mode?: string; days?: number; propertyCode?: string } = {};
    try { body = await req.json(); } catch (_) { /* empty body = defaults */ }
    const mode = body.mode === "backfill" ? "backfill" : "recent";

    const sb = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);
    let query = sb.from("properties").select("code, asana_project_gid").not("asana_project_gid", "is", null);
    if (body.propertyCode) query = query.eq("code", body.propertyCode);
    const { data: properties, error: propErr } = await query;
    if (propErr) return jsonResponse({ error: propErr.message }, 500);

    const today = localDay(new Date());
    const results: Record<string, string> = {};

    await Promise.all((properties ?? []).map(async (p) => {
      try {
        if (mode === "backfill") {
          const days = Math.min(Math.max(Number(body.days) || 400, 1), 800);
          const firstDay = addDays(today, -days);
          const rows = computeDays(p.code, await fetchTasks(p.asana_project_gid, firstDay), firstDay, today, true);
          const { error } = await sb.from("work_order_daily_stats")
            .upsert(rows, { onConflict: "property_code,stat_date", ignoreDuplicates: true });
          if (error) throw new Error(error.message);
          results[p.code] = `backfilled up to ${rows.length} days`;
        } else {
          const firstDay = addDays(today, -7);
          const rows = computeDays(p.code, await fetchTasks(p.asana_project_gid, firstDay), firstDay, today, false);
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
    return jsonResponse({ ok: !anyFailed, mode, today, results }, anyFailed ? 500 : 200);
  } catch (err) {
    return jsonResponse({ error: (err as Error).message }, 500);
  }
});
