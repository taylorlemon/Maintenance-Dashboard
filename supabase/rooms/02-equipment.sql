-- ── StoneAnchor Rooms, part 2: equipment in each room ──────────────────────
-- Run after supabase/rooms/01-rooms.sql. Safe to re-run.
--
-- Each room (or common area) can list its equipment — refrigerator, range,
-- PTAC… — with the year it was installed and, optionally, brand, model,
-- serial number, warranty end date and notes. Its age is worked out from the
-- install year. Same rules as rooms:
--   * Nothing is deleted from the site. A replaced item is marked "replaced"
--     and stays on the room's page, so the room keeps its equipment history.
--   * Every change is written to the room's change log (room_events).
--   * Company walls apply; Admins, Editors and Staff add and update
--     equipment, Viewers look only.
--
-- Equipment types ("Refrigerator", expected life 13 years, typical replacement
-- cost $800) are one list per company, set up by Admins and Editors — as is
-- each unit type's standard equipment ("every 1 Bedroom has a Refrigerator,
-- Range and PTAC"), which can be added to a building's rooms in one go. Items
-- added that way have no install year yet ("Year needed") until someone fills
-- it in.

-- ── Tables ───────────────────────────────────────────────────────────────────

create table if not exists equipment_types (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  name text not null check (btrim(name) <> ''),
  expected_life_years int check (expected_life_years between 1 and 100),
  replacement_cost numeric(10, 2) check (replacement_cost >= 0),
  sort_order int not null default 0,
  archived boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index if not exists equipment_types_name_idx on equipment_types (company_id, lower(btrim(name))) where not archived;

-- A unit type's standard equipment. This is setup, not history, so rows here
-- can be removed (by Admins and Editors).
create table if not exists unit_type_equipment (
  unit_type_id uuid not null references unit_types(id),
  equipment_type_id uuid not null references equipment_types(id),
  quantity int not null default 1 check (quantity between 1 and 20),
  primary key (unit_type_id, equipment_type_id)
);

create table if not exists room_equipment (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(id),
  property_code text not null references properties(code),
  equipment_type_id uuid not null references equipment_types(id),
  install_year int,              -- empty = "Year needed"
  brand text not null default '',
  model text not null default '',
  serial text not null default '',
  warranty_until date,
  notes text not null default '',
  replaced_at timestamptz,       -- set when it's taken out / replaced; it stays on record
  replaced_by_name text,
  created_at timestamptz not null default now(),
  created_by uuid,
  created_by_name text
);
create index if not exists room_equipment_room_idx on room_equipment (room_id);
create index if not exists room_equipment_property_idx on room_equipment (property_code) where replaced_at is null;

alter table equipment_types enable row level security;
alter table unit_type_equipment enable row level security;
alter table room_equipment enable row level security;

-- ── Starter equipment types ──────────────────────────────────────────────────
-- Expected lives are common industry rules of thumb; each company can change
-- them. Replacement costs start empty for each company to fill in.

create or replace function seed_equipment_types(c uuid) returns void
language sql security definer set search_path = public as $$
  insert into equipment_types (company_id, name, expected_life_years, sort_order)
  select c, x.n, x.life, x.i from (values
    ('Refrigerator', 13, 1), ('Range', 15, 2), ('Dishwasher', 10, 3), ('Microwave', 9, 4),
    ('PTAC', 10, 5), ('Washer', 11, 6), ('Dryer', 13, 7), ('Water heater', 10, 8), ('Garbage disposal', 10, 9)
  ) as x(n, life, i)
   where not exists (select 1 from equipment_types where company_id = c);
$$;
revoke all on function seed_equipment_types(uuid) from public, anon, authenticated;

select seed_equipment_types(id) from companies;

-- New companies get both starter lists (replaces the version in 01-rooms.sql).
create or replace function after_company_added() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform seed_unit_types(new.id);
  perform seed_equipment_types(new.id);
  return null;
end;
$$;

-- ── Guards ───────────────────────────────────────────────────────────────────

create or replace function guard_room_equipment_changes() returns trigger
language plpgsql set search_path = public as $$
declare
  from_site boolean := current_user in ('authenticated', 'anon');
  from_app boolean := current_user in ('authenticated', 'anon', 'service_role');
begin
  if tg_op = 'DELETE' then
    if from_app then raise exception 'Equipment can''t be deleted. Mark it replaced instead.'; end if;
    return old;
  end if;

  new.brand := btrim(coalesce(new.brand, ''));
  new.model := btrim(coalesce(new.model, ''));
  new.serial := btrim(coalesce(new.serial, ''));
  new.notes := btrim(coalesce(new.notes, ''));
  if new.install_year is not null and (new.install_year < 1900 or new.install_year > extract(year from now())::int + 1) then
    raise exception 'Install year % doesn''t look right.', new.install_year;
  end if;
  if (select property_code from rooms where id = new.room_id) is distinct from new.property_code then
    raise exception 'That room is in a different building.';
  end if;
  if (select company_id from equipment_types where id = new.equipment_type_id) is distinct from property_company(new.property_code) then
    raise exception 'That equipment type belongs to another company.';
  end if;

  if tg_op = 'INSERT' then
    if from_site then
      new.created_at := now(); new.created_by := auth.uid(); new.created_by_name := my_display_name();
      new.replaced_at := null; new.replaced_by_name := null;
    end if;
    return new;
  end if;

  if from_app and (new.id <> old.id or new.room_id <> old.room_id or new.property_code <> old.property_code
     or new.created_at is distinct from old.created_at or new.created_by is distinct from old.created_by
     or new.created_by_name is distinct from old.created_by_name) then
    raise exception 'That part of the equipment record can''t be changed.';
  end if;
  -- Marking it replaced stamps the time now, and is final.
  if old.replaced_at is not null then
    if from_app and new.replaced_at is distinct from old.replaced_at then
      raise exception 'Replaced equipment stays replaced.';
    end if;
  elsif new.replaced_at is not null and from_site then
    new.replaced_at := now(); new.replaced_by_name := my_display_name();
  end if;
  return new;
end;
$$;

drop trigger if exists guard_room_equipment_changes on room_equipment;
create trigger guard_room_equipment_changes
  before insert or update or delete on room_equipment
  for each row execute function guard_room_equipment_changes();

-- ── Change log (the room's room_events) ──────────────────────────────────────

create or replace function equipment_label(type_id uuid, yr int) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select name from equipment_types where id = type_id), 'Equipment')
         || ' (' || coalesce(yr::text, 'year needed') || ')';
$$;

create or replace function after_room_equipment_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  who uuid := auth.uid();
  who_name text := coalesce(my_display_name(), new.created_by_name, 'StoneAnchor');
  changes text[] := '{}';
begin
  if tg_op = 'INSERT' then
    insert into room_events (room_id, property_code, event_type, detail, actor_id, actor_name, created_at)
      values (new.room_id, new.property_code, 'equipment_added', equipment_label(new.equipment_type_id, new.install_year),
              new.created_by, coalesce(new.created_by_name, who_name), new.created_at);
    return null;
  end if;

  if new.replaced_at is not null and old.replaced_at is null then
    insert into room_events (room_id, property_code, event_type, detail, actor_id, actor_name)
      values (new.room_id, new.property_code, 'equipment_replaced', equipment_label(old.equipment_type_id, old.install_year), who, who_name);
  end if;
  if new.equipment_type_id <> old.equipment_type_id then
    changes := changes || ('type: ' || equipment_label(old.equipment_type_id, null) || ' → ' || equipment_label(new.equipment_type_id, null));
  end if;
  if new.install_year is distinct from old.install_year then
    changes := changes || ('installed: ' || coalesce(old.install_year::text, 'year needed') || ' → ' || coalesce(new.install_year::text, 'year needed'));
  end if;
  if new.brand <> old.brand then changes := changes || ('brand: ' || coalesce(nullif(new.brand, ''), '(none)')); end if;
  if new.model <> old.model then changes := changes || ('model: ' || coalesce(nullif(new.model, ''), '(none)')); end if;
  if new.serial <> old.serial then changes := changes || ('serial: ' || coalesce(nullif(new.serial, ''), '(none)')); end if;
  if new.warranty_until is distinct from old.warranty_until then
    changes := changes || ('warranty until: ' || coalesce(to_char(new.warranty_until, 'Mon DD, YYYY'), '(none)'));
  end if;
  if new.notes <> old.notes then changes := changes || 'notes changed'::text; end if;
  if cardinality(changes) > 0 then
    insert into room_events (room_id, property_code, event_type, detail, actor_id, actor_name)
      values (new.room_id, new.property_code, 'equipment_edited',
              equipment_label(new.equipment_type_id, new.install_year) || ' — ' || array_to_string(changes, '; '), who, who_name);
  end if;
  return null;
end;
$$;

drop trigger if exists after_room_equipment_change on room_equipment;
create trigger after_room_equipment_change after insert or update on room_equipment
  for each row execute function after_room_equipment_change();

-- ── Access rules ─────────────────────────────────────────────────────────────

create or replace function unit_type_company(t uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select company_id from unit_types where id = t;
$$;

drop policy if exists "equipment_types readable by company" on equipment_types;
create policy "equipment_types readable by company" on equipment_types
  for select using (is_executive() or in_my_company(company_id));
drop policy if exists "equipment_types insertable by editors" on equipment_types;
create policy "equipment_types insertable by editors" on equipment_types
  for insert with check (can_edit_unit_types(company_id));
drop policy if exists "equipment_types updatable by editors" on equipment_types;
create policy "equipment_types updatable by editors" on equipment_types
  for update using (can_edit_unit_types(company_id)) with check (can_edit_unit_types(company_id));

-- Both sides of a template row have to be in the same company.
drop policy if exists "unit_type_equipment readable by company" on unit_type_equipment;
create policy "unit_type_equipment readable by company" on unit_type_equipment
  for select using (is_executive() or in_my_company(unit_type_company(unit_type_id)));
drop policy if exists "unit_type_equipment insertable by editors" on unit_type_equipment;
create policy "unit_type_equipment insertable by editors" on unit_type_equipment
  for insert with check (can_edit_unit_types(unit_type_company(unit_type_id))
    and (select company_id from equipment_types where id = equipment_type_id) = unit_type_company(unit_type_id));
drop policy if exists "unit_type_equipment updatable by editors" on unit_type_equipment;
create policy "unit_type_equipment updatable by editors" on unit_type_equipment
  for update using (can_edit_unit_types(unit_type_company(unit_type_id)))
  with check (can_edit_unit_types(unit_type_company(unit_type_id))
    and (select company_id from equipment_types where id = equipment_type_id) = unit_type_company(unit_type_id));
drop policy if exists "unit_type_equipment deletable by editors" on unit_type_equipment;
create policy "unit_type_equipment deletable by editors" on unit_type_equipment
  for delete using (can_edit_unit_types(unit_type_company(unit_type_id)));

drop policy if exists "room_equipment readable by scope" on room_equipment;
create policy "room_equipment readable by scope" on room_equipment
  for select using (can_see_property(property_code) or can_work_tasks(property_code));
drop policy if exists "room_equipment insertable by workers" on room_equipment;
create policy "room_equipment insertable by workers" on room_equipment
  for insert with check (can_work_tasks(property_code));
drop policy if exists "room_equipment updatable by workers" on room_equipment;
create policy "room_equipment updatable by workers" on room_equipment
  for update using (can_work_tasks(property_code)) with check (can_work_tasks(property_code));

-- ── Adding a unit type's standard equipment ──────────────────────────────────
-- To every room of that type in a building (or just one room): only what's
-- missing — if a 1 Bedroom should have 1 refrigerator and already has one, it
-- gets none. Never removes or changes anything. Returns how many were added.
-- Not security definer, so the access rules above still apply.
create or replace function apply_unit_type_equipment(p_code text, p_unit_type uuid, p_room uuid default null) returns int
language plpgsql set search_path = public as $$
declare
  added int := 0;
  r record;
  t record;
  have int;
begin
  for r in select id from rooms where property_code = p_code and unit_type_id = p_unit_type and archived_at is null
             and (p_room is null or id = p_room) loop
    for t in select ute.equipment_type_id, ute.quantity from unit_type_equipment ute
              join equipment_types et on et.id = ute.equipment_type_id and not et.archived
             where ute.unit_type_id = p_unit_type loop
      select count(*) into have from room_equipment
       where room_id = r.id and equipment_type_id = t.equipment_type_id and replaced_at is null;
      if have < t.quantity then
        insert into room_equipment (room_id, property_code, equipment_type_id)
          select r.id, p_code, t.equipment_type_id from generate_series(1, t.quantity - have);
        added := added + (t.quantity - have);
      end if;
    end loop;
  end loop;
  return added;
end;
$$;

revoke all on function apply_unit_type_equipment(text, uuid, uuid) from public, anon;
grant execute on function apply_unit_type_equipment(text, uuid, uuid) to authenticated;
revoke all on function equipment_label(uuid, int) from public, anon;
grant execute on function equipment_label(uuid, int) to authenticated;

-- ── Removing a company also removes its equipment ────────────────────────────
-- Replaces the version in 01-rooms.sql (same steps, plus the equipment tables).
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
