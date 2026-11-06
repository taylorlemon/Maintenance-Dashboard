-- ── StoneAnchor Tasks: work orders, PM and room turns without Asana ─────────
-- Run after supabase/multi-company/04-pause-and-remove.sql. Safe to re-run.
--
-- The record has to stand up to a state inspection and back up rent increases,
-- so three rules are enforced here in the database, not just on the page:
--   1. Nothing is ever deleted — tasks, notes, photos, history. A task logged by
--      mistake is Cancelled with a reason and stays on record.
--   2. Created / completed / cancelled / note times come from the database
--      clock (to the minute and beyond) and can't be changed afterwards.
--   3. Every change to a task is written to task_events automatically.
-- The only thing that can remove these rows is the Executive's "remove a
-- company" clean-up (remove_company_rows, redefined at the bottom of this file).
--
-- People are recorded by id AND by email at the time, so the record still reads
-- correctly after someone's login is removed (and for Asana imports, where the
-- person may never have had a login).

-- ── Tables ───────────────────────────────────────────────────────────────────

-- A list is what Asana calls a project ("CP Work Orders").
create table if not exists task_lists (
  id uuid primary key default gen_random_uuid(),
  property_code text not null references properties(code),
  name text not null check (btrim(name) <> ''),
  kind text not null default 'other' check (kind in ('work_orders', 'pm', 'room_turns', 'compliance', 'other')),
  sort_order int not null default 0,
  archived boolean not null default false,
  asana_gid text unique,
  created_at timestamptz not null default now()
);
create index if not exists task_lists_property_idx on task_lists (property_code);

create table if not exists task_sections (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references task_lists(id),
  name text not null check (btrim(name) <> ''),
  sort_order int not null default 0,
  archived boolean not null default false,
  asana_gid text unique,
  created_at timestamptz not null default now()
);
create index if not exists task_sections_list_idx on task_sections (list_id);

create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  property_code text not null references properties(code),
  list_id uuid not null references task_lists(id),
  section_id uuid references task_sections(id),
  room text not null check (btrim(room) <> ''),
  title text not null default '',
  details text not null default '',
  due_date date,
  urgent boolean not null default false,
  -- {"freq": "daily"|"weekly"|"monthly"|"yearly", "interval": 1, "days": [1..7]}
  -- (days = ISO weekdays, 1 = Monday, weekly only)
  recurrence jsonb,
  project_id uuid references projects(id),
  created_at timestamptz not null default now(),
  created_by uuid,
  created_by_name text,
  completed_at timestamptz,
  completed_by uuid,
  completed_by_name text,
  cancelled_at timestamptz,
  cancelled_by uuid,
  cancelled_by_name text,
  cancel_reason text,
  previous_task_id uuid references tasks(id),   -- the repeat this one came from
  next_task_id uuid references tasks(id),       -- the repeat this one made
  asana_gid text unique
);
create index if not exists tasks_list_open_idx on tasks (list_id) where completed_at is null and cancelled_at is null;
create index if not exists tasks_room_idx on tasks (property_code, lower(room));
create index if not exists tasks_property_created_idx on tasks (property_code, created_at desc);

create table if not exists task_notes (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id),
  body text not null check (btrim(body) <> ''),
  author_id uuid,
  author_name text,
  created_at timestamptz not null default now(),
  asana_gid text unique
);
create index if not exists task_notes_task_idx on task_notes (task_id, created_at);

create table if not exists task_photos (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id),
  storage_path text not null unique,
  file_name text not null,
  uploaded_by uuid,
  uploaded_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists task_photos_task_idx on task_photos (task_id);

-- Written only by the triggers below; nobody adds to it by hand.
create table if not exists task_events (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id),
  property_code text not null,
  event_type text not null,   -- created, completed, reopened, cancelled, restored, moved, edited
  detail text,
  actor_id uuid,
  actor_name text,
  created_at timestamptz not null default now()
);
create index if not exists task_events_task_idx on task_events (task_id, created_at);

alter table task_lists enable row level security;
alter table task_sections enable row level security;
alter table tasks enable row level security;
alter table task_notes enable row level security;
alter table task_photos enable row level security;
alter table task_events enable row level security;

-- ── Staff role ───────────────────────────────────────────────────────────────
-- Techs and front desk. They get their own simple screen with just Work Orders,
-- PM and Room Turns, and the database keeps them out of everything else
-- (CapEx, budgets, expenses, vendors, work-order stats) — the screen hiding it
-- isn't enough, since the code is public. Viewers stay read-only: they can look
-- at tasks but not add, check off or note.
--
--             sees dashboards   works tasks          sets up lists
--   Admin     yes               yes                  yes
--   Editor    yes (buildings)   yes                  yes
--   Viewer    yes (buildings)   look only            no
--   Staff     no                yes (WO, PM, RT)     no

alter table profiles drop constraint if exists profiles_role_check;
alter table profiles add constraint profiles_role_check check (role in ('admin', 'editor', 'viewer', 'staff'));

create or replace function is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'staff' from profiles where id = auth.uid()), false);
$$;

-- Replaces the version in multi-company/01-companies-and-walls.sql: the same,
-- except Staff never count as "seeing" a building's dashboards.
create or replace function can_see_property(p_code text) returns boolean
language sql stable security definer set search_path = public as $$
  select is_executive() or (in_my_company(property_company(p_code))
    and (is_admin() or (not is_staff() and p_code in (select my_property_codes()))));
$$;

-- Same idea for vendors, which check building access their own way.
create or replace function can_see_vendor(v_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select is_executive() or (in_my_company(vendor_company(v_id)) and (is_admin()
    or (not is_staff() and exists (select 1 from vendor_properties vp where vp.vendor_id = v_id and vp.property_code in (select my_property_codes())))));
$$;

-- Who can log, move, note, photograph, complete and cancel a building's tasks.
create or replace function can_work_tasks(p_code text) returns boolean
language sql stable security definer set search_path = public as $$
  select is_executive() or (in_my_company(property_company(p_code))
    and (is_admin() or ((is_editor() or is_staff()) and p_code in (select my_property_codes()))));
$$;

-- Staff still need their own buildings' names and time zones for their screen.
drop policy if exists "properties readable by scope" on properties;
create policy "properties readable by scope" on properties
  for select using (can_see_property(code) or can_work_tasks(code));

-- ── Helpers ──────────────────────────────────────────────────────────────────

-- The kinds of list on the Staff screen.
create or replace function staff_list_kinds() returns text[]
language sql immutable as $$
  select array['work_orders', 'pm', 'room_turns'];
$$;

-- Can I see this list (and its sections, tasks, notes, photos, history)?
create or replace function can_read_list(l_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from task_lists l where l.id = l_id
    and (can_see_property(l.property_code)
         or (can_work_tasks(l.property_code) and l.kind = any(staff_list_kinds()))));
$$;

-- Can I work this list's tasks?
create or replace function can_work_list(l_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from task_lists l where l.id = l_id
    and can_work_tasks(l.property_code)
    and (not is_staff() or l.kind = any(staff_list_kinds())));
$$;

create or replace function task_list(t_id uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select list_id from tasks where id = t_id;
$$;

create or replace function folder_task_list(folder text) returns uuid
language sql stable security definer set search_path = public as $$
  select list_id from tasks where id::text = folder;
$$;

create or replace function my_display_name() returns text
language sql stable security definer set search_path = public as $$
  select email from profiles where id = auth.uid();
$$;

create or replace function list_property(l_id uuid) returns text
language sql stable security definer set search_path = public as $$
  select property_code from task_lists where id = l_id;
$$;

create or replace function section_list(s_id uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select list_id from task_sections where id = s_id;
$$;

create or replace function task_property(t_id uuid) returns text
language sql stable security definer set search_path = public as $$
  select property_code from tasks where id = t_id;
$$;

-- Photo paths start with the task's id ("<task id>/<file>").
create or replace function folder_task_property(folder text) returns text
language sql stable security definer set search_path = public as $$
  select property_code from tasks where id::text = folder;
$$;

-- When a repeating task is done, the next one is due on...
create or replace function task_next_due(base date, rule jsonb) returns date
language plpgsql immutable as $$
declare
  freq text := rule->>'freq';
  n int := greatest(coalesce((rule->>'interval')::int, 1), 1);
  days int[];
  monday date;
  i int;
begin
  if base is null or freq is null then return null; end if;
  if freq = 'daily' then return base + n; end if;
  if freq = 'monthly' then return (base + make_interval(months => n))::date; end if;
  if freq = 'yearly' then return (base + make_interval(years => n))::date; end if;
  if freq = 'weekly' then
    select coalesce(array_agg(x::int), '{}') into days
      from jsonb_array_elements_text(coalesce(rule->'days', '[]'::jsonb)) x;
    if cardinality(days) = 0 then return base + 7 * n; end if;
    -- A later chosen day in the same week...
    for i in 1..(7 - extract(isodow from base)::int) loop
      if extract(isodow from base + i)::int = any(days) then return base + i; end if;
    end loop;
    -- ...otherwise the first chosen day, n weeks on.
    monday := base - (extract(isodow from base)::int - 1) + 7 * n;
    for i in 0..6 loop
      if extract(isodow from monday + i)::int = any(days) then return monday + i; end if;
    end loop;
  end if;
  return null;
end;
$$;

-- ── Guards ───────────────────────────────────────────────────────────────────
-- Like guard_profile_changes: current_user tells us who's asking.
-- 'authenticated'/'anon' = the site, 'service_role' = our server functions (the
-- Asana import may set original Asana times), anything else = the database
-- itself or someone in the SQL Editor (remove_company_rows runs that way).

create or replace function guard_task_changes() returns trigger
language plpgsql set search_path = public as $$
declare
  from_site boolean := current_user in ('authenticated', 'anon');
  from_app boolean := current_user in ('authenticated', 'anon', 'service_role');
begin
  if tg_op = 'DELETE' then
    if from_app then raise exception 'Tasks can''t be deleted. Cancel it instead, with a reason.'; end if;
    return old;
  end if;

  new.room := btrim(new.room);
  new.title := btrim(coalesce(new.title, ''));

  if tg_op = 'INSERT' then
    if from_site then
      new.created_at := now();
      new.created_by := auth.uid();
      new.created_by_name := my_display_name();
      new.completed_at := null; new.completed_by := null; new.completed_by_name := null;
      new.cancelled_at := null; new.cancelled_by := null; new.cancelled_by_name := null; new.cancel_reason := null;
      new.previous_task_id := null; new.next_task_id := null; new.asana_gid := null;
    end if;
    if new.section_id is null then
      select id into new.section_id from task_sections
        where list_id = new.list_id and not archived order by sort_order, created_at limit 1;
    end if;
    return new;
  end if;

  -- UPDATE
  if from_app then
    if new.id <> old.id or new.property_code <> old.property_code
       or new.created_at is distinct from old.created_at
       or new.created_by is distinct from old.created_by
       or new.created_by_name is distinct from old.created_by_name
       or new.previous_task_id is distinct from old.previous_task_id
       or new.asana_gid is distinct from old.asana_gid then
      raise exception 'That part of a task''s record can''t be changed.';
    end if;
    if from_site then new.next_task_id := old.next_task_id; end if;

    -- Completing stamps the time now; reopening clears it (the original stays
    -- in task_events); anything else keeps the original.
    if new.completed_at is not null and old.completed_at is null then
      if from_site then
        new.completed_at := now(); new.completed_by := auth.uid(); new.completed_by_name := my_display_name();
      end if;
    elsif new.completed_at is null and old.completed_at is not null then
      new.completed_by := null; new.completed_by_name := null;
    else
      new.completed_at := old.completed_at; new.completed_by := old.completed_by; new.completed_by_name := old.completed_by_name;
    end if;

    if new.cancelled_at is not null and old.cancelled_at is null then
      if coalesce(btrim(new.cancel_reason), '') = '' then
        raise exception 'Say why the task is being cancelled.';
      end if;
      if from_site then
        new.cancelled_at := now(); new.cancelled_by := auth.uid(); new.cancelled_by_name := my_display_name();
      end if;
    elsif new.cancelled_at is null and old.cancelled_at is not null then
      new.cancelled_by := null; new.cancelled_by_name := null; new.cancel_reason := null;
    else
      new.cancelled_at := old.cancelled_at; new.cancelled_by := old.cancelled_by;
      new.cancelled_by_name := old.cancelled_by_name; new.cancel_reason := old.cancel_reason;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists guard_task_changes on tasks;
create trigger guard_task_changes
  before insert or update or delete on tasks
  for each row execute function guard_task_changes();

-- Notes, photos and history are add-only: no changing, no removing.
create or replace function guard_task_record_rows() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user in ('authenticated', 'anon', 'service_role') then
    if tg_op in ('UPDATE', 'DELETE') then
      raise exception 'This is part of the permanent record and can''t be changed or removed.';
    end if;
    if current_user <> 'service_role' and tg_table_name = 'task_notes' then
      new.created_at := now(); new.author_id := auth.uid(); new.author_name := my_display_name(); new.asana_gid := null;
    elsif current_user <> 'service_role' and tg_table_name = 'task_photos' then
      new.created_at := now(); new.uploaded_by := auth.uid(); new.uploaded_by_name := my_display_name();
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists guard_task_notes on task_notes;
create trigger guard_task_notes before insert or update or delete on task_notes
  for each row execute function guard_task_record_rows();
drop trigger if exists guard_task_photos on task_photos;
create trigger guard_task_photos before insert or update or delete on task_photos
  for each row execute function guard_task_record_rows();
drop trigger if exists guard_task_events on task_events;
create trigger guard_task_events before update or delete on task_events
  for each row execute function guard_task_record_rows();

-- Lists and sections are archived, never deleted.
create or replace function guard_task_list_delete() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user in ('authenticated', 'anon', 'service_role') then
    raise exception 'Lists and sections can''t be deleted. Archive them instead.';
  end if;
  return old;
end;
$$;

drop trigger if exists guard_task_lists_delete on task_lists;
create trigger guard_task_lists_delete before delete on task_lists
  for each row execute function guard_task_list_delete();
drop trigger if exists guard_task_sections_delete on task_sections;
create trigger guard_task_sections_delete before delete on task_sections
  for each row execute function guard_task_list_delete();

-- ── History and repeats ──────────────────────────────────────────────────────
-- security definer so it can write task_events, which nobody else can.

create or replace function after_task_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  who uuid := auth.uid();
  who_name text := coalesce(my_display_name(), case when current_user = 'service_role' then 'Asana import' else 'StoneAnchor' end);
  next_id uuid;
  base date;
  tz text;
  old_section text;
  new_section text;
begin
  if tg_op = 'INSERT' then
    insert into task_events (task_id, property_code, event_type, detail, actor_id, actor_name, created_at)
      values (new.id, new.property_code, 'created',
              case when new.previous_task_id is not null then 'Repeat of an earlier task' end,
              new.created_by, coalesce(new.created_by_name, who_name), new.created_at);
    if new.completed_at is not null then
      insert into task_events (task_id, property_code, event_type, actor_id, actor_name, created_at)
        values (new.id, new.property_code, 'completed', new.completed_by, new.completed_by_name, new.completed_at);
    end if;
    if new.cancelled_at is not null then
      insert into task_events (task_id, property_code, event_type, detail, actor_id, actor_name, created_at)
        values (new.id, new.property_code, 'cancelled', new.cancel_reason, new.cancelled_by, new.cancelled_by_name, new.cancelled_at);
    end if;
    return null;
  end if;

  -- What changed, in plain words.
  if new.completed_at is distinct from old.completed_at then
    if new.completed_at is not null then
      insert into task_events (task_id, property_code, event_type, actor_id, actor_name, created_at)
        values (new.id, new.property_code, 'completed', new.completed_by, new.completed_by_name, new.completed_at);
    else
      insert into task_events (task_id, property_code, event_type, actor_id, actor_name)
        values (new.id, new.property_code, 'reopened', who, who_name);
    end if;
  end if;
  if new.cancelled_at is distinct from old.cancelled_at then
    if new.cancelled_at is not null then
      insert into task_events (task_id, property_code, event_type, detail, actor_id, actor_name, created_at)
        values (new.id, new.property_code, 'cancelled', new.cancel_reason, new.cancelled_by, coalesce(new.cancelled_by_name, who_name), new.cancelled_at);
    else
      insert into task_events (task_id, property_code, event_type, actor_id, actor_name)
        values (new.id, new.property_code, 'restored', who, who_name);
    end if;
  end if;
  if new.section_id is distinct from old.section_id then
    select name into old_section from task_sections where id = old.section_id;
    select name into new_section from task_sections where id = new.section_id;
    insert into task_events (task_id, property_code, event_type, detail, actor_id, actor_name)
      values (new.id, new.property_code, 'moved',
              coalesce(old_section, '(none)') || ' → ' || coalesce(new_section, '(none)'), who, who_name);
  end if;
  if new.list_id is distinct from old.list_id then
    insert into task_events (task_id, property_code, event_type, detail, actor_id, actor_name)
      values (new.id, new.property_code, 'moved',
              'List: ' || coalesce((select name from task_lists where id = old.list_id), '?')
              || ' → ' || coalesce((select name from task_lists where id = new.list_id), '?'), who, who_name);
  end if;
  if new.room is distinct from old.room then
    insert into task_events (task_id, property_code, event_type, detail, actor_id, actor_name)
      values (new.id, new.property_code, 'edited', 'Room / location: ' || old.room || ' → ' || new.room, who, who_name);
  end if;
  if new.title is distinct from old.title then
    insert into task_events (task_id, property_code, event_type, detail, actor_id, actor_name)
      values (new.id, new.property_code, 'edited', 'Work order: "' || old.title || '" → "' || new.title || '"', who, who_name);
  end if;
  if new.details is distinct from old.details then
    insert into task_events (task_id, property_code, event_type, detail, actor_id, actor_name)
      values (new.id, new.property_code, 'edited', 'Description was: "' || old.details || '"', who, who_name);
  end if;
  if new.due_date is distinct from old.due_date then
    insert into task_events (task_id, property_code, event_type, detail, actor_id, actor_name)
      values (new.id, new.property_code, 'edited',
              'Due date: ' || coalesce(old.due_date::text, 'none') || ' → ' || coalesce(new.due_date::text, 'none'), who, who_name);
  end if;
  if new.urgent is distinct from old.urgent then
    insert into task_events (task_id, property_code, event_type, detail, actor_id, actor_name)
      values (new.id, new.property_code, 'edited', case when new.urgent then 'Marked urgent' else 'No longer urgent' end, who, who_name);
  end if;
  if new.recurrence is distinct from old.recurrence then
    insert into task_events (task_id, property_code, event_type, detail, actor_id, actor_name)
      values (new.id, new.property_code, 'edited',
              case when new.recurrence is null then 'Stopped repeating' else 'Repeat changed' end, who, who_name);
  end if;

  -- A repeating task was just checked off: make the next one (unless it
  -- already made one that's still live — e.g. checked, undone, checked again).
  if old.completed_at is null and new.completed_at is not null
     and new.recurrence is not null and new.cancelled_at is null
     and (new.next_task_id is null
          or exists (select 1 from tasks where id = new.next_task_id and cancelled_at is not null)) then
    select time_zone into tz from properties where code = new.property_code;
    base := coalesce(new.due_date, (new.completed_at at time zone coalesce(tz, 'America/Denver'))::date);
    insert into tasks (property_code, list_id, section_id, room, title, details, due_date, urgent,
                       recurrence, project_id, created_by, created_by_name, previous_task_id)
      values (new.property_code, new.list_id, new.section_id, new.room, new.title, new.details,
              task_next_due(base, new.recurrence), new.urgent, new.recurrence, new.project_id,
              who, who_name, new.id)
      returning id into next_id;
    update tasks set next_task_id = next_id where id = new.id;
  end if;

  -- Reopened (e.g. Undo after a mis-tap): the repeat it made is cancelled, not
  -- deleted, as long as nobody has started on it yet.
  if old.completed_at is not null and new.completed_at is null and new.next_task_id is not null then
    update tasks set cancelled_at = now(), cancelled_by_name = 'StoneAnchor',
                     cancel_reason = 'The task before it was reopened'
      where id = new.next_task_id and completed_at is null and cancelled_at is null
        and not exists (select 1 from task_notes where task_id = new.next_task_id)
        and not exists (select 1 from task_photos where task_id = new.next_task_id);
  end if;

  return null;
end;
$$;

drop trigger if exists after_task_change on tasks;
create trigger after_task_change
  after insert or update on tasks
  for each row execute function after_task_change();

-- Notes and photos show up in the task's history too.
create or replace function after_task_record_added() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'task_photos' then
    insert into task_events (task_id, property_code, event_type, detail, actor_id, actor_name, created_at)
      values (new.task_id, task_property(new.task_id), 'photo', new.file_name, new.uploaded_by, new.uploaded_by_name, new.created_at);
  end if;
  return null;
end;
$$;

drop trigger if exists after_task_photo_added on task_photos;
create trigger after_task_photo_added after insert on task_photos
  for each row execute function after_task_record_added();

-- ── Access rules ─────────────────────────────────────────────────────────────
-- Reading: can_read_list. Working tasks: can_work_list (Staff, Editors, Admins;
-- not Viewers). Setting up lists and sections: Editors and up. There are no
-- delete rules on purpose.

drop policy if exists "task_lists readable by scope" on task_lists;
create policy "task_lists readable by scope" on task_lists
  for select using (can_read_list(id));
drop policy if exists "task_lists insertable by editors" on task_lists;
create policy "task_lists insertable by editors" on task_lists
  for insert with check (can_edit_property(property_code));
drop policy if exists "task_lists updatable by editors" on task_lists;
create policy "task_lists updatable by editors" on task_lists
  for update using (can_edit_property(property_code)) with check (can_edit_property(property_code));

drop policy if exists "task_sections readable by scope" on task_sections;
create policy "task_sections readable by scope" on task_sections
  for select using (can_read_list(list_id));
drop policy if exists "task_sections insertable by editors" on task_sections;
create policy "task_sections insertable by editors" on task_sections
  for insert with check (can_edit_property(list_property(list_id)));
drop policy if exists "task_sections updatable by editors" on task_sections;
create policy "task_sections updatable by editors" on task_sections
  for update using (can_edit_property(list_property(list_id)))
  with check (can_edit_property(list_property(list_id)));

-- A task's list, section and CapEx project must all be in the task's building.
drop policy if exists "tasks readable by scope" on tasks;
create policy "tasks readable by scope" on tasks
  for select using (can_read_list(list_id));
drop policy if exists "tasks insertable by scope" on tasks;
create policy "tasks insertable by scope" on tasks
  for insert with check (can_work_list(list_id)
    and list_property(list_id) = property_code
    and (section_id is null or section_list(section_id) = list_id)
    and (project_id is null or project_property(project_id) = property_code));
drop policy if exists "tasks updatable by scope" on tasks;
create policy "tasks updatable by scope" on tasks
  for update using (can_work_list(list_id)) with check (can_work_list(list_id)
    and list_property(list_id) = property_code
    and (section_id is null or section_list(section_id) = list_id)
    and (project_id is null or project_property(project_id) = property_code));

drop policy if exists "task_notes readable by scope" on task_notes;
create policy "task_notes readable by scope" on task_notes
  for select using (can_read_list(task_list(task_id)));
drop policy if exists "task_notes insertable by scope" on task_notes;
create policy "task_notes insertable by scope" on task_notes
  for insert with check (can_work_list(task_list(task_id)));

drop policy if exists "task_photos readable by scope" on task_photos;
create policy "task_photos readable by scope" on task_photos
  for select using (can_read_list(task_list(task_id)));
drop policy if exists "task_photos insertable by scope" on task_photos;
create policy "task_photos insertable by scope" on task_photos
  for insert with check (can_work_list(task_list(task_id))
    and (storage.foldername(storage_path))[1] = task_id::text);

drop policy if exists "task_events readable by scope" on task_events;
create policy "task_events readable by scope" on task_events
  for select using (can_read_list(task_list(task_id)));

-- Photos: a private bucket, files under their task's id. No delete rule.
insert into storage.buckets (id, name, public)
  values ('task-files', 'task-files', false)
  on conflict (id) do nothing;

drop policy if exists "task-files readable by scope" on storage.objects;
create policy "task-files readable by scope" on storage.objects
  for select using (bucket_id = 'task-files' and can_read_list(folder_task_list((storage.foldername(name))[1])));
drop policy if exists "task-files insertable by scope" on storage.objects;
create policy "task-files insertable by scope" on storage.objects
  for insert with check (bucket_id = 'task-files' and can_work_list(folder_task_list((storage.foldername(name))[1])));

-- ── Look-ups for the page ────────────────────────────────────────────────────
-- Not security definer: the rules above still decide what each person sees.

-- Rooms already used in a building, for the Room box's suggestions.
create or replace function task_rooms(p_code text) returns table (room text, uses bigint)
language sql stable set search_path = public as $$
  select min(t.room), count(*) from tasks t
   where t.property_code = p_code
   group by lower(t.room)
   order by count(*) desc;
$$;

-- Search every task (open, done and cancelled) by room, work order,
-- description or note text.
create or replace function search_tasks(p_codes text[], q text) returns setof tasks
language sql stable set search_path = public as $$
  with pattern as (
    select '%' || replace(replace(replace(btrim(q), '\', '\\'), '%', '\%'), '_', '\_') || '%' as p
  )
  select t.* from tasks t, pattern
   where t.property_code = any(p_codes)
     and btrim(q) <> ''
     and (t.room ilike pattern.p or t.title ilike pattern.p or t.details ilike pattern.p
          or exists (select 1 from task_notes n where n.task_id = t.id and n.body ilike pattern.p))
   order by t.created_at desc
   limit 300;
$$;

revoke all on function task_rooms(text) from public, anon;
grant execute on function task_rooms(text) to authenticated;
revoke all on function search_tasks(text[], text) from public, anon;
grant execute on function search_tasks(text[], text) to authenticated;
revoke all on function task_next_due(date, jsonb) from public, anon;
grant execute on function task_next_due(date, jsonb) to authenticated;

-- ── Removing a company also removes its tasks ────────────────────────────────
-- Replaces the version in multi-company/04-pause-and-remove.sql (same checks,
-- plus the task tables, children first). It runs as the database owner, so the
-- "can't delete" guards above let it through; nothing on the site can.
create or replace function remove_company_rows(c uuid) returns void
language plpgsql security definer set search_path = public, vault as $$
declare
  codes text[];
  secret_name text;
begin
  if not exists (select 1 from companies where id = c and paused_at is not null) then
    raise exception 'A company has to be paused before it can be removed.';
  end if;
  if company_has_executive(c) then raise exception 'A company an Executive belongs to can''t be removed.'; end if;

  select coalesce(array_agg(code), '{}') into codes from properties where company_id = c;
  delete from task_events where property_code = any(codes);
  delete from task_photos where task_id in (select id from tasks where property_code = any(codes));
  delete from task_notes where task_id in (select id from tasks where property_code = any(codes));
  update tasks set next_task_id = null, previous_task_id = null where property_code = any(codes);
  delete from tasks where property_code = any(codes);
  delete from task_sections where list_id in (select id from task_lists where property_code = any(codes));
  delete from task_lists where property_code = any(codes);
  delete from project_log where project_id in (select id from projects where property_code = any(codes));
  delete from expenses where property_code = any(codes);
  delete from todos where property_code = any(codes);
  delete from projects where property_code = any(codes);
  delete from annual_budgets where property_code = any(codes);
  delete from work_order_daily_stats where property_code = any(codes);
  delete from vendor_contracts where vendor_id in (select id from vendors where company_id = c);
  delete from vendor_properties where vendor_id in (select id from vendors where company_id = c);
  delete from vendors where company_id = c;
  delete from profile_properties where property_code = any(codes);
  -- Logins are deleted by the server function first; anything left is detached.
  update profiles set company_id = null where company_id = c;
  delete from properties where company_id = c;

  select asana_token_secret into secret_name from companies where id = c;
  if secret_name like 'asana\_token\_%' then delete from vault.secrets where name = secret_name; end if;
  delete from companies where id = c;
end;
$$;

revoke all on function remove_company_rows(uuid) from public, anon, authenticated;
grant execute on function remove_company_rows(uuid) to service_role;
