// Copies one building's Asana history into StoneAnchor's own task lists.
//
// This runs on Supabase's servers, not in anyone's browser. It's started from
// Admin → Facilities → "Import from Asana" (openAsanaImport in js/admin.js), one building
// at a time, by the Executive. Asana itself is only read, never changed.
//
// What comes across, for the building's Work Orders, Preventative Maintenance
// and Room Turns projects and its Compliance section:
//   - every task, open and completed, with its original created and completed
//     times and who did them (to the minute, as Asana recorded them)
//   - the room, split out of the task name (see rooms.ts)
//   - the description, due date, section, and subtasks (as a checklist in the
//     description); "URGENT" in a name marks it urgent
//   - comments, as permanent notes with their original author and time
//   - repeating PM tasks: Asana doesn't share a task's repeat setting, so it's
//     worked out from the due dates of earlier rounds of the same task
// Photos and attachments stay in Asana; each imported task links back to it.
//
// It's safe to run again: tasks and notes already imported (matched by their
// Asana id) are skipped. A re-run also picks up new Asana tasks, and marks
// done any imported task that was since completed in Asana and is still open
// here — so Asana and StoneAnchor can run side by side until the switch.
//
// Actions (POST body { action, code, ... }):
//   preview  reads Asana and reports what an import would do; writes nothing
//   import   creates the lists and sections and copies the tasks
//   notes    copies comments for the next batch of imported tasks:
//            { after: n } -> { next, total, done }; the page calls it until done
//
// Deploy notes: deploy normally (signed-in callers only):
//   supabase functions deploy asana-import
// Uses the company's own Asana key (see _shared/companies.ts).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { companyAsanaLookup } from "../_shared/companies.ts";
import { splitRoom, FALLBACK_ROOM } from "./rooms.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
// Comments are one Asana request per task; this many per call keeps each
// call well inside the time limit and under Asana's rate limit.
const NOTES_BATCH = 40;

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}

// deno-lint-ignore no-explicit-any
type Json = any;

type Source = { kind: string; listName: string; firstSection: string; listGid: string; project?: string; section?: string };

// The four Asana places a building's tasks live, from its facility settings.
function sourcesFor(p: Json): Source[] {
  const out: Source[] = [];
  if (p.asana_project_gid) out.push({ kind: "work_orders", listName: "Work Orders", firstSection: "Work Order Requests", listGid: p.asana_project_gid, project: p.asana_project_gid });
  if (p.asana_pm_section_gid) out.push({ kind: "pm", listName: "Preventative Maintenance", firstSection: "PM Tasks", listGid: p.asana_pm_section_gid, project: p.asana_pm_section_gid });
  if (p.asana_rt_section_gid) out.push({ kind: "room_turns", listName: "Room Turns", firstSection: "Rooms to be Turned", listGid: p.asana_rt_section_gid, project: p.asana_rt_section_gid });
  // Compliance is one section of the company's shared compliance project.
  if (p.asana_compliance_section_gid) out.push({ kind: "compliance", listName: "Compliance Tracking", firstSection: "Compliance", listGid: "compliance:" + p.asana_compliance_section_gid, section: p.asana_compliance_section_gid });
  return out;
}

function asanaClient(token: string) {
  return async function get(path: string): Promise<Json> {
    for (let attempt = 0; attempt < 6; attempt++) {
      const res = await fetch("https://app.asana.com/api/1.0" + path, { headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
      if (res.status === 429) { // rate limited: wait as long as Asana asks
        await new Promise((r) => setTimeout(r, (Number(res.headers.get("retry-after")) || 10) * 1000));
        continue;
      }
      if (!res.ok) throw new Error(`Asana returned ${res.status} for ${path.split("?")[0]}`);
      return await res.json();
    }
    throw new Error("Asana kept asking us to slow down — try again in a few minutes.");
  };
}

const TASK_FIELDS = "name,notes,due_on,completed,completed_at,created_at,created_by.name,completed_by.name,num_subtasks," +
  "memberships.project.gid,memberships.section.gid,memberships.section.name";

async function allPages(get: (p: string) => Promise<Json>, path: string): Promise<Json[]> {
  const out: Json[] = [];
  let offset = "";
  while (true) {
    const page = await get(path + (path.includes("?") ? "&" : "?") + "limit=100" + (offset ? "&offset=" + offset : ""));
    out.push(...(page.data ?? []));
    if (page.next_page?.offset) offset = page.next_page.offset;
    else return out;
  }
}

async function readSource(get: (p: string) => Promise<Json>, s: Source) {
  const sections = s.project ? await allPages(get, `/projects/${s.project}/sections?opt_fields=name`) : [];
  const tasks = await allPages(get, (s.project ? `/tasks?project=${s.project}` : `/tasks?section=${s.section}`) + "&opt_fields=" + TASK_FIELDS);
  return { sections, tasks };
}

// ── Repeats ──────────────────────────────────────────────────────────────────
// Asana makes a new task for each round of a repeating task ("Door locks
// check" due Jun 1, Jun 8, Jun 15…). The usual gap between rounds gives the rule.

function dayMs(d: string) { const [y, m, dd] = d.split("-").map(Number); return Date.UTC(y, m - 1, dd); }

function ruleFromGap(gap: number, lastDue: string): Json | null {
  const dow = new Date(dayMs(lastDue)).getUTCDay() || 7;   // ISO weekday, 1 = Monday
  if (gap === 1) return { freq: "daily", interval: 1 };
  if (gap >= 6 && gap <= 8) return { freq: "weekly", interval: 1, days: [dow] };
  if (gap >= 13 && gap <= 15) return { freq: "weekly", interval: 2, days: [dow] };
  if (gap >= 27 && gap <= 32) return { freq: "monthly", interval: 1 };
  if (gap >= 85 && gap <= 95) return { freq: "monthly", interval: 3 };
  if (gap >= 175 && gap <= 190) return { freq: "monthly", interval: 6 };
  if (gap >= 355 && gap <= 375) return { freq: "yearly", interval: 1 };
  return null;
}

function repeatName(name: string) { return (name || "").replace(/\s+/g, " ").trim().toLowerCase(); }

// asana gid -> { rule, placedAt } for the newest open round of each repeating task.
function inferRepeats(tasks: Json[]) {
  const groups = new Map<string, Json[]>();
  for (const t of tasks) {
    if (!t.due_on) continue;
    const k = repeatName(t.name);
    if (!k) continue;
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  const out = new Map<string, { rule: Json; placedAt: string; label: string }>();
  for (const [, g] of groups) {
    if (g.length < 3) continue;   // two of the same could just be a duplicate
    g.sort((a, b) => a.due_on.localeCompare(b.due_on));
    const gaps = g.slice(1).map((t, i) => Math.round((dayMs(t.due_on) - dayMs(g[i].due_on)) / 86400000)).filter((x) => x > 0).sort((a, b) => a - b);
    if (!gaps.length) continue;
    const gap = gaps[Math.floor(gaps.length / 2)];
    const open = g.filter((t) => !t.completed);
    if (!open.length) continue;
    const latest = open[open.length - 1];
    const rule = ruleFromGap(gap, latest.due_on);
    if (!rule) continue;
    const firstCreated = g.map((t) => t.created_at).sort()[0];
    out.set(latest.gid, { rule, placedAt: firstCreated, label: `${latest.name.trim()}: every ${gap} day${gap === 1 ? "" : "s"}` });
  }
  return out;
}

// ── Turning an Asana task into a StoneAnchor row ─────────────────────────────

function asanaLink(gid: string) { return `https://app.asana.com/0/0/${gid}`; }

function taskRow(t: Json, code: string, listId: string, sectionId: string | null, repeat?: { rule: Json; placedAt: string }, subtasks?: Json[]) {
  const { room, title } = splitRoom(t.name);
  let details = (t.notes || "").trim();
  if (subtasks?.length) {
    details += (details ? "\n\n" : "") + "Subtasks (from Asana):\n" +
      subtasks.map((s) => (s.completed ? "☑ " : "☐ ") + (s.name || "").trim()).join("\n");
  }
  return {
    property_code: code, list_id: listId, section_id: sectionId,
    room, title, details,
    due_date: t.due_on || null,
    urgent: /\burgent\b/i.test(t.name || ""),
    recurrence: repeat?.rule ?? null,
    created_at: t.created_at,
    placed_at: repeat?.placedAt ?? t.created_at,
    created_by_name: t.created_by?.name ?? "Asana",
    completed_at: t.completed ? (t.completed_at ?? t.created_at) : null,
    completed_by_name: t.completed ? (t.completed_by?.name ?? "Asana") : null,
    asana_gid: t.gid,
  };
}

function sectionGidOf(t: Json, s: Source): string | null {
  const m = (t.memberships ?? []).find((m: Json) => s.project ? m.project?.gid === s.project : m.section?.gid === s.section);
  return m?.section?.gid ?? null;
}

// ── Lists and sections ───────────────────────────────────────────────────────

// Finds or makes the StoneAnchor list for one Asana source, and its sections.
// A list made earlier with "Set up the standard lists" is reused (and linked).
async function ensureList(db: Json, code: string, s: Source, asanaSections: Json[]) {
  let { data: list } = await db.from("task_lists").select("*").eq("asana_gid", s.listGid).maybeSingle();
  if (!list) {
    const { data: same } = await db.from("task_lists").select("*").eq("property_code", code).eq("kind", s.kind).eq("archived", false).is("asana_gid", null);
    if (same?.length === 1) {
      const upd = await db.from("task_lists").update({ asana_gid: s.listGid }).eq("id", same[0].id).select().single();
      if (upd.error) throw new Error(upd.error.message);
      list = upd.data;
    } else {
      const ins = await db.from("task_lists").insert({ property_code: code, name: s.listName, kind: s.kind, asana_gid: s.listGid,
        sort_order: { work_orders: 0, pm: 1, room_turns: 2, compliance: 3 }[s.kind] ?? 9 }).select().single();
      if (ins.error) throw new Error(ins.error.message);
      list = ins.data;
    }
  }

  const { data: existing } = await db.from("task_sections").select("*").eq("list_id", list.id).order("sort_order");
  const sections: Json[] = existing ?? [];
  const map = new Map<string, string>();   // asana section gid -> our section id
  // Compliance has no Asana sections of its own: one section for the lot.
  const wanted = asanaSections.length ? asanaSections : [{ gid: s.listGid, name: s.firstSection }];
  for (let i = 0; i < wanted.length; i++) {
    const a = wanted[i];
    const name = /^untitled section$/i.test(a.name || "") || !a.name ? (i === 0 ? s.firstSection : "Other") : a.name;
    let mine = sections.find((x) => x.asana_gid === a.gid)
      ?? sections.find((x) => !x.asana_gid && !x.archived && x.name.toLowerCase() === name.toLowerCase())
      ?? (i === 0 && /^untitled section$/i.test(a.name || "") ? sections.find((x) => !x.asana_gid && !x.archived) : undefined);
    if (mine && !mine.asana_gid) {
      const upd = await db.from("task_sections").update({ asana_gid: a.gid }).eq("id", mine.id).select().single();
      if (upd.error) throw new Error(upd.error.message);
      mine = upd.data;
    }
    if (!mine) {
      const ins = await db.from("task_sections").insert({ list_id: list.id, name, sort_order: sections.length, asana_gid: a.gid }).select().single();
      if (ins.error) throw new Error(ins.error.message);
      mine = ins.data;
      sections.push(mine);
    }
    map.set(a.gid, mine.id);
  }
  return { list, sectionFor: (gid: string | null) => (gid && map.get(gid)) || null };
}

// ── The three actions ────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  try {
    const caller = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: userData, error: userErr } = await caller.auth.getUser();
    if (userErr || !userData.user) return jsonResponse({ error: "Not signed in." }, 401);
    const { data: profile } = await caller.from("profiles").select("is_executive").eq("id", userData.user.id).single();
    // Executive-only while the new task lists are being rolled out.
    if (!profile?.is_executive) return jsonResponse({ error: "Only the Executive can import from Asana." }, 403);

    const body = await req.json().catch(() => ({}));
    const code = typeof body.code === "string" ? body.code : "";
    const db = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);
    const { data: prop } = await db.from("properties")
      .select("code, name, company_id, asana_project_gid, asana_pm_section_gid, asana_rt_section_gid, asana_compliance_section_gid")
      .eq("code", code).maybeSingle();
    if (!prop) return jsonResponse({ error: "No such building." }, 404);

    const { token } = await companyAsanaLookup(db)(prop.company_id);
    if (!token) return jsonResponse({ error: "This building's company isn't connected to Asana." }, 400);
    const get = asanaClient(token);
    const sources = sourcesFor(prop);
    if (!sources.length) return jsonResponse({ error: "This building has no Asana projects set up." }, 400);

    if (body.action === "notes") return await importNotes(db, get, code, Number(body.after) || 0);
    if (body.action !== "preview" && body.action !== "import") return jsonResponse({ error: "Unknown action." }, 400);

    const { data: alreadyRows } = await db.from("tasks").select("asana_gid, completed_at").eq("property_code", code).not("asana_gid", "is", null).limit(100000);
    const already = new Map<string, Json>((alreadyRows ?? []).map((r: Json) => [r.asana_gid, r]));

    const report: Json[] = [];
    const samples: Json[] = [];
    const repeatsFound: string[] = [];
    let general = 0;

    for (const s of sources) {
      const { sections, tasks } = await readSource(get, s);
      const repeats = inferRepeats(tasks);
      repeats.forEach((r) => repeatsFound.push(r.label));
      const fresh = tasks.filter((t) => !already.has(t.gid));
      const nowDone = tasks.filter((t) => t.completed && already.has(t.gid) && !already.get(t.gid).completed_at);
      fresh.forEach((t) => { if (splitRoom(t.name).room === FALLBACK_ROOM) general++; });
      if (samples.length < 60) {
        fresh.slice(0, 60 - samples.length).forEach((t) => { const r = splitRoom(t.name); samples.push({ list: s.listName, asana: t.name, room: r.room, title: r.title }); });
      }
      const line: Json = {
        list: s.listName, inAsana: tasks.length, open: tasks.filter((t) => !t.completed).length,
        alreadyImported: tasks.length - fresh.length, toImport: fresh.length, toMarkDone: nowDone.length,
        sections: sections.map((x: Json) => x.name),
      };
      report.push(line);
      if (body.action === "preview") continue;

      // ── import ──
      const { list, sectionFor } = await ensureList(db, code, s, sections);
      const rows: Json[] = [];
      for (const t of fresh) {
        const subs = t.num_subtasks > 0 ? (await get(`/tasks/${t.gid}/subtasks?opt_fields=name,completed`)).data : undefined;
        rows.push(taskRow(t, code, list.id, sectionFor(sectionGidOf(t, s)), repeats.get(t.gid), subs));
      }
      // Oldest first, so history reads in order.
      rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
      for (let i = 0; i < rows.length; i += 200) {
        const ins = await db.from("tasks").upsert(rows.slice(i, i + 200), { onConflict: "asana_gid", ignoreDuplicates: true });
        if (ins.error) throw new Error(`Saving ${s.listName} tasks: ${ins.error.message}`);
      }
      for (const t of nowDone) {
        const upd = await db.from("tasks").update({ completed_at: t.completed_at, completed_by_name: t.completed_by?.name ?? "Asana" })
          .eq("asana_gid", t.gid).eq("property_code", code).is("completed_at", null);
        if (upd.error) throw new Error(`Marking ${s.listName} tasks done: ${upd.error.message}`);
      }
      line.imported = rows.length;
    }

    return jsonResponse({ ok: true, building: prop.name, lists: report, samples, generalRoomCount: general, repeats: repeatsFound }, 200);
  } catch (err) {
    return jsonResponse({ error: (err as Error).message }, 500);
  }
});

// Comments → permanent notes, for the next NOTES_BATCH imported tasks.
async function importNotes(db: Json, get: (p: string) => Promise<Json>, code: string, after: number) {
  const { count } = await db.from("tasks").select("id", { count: "exact", head: true }).eq("property_code", code).not("asana_gid", "is", null);
  const { data: batch, error } = await db.from("tasks").select("id, asana_gid").eq("property_code", code).not("asana_gid", "is", null)
    .order("created_at").order("id").range(after, after + NOTES_BATCH - 1);
  if (error) return jsonResponse({ error: error.message }, 500);
  let added = 0;
  for (const t of batch ?? []) {
    const stories = await allPages(get, `/tasks/${t.asana_gid}/stories?opt_fields=resource_subtype,text,created_at,created_by.name`);
    const notes = stories.filter((st: Json) => st.resource_subtype === "comment_added" && (st.text || "").trim())
      .map((st: Json) => ({ task_id: t.id, body: st.text.trim(), author_name: st.created_by?.name ?? "Asana", created_at: st.created_at, asana_gid: st.gid }));
    if (notes.length) {
      const ins = await db.from("task_notes").upsert(notes, { onConflict: "asana_gid", ignoreDuplicates: true }).select("id");
      if (ins.error) return jsonResponse({ error: ins.error.message }, 500);
      added += ins.data?.length ?? 0;
    }
  }
  const next = after + (batch?.length ?? 0);
  return jsonResponse({ ok: true, next, total: count ?? 0, done: next >= (count ?? 0), added }, 200);
}
