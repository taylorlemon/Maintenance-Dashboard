-- ── StoneAnchor Rooms: a profile for every room and common area ─────────────
-- Run after supabase/tasks/07-live-updates.sql. Safe to re-run.
--
-- Each building gets a list of its rooms (units like "204") and common areas
-- ("Lobby", "Pool"). Each one has a profile — unit type, floor, notes — and
-- its page shows every work order, PM and room turn ever logged for it.
--
-- Work orders themselves are NOT changed by any of this. A task still just
-- has the room text someone typed. A room's page finds its tasks by matching
-- that text against the room's name, plus any other spellings matched to it
-- ("Apt 204", "#204") — ignoring upper/lower case and extra spaces. So the
-- permanent work-order record is never rewritten.
--
-- Same rules as the task tables:
--   * Nothing is deleted from the site. A room is archived (and can be
--     restored); a wrongly matched spelling is un-matched (archived), not erased.
--   * Who/when stamps come from the database and can't be changed.
--   * Every change to a room is written to room_events automatically.
--   * Company walls: a building's rooms are only visible to people who can
--     see or work that building.
--
--             reads rooms   adds / edits rooms   edits the unit-type list
--   Admin     yes           yes                  yes
--   Editor    yes           yes                  yes
--   Staff     yes           yes                  no
--   Viewer    yes           no                   no

-- ── Matching ─────────────────────────────────────────────────────────────────

-- "  Apt   204 " and "apt 204" are the same spelling.
create or replace function room_key(t text) returns text
language sql immutable as $$
  select lower(regexp_replace(btrim(coalesce(t, '')), '\s+', ' ', 'g'));
$$;

-- Lets a room's page find its tasks quickly.
create index if not exists tasks_room_key_idx on tasks (property_code, room_key(room));

-- ── Tables ───────────────────────────────────────────────────────────────────

-- "Studio", "1 Bedroom"… one list per company, editable by Admins and Editors.
create table if not exists unit_types (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  name text not null check (btrim(name) <> ''),
  sort_order int not null default 0,
  archived boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index if not exists unit_types_name_idx on unit_types (company_id, lower(btrim(name))) where not archived;

create table if not exists rooms (
  id uuid primary key default gen_random_uuid(),
  property_code text not null references properties(code),
  name text not null check (btrim(name) <> ''),
  kind text not null default 'unit' check (kind in ('unit', 'common')),
  unit_type_id uuid references unit_types(id),
  floor text not null default '',
  notes text not null default '',
  archived_at timestamptz,
  archived_by_name text,
  created_at timestamptz not null default now(),
  created_by uuid,
  created_by_name text
);
-- Two rooms in a building can't share a name (archived ones don't count).
create unique index if not exists rooms_name_idx on rooms (property_code, room_key(name)) where archived_at is null;

-- Other spellings people have typed for a room ("Apt 204" → room 204). A row
-- with no room is a spelling someone marked "not a room", so it stops showing
-- in the review list.
create table if not exists room_aliases (
  id uuid primary key default gen_random_uuid(),
  property_code text not null references properties(code),
  alias text not null check (btrim(alias) <> ''),
  room_id uuid references rooms(id),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid,
  created_by_name text
);
create unique index if not exists room_aliases_key_idx on room_aliases (property_code, room_key(alias)) where archived_at is null;
create index if not exists room_aliases_room_idx on room_aliases (room_id);

-- Written only by the triggers below; nobody adds to it by hand.
create table if not exists room_events (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(id),
  property_code text not null,
  event_type text not null,   -- created, edited, archived, restored, matched, unmatched
  detail text,
  actor_id uuid,
  actor_name text,
  created_at timestamptz not null default now()
);
create index if not exists room_events_room_idx on room_events (room_id, created_at);

alter table unit_types enable row level security;
alter table rooms enable row level security;
alter table room_aliases enable row level security;
alter table room_events enable row level security;

-- ── Starter unit types ───────────────────────────────────────────────────────

create or replace function seed_unit_types(c uuid) returns void
language sql security definer set search_path = public as $$
  insert into unit_types (company_id, name, sort_order)
  select c, n, i from unnest(array['Studio', '1 Bedroom', '2 Bedroom', '3 Bedroom']) with ordinality as x(n, i)
   where not exists (select 1 from unit_types where company_id = c);
$$;
revoke all on function seed_unit_types(uuid) from public, anon, authenticated;

-- Every company that exists now, and every new one, starts with the four.
select seed_unit_types(id) from companies;

create or replace function after_company_added() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform seed_unit_types(new.id);
  return null;
end;
$$;
drop trigger if exists after_company_added on companies;
create trigger after_company_added after insert on companies
  for each row execute function after_company_added();

-- ── Guards ───────────────────────────────────────────────────────────────────
-- current_user tells us who's asking, as in guard_task_changes:
-- 'authenticated'/'anon' = the site, 'service_role' = our server functions,
-- anything else = the database itself (remove_company_rows runs that way).

create or replace function guard_room_changes() returns trigger
language plpgsql set search_path = public as $$
declare
  from_site boolean := current_user in ('authenticated', 'anon');
  from_app boolean := current_user in ('authenticated', 'anon', 'service_role');
  taken record;
begin
  if tg_op = 'DELETE' then
    if from_app then raise exception 'Rooms can''t be deleted. Archive it instead.'; end if;
    return old;
  end if;

  new.name := regexp_replace(btrim(new.name), '\s+', ' ', 'g');
  new.floor := btrim(coalesce(new.floor, ''));
  new.notes := btrim(coalesce(new.notes, ''));
  if new.kind = 'common' then new.unit_type_id := null; end if;
  if new.unit_type_id is not null
     and (select company_id from unit_types where id = new.unit_type_id) is distinct from property_company(new.property_code) then
    raise exception 'That unit type belongs to another company.';
  end if;

  if tg_op = 'INSERT' then
    if from_site then
      new.created_at := now();
      new.created_by := auth.uid();
      new.created_by_name := my_display_name();
      new.archived_at := null; new.archived_by_name := null;
    end if;
  else
    if from_app and (new.id <> old.id or new.property_code <> old.property_code
       or new.created_at is distinct from old.created_at
       or new.created_by is distinct from old.created_by
       or new.created_by_name is distinct from old.created_by_name) then
      raise exception 'That part of a room''s record can''t be changed.';
    end if;
    -- Archiving stamps the time now; restoring clears it; otherwise it stays.
    if new.archived_at is not null and old.archived_at is null then
      if from_site then new.archived_at := now(); new.archived_by_name := my_display_name(); end if;
    elsif new.archived_at is null then
      new.archived_by_name := null;
    else
      new.archived_at := old.archived_at; new.archived_by_name := old.archived_by_name;
    end if;
  end if;

  -- A name another room is already known by can't be used for a new name.
  if new.archived_at is null then
    select a.alias, r.name as room_name into taken from room_aliases a join rooms r on r.id = a.room_id
     where a.property_code = new.property_code and a.archived_at is null and a.room_id <> new.id
       and room_key(a.alias) = room_key(new.name) limit 1;
    if found then
      raise exception '“%” is already matched to room %. Un-match it on that room''s page first.', taken.alias, taken.room_name;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists guard_room_changes on rooms;
create trigger guard_room_changes
  before insert or update or delete on rooms
  for each row execute function guard_room_changes();

create or replace function guard_room_alias_changes() returns trigger
language plpgsql set search_path = public as $$
declare
  from_site boolean := current_user in ('authenticated', 'anon');
  from_app boolean := current_user in ('authenticated', 'anon', 'service_role');
begin
  if tg_op = 'DELETE' then
    if from_app then raise exception 'Spellings can''t be deleted. Un-match it instead.'; end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    new.alias := regexp_replace(btrim(new.alias), '\s+', ' ', 'g');
    if from_site then
      new.created_at := now(); new.created_by := auth.uid(); new.created_by_name := my_display_name();
      new.archived_at := null;
    end if;
    if new.room_id is not null and (select property_code from rooms where id = new.room_id) is distinct from new.property_code then
      raise exception 'That room is in a different building.';
    end if;
    if exists (select 1 from rooms where property_code = new.property_code and archived_at is null
                and room_key(name) = room_key(new.alias)) then
      raise exception '“%” is already the name of a room.', new.alias;
    end if;
    return new;
  end if;

  -- The only change allowed afterwards is un-matching (archiving) it.
  if from_app and (new.alias <> old.alias or new.room_id is distinct from old.room_id
     or new.property_code <> old.property_code or new.created_at is distinct from old.created_at
     or new.created_by is distinct from old.created_by or new.created_by_name is distinct from old.created_by_name
     or old.archived_at is not null) then
    raise exception 'A matched spelling can only be un-matched.';
  end if;
  if from_site and new.archived_at is not null then new.archived_at := now(); end if;
  return new;
end;
$$;

drop trigger if exists guard_room_alias_changes on room_aliases;
create trigger guard_room_alias_changes
  before insert or update or delete on room_aliases
  for each row execute function guard_room_alias_changes();

-- ── Change log ───────────────────────────────────────────────────────────────

create or replace function after_room_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  who uuid := auth.uid();
  who_name text := coalesce(my_display_name(), 'StoneAnchor');
  changes text[] := '{}';
  old_type text;
  new_type text;
begin
  if tg_op = 'INSERT' then
    insert into room_events (room_id, property_code, event_type, detail, actor_id, actor_name, created_at)
      values (new.id, new.property_code, 'created', null, new.created_by, coalesce(new.created_by_name, who_name), new.created_at);
    -- A spelling someone had marked "not a room" is now a room: drop that mark.
    update room_aliases set archived_at = now()
     where property_code = new.property_code and room_id is null and archived_at is null
       and room_key(alias) = room_key(new.name);
    return null;
  end if;

  if new.name <> old.name then
    changes := changes || ('Name: ' || old.name || ' → ' || new.name);
    -- Work orders typed with the old name stay on this room's page.
    if not exists (select 1 from room_aliases where property_code = new.property_code and archived_at is null
                    and room_key(alias) = room_key(old.name))
       and room_key(old.name) <> room_key(new.name) then
      insert into room_aliases (property_code, alias, room_id, created_by, created_by_name)
        values (new.property_code, old.name, new.id, who, who_name);
    end if;
  end if;
  if new.kind <> old.kind then
    changes := changes || ('Kind: ' || case old.kind when 'unit' then 'Unit' else 'Common area' end
                          || ' → ' || case new.kind when 'unit' then 'Unit' else 'Common area' end);
  end if;
  if new.unit_type_id is distinct from old.unit_type_id then
    select name into old_type from unit_types where id = old.unit_type_id;
    select name into new_type from unit_types where id = new.unit_type_id;
    changes := changes || ('Unit type: ' || coalesce(old_type, '(none)') || ' → ' || coalesce(new_type, '(none)'));
  end if;
  if new.floor <> old.floor then
    changes := changes || ('Floor: ' || coalesce(nullif(old.floor, ''), '(none)') || ' → ' || coalesce(nullif(new.floor, ''), '(none)'));
  end if;
  if new.notes <> old.notes then changes := changes || 'Notes changed'::text; end if;
  if cardinality(changes) > 0 then
    insert into room_events (room_id, property_code, event_type, detail, actor_id, actor_name)
      values (new.id, new.property_code, 'edited', array_to_string(changes, '; '), who, who_name);
  end if;

  if new.archived_at is not null and old.archived_at is null then
    insert into room_events (room_id, property_code, event_type, actor_id, actor_name)
      values (new.id, new.property_code, 'archived', who, who_name);
  elsif new.archived_at is null and old.archived_at is not null then
    insert into room_events (room_id, property_code, event_type, actor_id, actor_name)
      values (new.id, new.property_code, 'restored', who, who_name);
  end if;
  return null;
end;
$$;

drop trigger if exists after_room_change on rooms;
create trigger after_room_change after insert or update on rooms
  for each row execute function after_room_change();

create or replace function after_room_alias_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.room_id is null then return null; end if;
  if tg_op = 'INSERT' then
    insert into room_events (room_id, property_code, event_type, detail, actor_id, actor_name, created_at)
      values (new.room_id, new.property_code, 'matched', new.alias, new.created_by, coalesce(new.created_by_name, 'StoneAnchor'), new.created_at);
  elsif new.archived_at is not null and old.archived_at is null then
    insert into room_events (room_id, property_code, event_type, detail, actor_id, actor_name)
      values (new.room_id, new.property_code, 'unmatched', new.alias, auth.uid(), coalesce(my_display_name(), 'StoneAnchor'));
  end if;
  return null;
end;
$$;

drop trigger if exists after_room_alias_change on room_aliases;
create trigger after_room_alias_change after insert or update on room_aliases
  for each row execute function after_room_alias_change();

-- ── Access rules ─────────────────────────────────────────────────────────────
-- No delete rules on purpose.

-- Admins and Editors of the company (or the Executive) set up unit types.
create or replace function can_edit_unit_types(c uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select is_executive() or (in_my_company(c) and (is_admin() or is_editor()));
$$;

drop policy if exists "unit_types readable by company" on unit_types;
create policy "unit_types readable by company" on unit_types
  for select using (is_executive() or in_my_company(company_id));
drop policy if exists "unit_types insertable by editors" on unit_types;
create policy "unit_types insertable by editors" on unit_types
  for insert with check (can_edit_unit_types(company_id));
drop policy if exists "unit_types updatable by editors" on unit_types;
create policy "unit_types updatable by editors" on unit_types
  for update using (can_edit_unit_types(company_id)) with check (can_edit_unit_types(company_id));

-- Rooms: anyone who sees the building reads them; anyone who works its tasks
-- (Staff, Editors, Admins — not Viewers) adds and edits them.
drop policy if exists "rooms readable by scope" on rooms;
create policy "rooms readable by scope" on rooms
  for select using (can_see_property(property_code) or can_work_tasks(property_code));
drop policy if exists "rooms insertable by workers" on rooms;
create policy "rooms insertable by workers" on rooms
  for insert with check (can_work_tasks(property_code));
drop policy if exists "rooms updatable by workers" on rooms;
create policy "rooms updatable by workers" on rooms
  for update using (can_work_tasks(property_code)) with check (can_work_tasks(property_code));

drop policy if exists "room_aliases readable by scope" on room_aliases;
create policy "room_aliases readable by scope" on room_aliases
  for select using (can_see_property(property_code) or can_work_tasks(property_code));
drop policy if exists "room_aliases insertable by workers" on room_aliases;
create policy "room_aliases insertable by workers" on room_aliases
  for insert with check (can_work_tasks(property_code));
drop policy if exists "room_aliases updatable by workers" on room_aliases;
create policy "room_aliases updatable by workers" on room_aliases
  for update using (can_work_tasks(property_code)) with check (can_work_tasks(property_code));

drop policy if exists "room_events readable by scope" on room_events;
create policy "room_events readable by scope" on room_events
  for select using (can_see_property(property_code) or can_work_tasks(property_code));

-- ── Look-ups for the page ────────────────────────────────────────────────────
-- Not security definer: the rules above (and the task rules) still decide what
-- each person sees — Staff, for example, only ever count their own kinds of list.

-- Every spelling that points at a room in a building: each room's own name,
-- plus the other spellings matched to it.
create or replace function room_keys(p_code text) returns table (room_id uuid, k text)
language sql stable set search_path = public as $$
  select r.id, room_key(r.name) from rooms r where r.property_code = p_code and r.archived_at is null
  union
  select a.room_id, room_key(a.alias) from room_aliases a
   join rooms r on r.id = a.room_id and r.archived_at is null
   where a.property_code = p_code and a.archived_at is null;
$$;

-- For the room list: open items, all-time count and last turn, per room.
create or replace function room_summary(p_code text)
returns table (room_id uuid, open_count bigint, total bigint, last_turned timestamptz, last_activity timestamptz)
language sql stable set search_path = public as $$
  with k as materialized (select * from room_keys(p_code))
  select k.room_id,
         count(*) filter (where t.completed_at is null and t.cancelled_at is null),
         count(*) filter (where t.cancelled_at is null),
         max(t.completed_at) filter (where l.kind = 'room_turns' and t.cancelled_at is null),
         max(greatest(t.created_at, t.completed_at))
    from k
    join tasks t on t.property_code = p_code and room_key(t.room) = k.k
    join task_lists l on l.id = t.list_id
   group by k.room_id;
$$;

-- Everything ever logged for one room, newest first. The room's spellings are
-- worked out once up front ("materialized"), then matched against the tasks.
create or replace function room_tasks(p_room uuid)
returns table (id uuid, list_id uuid, list_name text, list_kind text, room text, title text, details text,
               due_date date, created_at timestamptz, created_by_name text, completed_at timestamptz,
               completed_by_name text, cancelled_at timestamptz, cancelled_by_name text, cancel_reason text)
language sql stable set search_path = public as $$
  with r as materialized (select property_code from rooms where rooms.id = p_room),
       keys as materialized (select k from room_keys((select property_code from r)) where room_keys.room_id = p_room)
  select t.id, t.list_id, l.name, l.kind, t.room, t.title, t.details, t.due_date, t.created_at, t.created_by_name,
         t.completed_at, t.completed_by_name, t.cancelled_at, t.cancelled_by_name, t.cancel_reason
    from tasks t
    join keys on room_key(t.room) = keys.k
    join task_lists l on l.id = t.list_id
   where t.property_code = (select property_code from r)
   order by t.created_at desc;
$$;

-- The review list: spellings used in a building's tasks that aren't a room's
-- name, aren't matched to a room, and haven't been marked "not a room".
create or replace function room_unmatched(p_code text)
returns table (spelling text, uses bigint, last_used timestamptz)
language sql stable set search_path = public as $$
  select mode() within group (order by t.room), count(*), max(t.created_at)
    from tasks t
   where t.property_code = p_code
     and room_key(t.room) not in (select k from room_keys(p_code))
     and room_key(t.room) not in (select room_key(a.alias) from room_aliases a
                                   where a.property_code = p_code and a.room_id is null and a.archived_at is null)
   group by room_key(t.room)
   order by count(*) desc, 1;
$$;

-- The Room box's suggestions when logging a task. Once a building has a room
-- list, it suggests those rooms (most-used first); until then, the spellings
-- already used, as before.
create or replace function task_rooms(p_code text) returns table (room text, uses bigint)
language sql stable set search_path = public as $$
  with keys as materialized (select * from room_keys(p_code)),
       uses as materialized (
         select keys.room_id, count(*) as n from tasks t join keys on room_key(t.room) = keys.k
          where t.property_code = p_code group by keys.room_id)
  select r.name, coalesce(u.n, 0)
    from rooms r left join uses u on u.room_id = r.id
   where r.property_code = p_code and r.archived_at is null
  union all
  select mode() within group (order by t.room), count(*) from tasks t
   where t.property_code = p_code
     and not exists (select 1 from rooms r where r.property_code = p_code and r.archived_at is null)
   group by lower(t.room)
  order by 2 desc, 1;
$$;

revoke all on function room_key(text) from public, anon;
grant execute on function room_key(text) to authenticated;
revoke all on function room_keys(text) from public, anon;
grant execute on function room_keys(text) to authenticated;
revoke all on function room_summary(text) from public, anon;
grant execute on function room_summary(text) to authenticated;
revoke all on function room_tasks(uuid) from public, anon;
grant execute on function room_tasks(uuid) to authenticated;
revoke all on function room_unmatched(text) from public, anon;
grant execute on function room_unmatched(text) to authenticated;
revoke all on function task_rooms(text) from public, anon;
grant execute on function task_rooms(text) to authenticated;

-- ── Removing a company also removes its rooms ────────────────────────────────
-- Replaces the version in supabase/tasks/01-tasks.sql (same steps, plus the
-- room tables, children first).
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
  delete from room_events where property_code = any(codes);
  delete from room_aliases where property_code = any(codes);
  delete from rooms where property_code = any(codes);
  delete from unit_types where company_id = c;
  delete from task_events where property_code = any(codes);
  delete from task_digest_sends where property_code = any(codes);
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
