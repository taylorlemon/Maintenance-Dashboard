-- ── StoneAnchor Housekeeping (H1): schedules, the day board, "My rooms" ────
-- Run after supabase/rooms/03-top-rooms.sql. Safe to re-run.
--
-- Built on the room list (supabase/rooms/). Three tables:
--   cleaning_types      "Standard clean, 30 minutes" — one list per company
--   cleaning_schedules  "Room 204: weekly on Tuesdays, Standard, usually Maria"
--   cleanings           one row per room per day it's due (or added by hand):
--                       who it's assigned to, and when it was started,
--                       finished or skipped (with a reason)
--
-- A day's cleanings are made from the schedules the first time anyone opens
-- that day (ensure_cleanings) — never for days before a schedule existed.
--
-- Same rules as tasks and rooms:
--   * Nothing is deleted from the site. A cleaning added by mistake is
--     cancelled with a reason; a schedule is stopped (archived).
--   * Started / finished / skipped / cancelled times come from the database
--     clock and can't be typed in. A mis-tap can be undone.
--   * Company walls apply. Admins, Editors and Staff (housekeepers, front
--     desk, maintenance) see and change schedules and cleanings; Viewers look
--     only; Admins and Editors edit the cleaning-type list.

-- ── Tables ───────────────────────────────────────────────────────────────────

create table if not exists cleaning_types (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  name text not null check (btrim(name) <> ''),
  target_minutes int check (target_minutes between 1 and 600),
  sort_order int not null default 0,
  archived boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index if not exists cleaning_types_name_idx on cleaning_types (company_id, lower(btrim(name))) where not archived;

create table if not exists cleaning_schedules (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(id),
  property_code text not null references properties(code),
  cleaning_type_id uuid not null references cleaning_types(id),
  interval_weeks int not null default 1 check (interval_weeks between 1 and 8),  -- 1 = weekly, 2 = every 2 weeks, 4 = every 4 weeks
  weekday int not null check (weekday between 1 and 7),                          -- 1 = Monday … 7 = Sunday
  start_date date not null,                                                      -- the first cleaning (a `weekday`)
  housekeeper_id uuid references profiles(id) on delete set null,                -- usually done by
  notes text not null default '',
  archived_at timestamptz,                                                       -- stopped
  created_at timestamptz not null default now(),
  created_by uuid,
  created_by_name text
);
create index if not exists cleaning_schedules_property_idx on cleaning_schedules (property_code) where archived_at is null;
create index if not exists cleaning_schedules_room_idx on cleaning_schedules (room_id);

create table if not exists cleanings (
  id uuid primary key default gen_random_uuid(),
  property_code text not null references properties(code),
  room_id uuid not null references rooms(id),
  schedule_id uuid references cleaning_schedules(id),   -- empty = added by hand for that day
  clean_date date not null,
  cleaning_type_id uuid not null references cleaning_types(id),
  housekeeper_id uuid references profiles(id) on delete set null,
  notes text not null default '',
  started_at timestamptz,
  started_by_name text,
  finished_at timestamptz,
  finished_by_name text,
  skipped_at timestamptz,
  skip_reason text,
  skipped_by_name text,
  cancelled_at timestamptz,
  cancel_reason text,
  cancelled_by_name text,
  created_at timestamptz not null default now(),
  created_by uuid,
  created_by_name text
);
create unique index if not exists cleanings_schedule_day_idx on cleanings (schedule_id, clean_date) where schedule_id is not null;
create index if not exists cleanings_day_idx on cleanings (property_code, clean_date);
create index if not exists cleanings_room_idx on cleanings (room_id, clean_date);

alter table cleaning_types enable row level security;
alter table cleaning_schedules enable row level security;
alter table cleanings enable row level security;

-- ── Starter cleaning types ───────────────────────────────────────────────────

create or replace function seed_cleaning_types(c uuid) returns void
language sql security definer set search_path = public as $$
  insert into cleaning_types (company_id, name, target_minutes, sort_order)
  select c, x.n, x.mins, x.i from (values
    ('Standard clean', 30, 1), ('Deep clean', 90, 2), ('Move-out clean', 120, 3), ('Common area', 20, 4)
  ) as x(n, mins, i)
   where not exists (select 1 from cleaning_types where company_id = c);
$$;
revoke all on function seed_cleaning_types(uuid) from public, anon, authenticated;

select seed_cleaning_types(id) from companies;

-- New companies get every starter list (replaces the version in 02-equipment.sql).
create or replace function after_company_added() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform seed_unit_types(new.id);
  perform seed_equipment_types(new.id);
  perform seed_cleaning_types(new.id);
  return null;
end;
$$;

-- ── Guards ───────────────────────────────────────────────────────────────────
-- current_user tells us who's asking, as in guard_task_changes:
-- 'authenticated'/'anon' = the site, 'service_role' = our server functions,
-- anything else = the database itself (ensure_cleanings, remove_company_rows).

-- The person a room's cleaning is assigned to has to be in the same company.
create or replace function housekeeper_ok(p_profile uuid, p_code text) returns boolean
language sql stable security definer set search_path = public as $$
  select p_profile is null
      or exists (select 1 from profiles where id = p_profile and company_id = property_company(p_code));
$$;

create or replace function guard_cleaning_schedule_changes() returns trigger
language plpgsql set search_path = public as $$
declare
  from_site boolean := current_user in ('authenticated', 'anon');
  from_app boolean := current_user in ('authenticated', 'anon', 'service_role');
begin
  if tg_op = 'DELETE' then
    if from_app then raise exception 'Schedules can''t be deleted. Stop it instead.'; end if;
    return old;
  end if;
  new.notes := btrim(coalesce(new.notes, ''));
  if (select property_code from rooms where id = new.room_id) is distinct from new.property_code then
    raise exception 'That room is in a different building.';
  end if;
  if (select company_id from cleaning_types where id = new.cleaning_type_id) is distinct from property_company(new.property_code) then
    raise exception 'That cleaning type belongs to another company.';
  end if;
  if not housekeeper_ok(new.housekeeper_id, new.property_code) then
    raise exception 'That person isn''t in this company.';
  end if;
  if tg_op = 'INSERT' then
    if from_site then
      new.created_at := now(); new.created_by := auth.uid(); new.created_by_name := my_display_name();
      new.archived_at := null;
    end if;
    return new;
  end if;
  if from_app and (new.id <> old.id or new.room_id <> old.room_id or new.property_code <> old.property_code
     or new.created_at is distinct from old.created_at or new.created_by is distinct from old.created_by
     or new.created_by_name is distinct from old.created_by_name) then
    raise exception 'That part of a schedule can''t be changed.';
  end if;
  if old.archived_at is not null and from_app and new.archived_at is distinct from old.archived_at then
    raise exception 'A stopped schedule stays stopped. Add a new one instead.';
  end if;
  if old.archived_at is null and new.archived_at is not null and from_site then new.archived_at := now(); end if;
  return new;
end;
$$;

drop trigger if exists guard_cleaning_schedule_changes on cleaning_schedules;
create trigger guard_cleaning_schedule_changes
  before insert or update or delete on cleaning_schedules
  for each row execute function guard_cleaning_schedule_changes();

-- A schedule's later changes reach the cleanings already made for upcoming
-- days that nobody has started: a new usual housekeeper or cleaning type
-- carries over, and stopping it cancels them (cancelled, not deleted).
create or replace function after_cleaning_schedule_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  today date := (now() at time zone coalesce((select time_zone from properties where code = new.property_code), 'America/Denver'))::date;
begin
  if new.archived_at is not null and old.archived_at is null then
    update cleanings set cancelled_at = now(), cancel_reason = 'Schedule stopped', cancelled_by_name = coalesce(my_display_name(), 'StoneAnchor')
     where schedule_id = new.id and clean_date >= today and started_at is null and finished_at is null
       and skipped_at is null and cancelled_at is null;
    return null;
  end if;
  if new.housekeeper_id is distinct from old.housekeeper_id or new.cleaning_type_id <> old.cleaning_type_id then
    update cleanings set housekeeper_id = new.housekeeper_id, cleaning_type_id = new.cleaning_type_id
     where schedule_id = new.id and clean_date >= today and started_at is null and finished_at is null
       and skipped_at is null and cancelled_at is null
       and housekeeper_id is not distinct from old.housekeeper_id;   -- leave ones already reassigned for the day
  end if;
  -- A changed day or frequency: upcoming cleanings that no longer fit are cancelled.
  if new.weekday <> old.weekday or new.interval_weeks <> old.interval_weeks or new.start_date <> old.start_date then
    update cleanings set cancelled_at = now(), cancel_reason = 'Schedule changed', cancelled_by_name = coalesce(my_display_name(), 'StoneAnchor')
     where schedule_id = new.id and clean_date >= today and started_at is null and finished_at is null
       and skipped_at is null and cancelled_at is null;
  end if;
  return null;
end;
$$;

drop trigger if exists after_cleaning_schedule_change on cleaning_schedules;
create trigger after_cleaning_schedule_change after update on cleaning_schedules
  for each row execute function after_cleaning_schedule_change();

create or replace function guard_cleaning_changes() returns trigger
language plpgsql set search_path = public as $$
declare
  from_site boolean := current_user in ('authenticated', 'anon');
  from_app boolean := current_user in ('authenticated', 'anon', 'service_role');
  who text;
begin
  if tg_op = 'DELETE' then
    if from_app then raise exception 'Cleanings can''t be deleted. Cancel it instead, with a reason.'; end if;
    return old;
  end if;
  new.notes := btrim(coalesce(new.notes, ''));
  if (select property_code from rooms where id = new.room_id) is distinct from new.property_code then
    raise exception 'That room is in a different building.';
  end if;
  if (select company_id from cleaning_types where id = new.cleaning_type_id) is distinct from property_company(new.property_code) then
    raise exception 'That cleaning type belongs to another company.';
  end if;
  if not housekeeper_ok(new.housekeeper_id, new.property_code) then
    raise exception 'That person isn''t in this company.';
  end if;

  if tg_op = 'INSERT' then
    if from_site then
      new.created_at := now(); new.created_by := auth.uid(); new.created_by_name := my_display_name();
      new.started_at := null; new.started_by_name := null; new.finished_at := null; new.finished_by_name := null;
      new.skipped_at := null; new.skip_reason := null; new.skipped_by_name := null;
      new.cancelled_at := null; new.cancel_reason := null; new.cancelled_by_name := null;
      if new.schedule_id is not null then raise exception 'Scheduled cleanings are made from their schedule.'; end if;
    end if;
    return new;
  end if;

  if from_app and (new.id <> old.id or new.room_id <> old.room_id or new.property_code <> old.property_code
     or new.schedule_id is distinct from old.schedule_id or new.clean_date <> old.clean_date
     or new.created_at is distinct from old.created_at or new.created_by is distinct from old.created_by
     or new.created_by_name is distinct from old.created_by_name) then
    raise exception 'That part of a cleaning can''t be changed.';
  end if;

  if from_site then
    who := my_display_name();
    -- Each time is stamped by the database the moment it's set; clearing it
    -- (Undo) clears who did it; otherwise it can't be changed.
    if new.started_at is not null and old.started_at is null then new.started_at := now(); new.started_by_name := who;
    elsif new.started_at is null then new.started_by_name := null;
    else new.started_at := old.started_at; new.started_by_name := old.started_by_name; end if;

    if new.finished_at is not null and old.finished_at is null then new.finished_at := now(); new.finished_by_name := who;
    elsif new.finished_at is null then new.finished_by_name := null;
    else new.finished_at := old.finished_at; new.finished_by_name := old.finished_by_name; end if;

    if new.skipped_at is not null and old.skipped_at is null then
      if coalesce(btrim(new.skip_reason), '') = '' then raise exception 'Say why it was skipped.'; end if;
      new.skipped_at := now(); new.skipped_by_name := who;
    elsif new.skipped_at is null then new.skip_reason := null; new.skipped_by_name := null;
    else new.skipped_at := old.skipped_at; new.skip_reason := old.skip_reason; new.skipped_by_name := old.skipped_by_name; end if;

    if new.cancelled_at is not null and old.cancelled_at is null then
      if coalesce(btrim(new.cancel_reason), '') = '' then raise exception 'Say why it''s being cancelled.'; end if;
      new.cancelled_at := now(); new.cancelled_by_name := who;
    elsif new.cancelled_at is null then new.cancel_reason := null; new.cancelled_by_name := null;
    else new.cancelled_at := old.cancelled_at; new.cancel_reason := old.cancel_reason; new.cancelled_by_name := old.cancelled_by_name; end if;
  end if;

  if new.finished_at is not null and new.skipped_at is not null then
    raise exception 'A cleaning can''t be both done and skipped.';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_cleaning_changes on cleanings;
create trigger guard_cleaning_changes
  before insert or update or delete on cleanings
  for each row execute function guard_cleaning_changes();

-- ── Access rules ─────────────────────────────────────────────────────────────
-- No delete rules on purpose.

drop policy if exists "cleaning_types readable by company" on cleaning_types;
create policy "cleaning_types readable by company" on cleaning_types
  for select using (is_executive() or in_my_company(company_id));
drop policy if exists "cleaning_types insertable by editors" on cleaning_types;
create policy "cleaning_types insertable by editors" on cleaning_types
  for insert with check (can_edit_unit_types(company_id));
drop policy if exists "cleaning_types updatable by editors" on cleaning_types;
create policy "cleaning_types updatable by editors" on cleaning_types
  for update using (can_edit_unit_types(company_id)) with check (can_edit_unit_types(company_id));

drop policy if exists "cleaning_schedules readable by scope" on cleaning_schedules;
create policy "cleaning_schedules readable by scope" on cleaning_schedules
  for select using (can_see_property(property_code) or can_work_tasks(property_code));
drop policy if exists "cleaning_schedules insertable by workers" on cleaning_schedules;
create policy "cleaning_schedules insertable by workers" on cleaning_schedules
  for insert with check (can_work_tasks(property_code));
drop policy if exists "cleaning_schedules updatable by workers" on cleaning_schedules;
create policy "cleaning_schedules updatable by workers" on cleaning_schedules
  for update using (can_work_tasks(property_code)) with check (can_work_tasks(property_code));

drop policy if exists "cleanings readable by scope" on cleanings;
create policy "cleanings readable by scope" on cleanings
  for select using (can_see_property(property_code) or can_work_tasks(property_code));
drop policy if exists "cleanings insertable by workers" on cleanings;
create policy "cleanings insertable by workers" on cleanings
  for insert with check (can_work_tasks(property_code));
drop policy if exists "cleanings updatable by workers" on cleanings;
create policy "cleanings updatable by workers" on cleanings
  for update using (can_work_tasks(property_code)) with check (can_work_tasks(property_code));

-- ── Look-ups and actions for the page ────────────────────────────────────────

-- Makes a day's cleanings from the schedules (only once: a schedule gets at
-- most one cleaning per day), never for a day before the schedule was set up.
-- Returns how many were made. Security definer so a Viewer opening the board
-- can still see the day; it checks the person can see the building first.
create or replace function ensure_cleanings(p_code text, p_date date) returns int
language plpgsql security definer set search_path = public as $$
declare
  n int;
  tz text := coalesce((select time_zone from properties where code = p_code), 'America/Denver');
begin
  if not (can_see_property(p_code) or can_work_tasks(p_code)) then
    raise exception 'Not allowed.';
  end if;
  insert into cleanings (property_code, room_id, schedule_id, clean_date, cleaning_type_id, housekeeper_id, created_by_name)
  select s.property_code, s.room_id, s.id, p_date, s.cleaning_type_id, s.housekeeper_id, 'Schedule'
    from cleaning_schedules s
    join rooms r on r.id = s.room_id and r.archived_at is null
   where s.property_code = p_code
     and s.archived_at is null
     and s.weekday = extract(isodow from p_date)::int
     and p_date >= s.start_date
     and ((p_date - s.start_date) / 7) % s.interval_weeks = 0
     and p_date >= (s.created_at at time zone tz)::date
  on conflict (schedule_id, clean_date) where schedule_id is not null do nothing;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- The same for every day in a range, up to today (never future days). Reports
-- call this first, so a day nobody happened to open still shows the
-- cleanings that were due (and missed). Returns how many were made.
create or replace function ensure_cleanings_range(p_code text, p_from date, p_to date) returns int
language plpgsql security definer set search_path = public as $$
declare
  n int;
  tz text := coalesce((select time_zone from properties where code = p_code), 'America/Denver');
  last_day date := least(p_to, (now() at time zone tz)::date);
begin
  if not (can_see_property(p_code) or can_work_tasks(p_code)) then
    raise exception 'Not allowed.';
  end if;
  if p_from > last_day then return 0; end if;
  if last_day - p_from > 400 then raise exception 'That range is too long.'; end if;
  insert into cleanings (property_code, room_id, schedule_id, clean_date, cleaning_type_id, housekeeper_id, created_by_name)
  select s.property_code, s.room_id, s.id, d::date, s.cleaning_type_id, s.housekeeper_id, 'Schedule'
    from cleaning_schedules s
    join rooms r on r.id = s.room_id and r.archived_at is null
    cross join generate_series(greatest(p_from, s.start_date), last_day, interval '1 day') d
   where s.property_code = p_code
     and s.archived_at is null
     and s.weekday = extract(isodow from d)::int
     and ((d::date - s.start_date) / 7) % s.interval_weeks = 0
     and d::date >= (s.created_at at time zone tz)::date
  on conflict (schedule_id, clean_date) where schedule_id is not null do nothing;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- The people a building's cleanings can be assigned to: its company's Admins,
-- and the Editors and Staff given that building.
create or replace function building_workers(p_code text)
returns table (id uuid, name text, role text)
language sql stable security definer set search_path = public as $$
  select p.id, coalesce(nullif(btrim(p.full_name), ''), p.email), p.role
    from profiles p
   where (can_see_property(p_code) or can_work_tasks(p_code))
     and p.company_id = property_company(p_code)
     and (p.role = 'admin' or (p.role in ('editor', 'staff')
          and exists (select 1 from profile_properties pp where pp.profile_id = p.id and pp.property_code = p_code)))
   order by 2;
$$;

revoke all on function ensure_cleanings(text, date) from public, anon;
grant execute on function ensure_cleanings(text, date) to authenticated;
revoke all on function ensure_cleanings_range(text, date, date) from public, anon;
grant execute on function ensure_cleanings_range(text, date, date) to authenticated;
revoke all on function building_workers(text) from public, anon;
grant execute on function building_workers(text) to authenticated;
revoke all on function housekeeper_ok(uuid, text) from public, anon;
grant execute on function housekeeper_ok(uuid, text) to authenticated;

-- ── Least access for the helpers added with Rooms and Housekeeping ───────────
-- (Found in the pre-launch security check, 2026-11-25.) Nobody gets to run
-- something they don't need:
--   * The automatic change-log / setup functions only ever run as triggers.
--   * equipment_label is only used inside a trigger (which runs as the owner).
--   * can_edit_unit_types and unit_type_company are used by the access rules,
--     which need logged-in people to be able to run them — but nobody else.
revoke all on function after_room_change() from public, anon, authenticated;
revoke all on function after_room_alias_change() from public, anon, authenticated;
revoke all on function after_room_equipment_change() from public, anon, authenticated;
revoke all on function after_cleaning_schedule_change() from public, anon, authenticated;
revoke all on function after_company_added() from public, anon, authenticated;
revoke all on function equipment_label(uuid, int) from public, anon, authenticated;
revoke all on function can_edit_unit_types(uuid) from public, anon;
grant execute on function can_edit_unit_types(uuid) to authenticated;
revoke all on function unit_type_company(uuid) from public, anon;
grant execute on function unit_type_company(uuid) to authenticated;

-- ── Removing a company also removes its housekeeping ─────────────────────────
-- Replaces the version in supabase/rooms/02-equipment.sql (same steps, plus
-- the housekeeping tables).
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
  delete from cleanings where property_code = any(codes);
  delete from cleaning_schedules where property_code = any(codes);
  delete from cleaning_types where company_id = c;
  delete from room_equipment where property_code = any(codes);
  delete from unit_type_equipment where unit_type_id in (select id from unit_types where company_id = c);
  delete from equipment_types where company_id = c;
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
