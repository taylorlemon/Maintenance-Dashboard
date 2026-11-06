-- New buildings start on StoneAnchor, not Asana (2026-11-06). Run after
-- 03-switch-off-asana.sql. Safe to re-run.
--
-- New companies don't get Asana at all any more, so a building added from now
-- on starts with task_source = 'stoneanchor' and its standard task lists made
-- for it straight away (the same ones "Set up the standard lists" makes, plus
-- Compliance Tracking). Buildings already in the database keep whatever they
-- have. A building added with Asana IDs filled in (Admin -> Facilities ->
-- "Asana settings") still starts on Asana.

alter table properties alter column task_source set default 'stoneanchor';

create or replace function make_starter_task_lists() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  l_id uuid;
begin
  if new.task_source <> 'stoneanchor' then return null; end if;
  if exists (select 1 from task_lists where property_code = new.code) then return null; end if;

  insert into task_lists (property_code, name, kind, sort_order) values (new.code, 'Work Orders', 'work_orders', 0) returning id into l_id;
  insert into task_sections (list_id, name, sort_order) values
    (l_id, 'Work Order Requests', 0), (l_id, 'Work Orders Active', 1), (l_id, 'Work Orders On Hold', 2),
    (l_id, 'Work Orders Outsourced', 3), (l_id, 'Work Order Projects', 4);

  insert into task_lists (property_code, name, kind, sort_order) values (new.code, 'Preventative Maintenance', 'pm', 1) returning id into l_id;
  insert into task_sections (list_id, name, sort_order) values (l_id, 'PM Tasks', 0);

  insert into task_lists (property_code, name, kind, sort_order) values (new.code, 'Room Turns', 'room_turns', 2) returning id into l_id;
  insert into task_sections (list_id, name, sort_order) values (l_id, 'Rooms to be Turned', 0), (l_id, 'Rent Ready Rooms', 1);

  insert into task_lists (property_code, name, kind, sort_order) values (new.code, 'Compliance Tracking', 'compliance', 3) returning id into l_id;
  insert into task_sections (list_id, name, sort_order) values (l_id, 'Compliance', 0);
  return null;
end;
$$;

drop trigger if exists make_starter_task_lists on properties;
create trigger make_starter_task_lists after insert on properties
  for each row execute function make_starter_task_lists();
