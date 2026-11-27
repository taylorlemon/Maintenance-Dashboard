-- 2026-11-27 security audit fixes (docs/SECURITY-AUDIT.md, findings 9-11).
-- Safe to run more than once. Run on TEST first, then the check scripts, then LIVE.
--
-- 1. Signed-out visitors get no access rules at all.
--    Every rule used to apply to "public" (signed-in AND signed-out), and the
--    signed-out ones were refused only after the database checked every single
--    row. Asking for all work orders took 7.4 seconds of database work, so
--    anyone on the internet could tie the database up and take the site down.
--    Now every rule applies only to signed-in people; a signed-out request
--    gets an empty answer instantly. Nothing on the site reads data while
--    signed out (the login, invite and password screens use Supabase's login
--    service, not these tables).
--
-- 2. "Can this person see it?" is worked out once per request, not per row.
--    The read rules on the big and growing tables called a permission check
--    for every row (1.7 seconds to open CP's biggest list). They now compare
--    against a list worked out once: the lists / buildings this person can see.
--    Those lists come from the very same checks as before (can_read_list,
--    can_see_property, can_work_tasks), so who can see what is unchanged.
--
-- 3. Upload size caps: receipts 50 MB (two are already 43 MB), the other
--    folders 25 MB.
--
-- IMPORTANT for later scripts: any script that re-creates one of these rules
-- (drop policy ... create policy ...) undoes this for that rule. New rules
-- should say "to authenticated" and use the my_* lists below; or just re-run
-- this file afterwards.

-- ---------------------------------------------------------------------------
-- The once-per-request lists
-- ---------------------------------------------------------------------------

-- Task lists this person can read (same rule as can_read_list).
create or replace function my_readable_lists()
returns uuid[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(l.id), '{}') from task_lists l where can_read_list(l.id);
$$;

-- Buildings whose office data (CapEx, expenses, work order numbers) this
-- person can see (same rule as can_see_property).
create or replace function my_visible_codes()
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(code), '{}') from properties where can_see_property(code);
$$;

-- Buildings whose rooms and housekeeping this person can see (the same
-- "can_see_property OR can_work_tasks" the room rules used).
create or replace function my_room_codes()
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(code), '{}') from properties where can_see_property(code) or can_work_tasks(code);
$$;

revoke all on function my_readable_lists() from public, anon;
revoke all on function my_visible_codes()  from public, anon;
revoke all on function my_room_codes()     from public, anon;
grant execute on function my_readable_lists() to authenticated;
grant execute on function my_visible_codes()  to authenticated;
grant execute on function my_room_codes()     to authenticated;

-- ---------------------------------------------------------------------------
-- Read rules rewritten to use them. "(select f())" is what makes the database
-- work the list out once per request instead of once per row.
-- ---------------------------------------------------------------------------

-- Work orders and everything hanging off them.
alter policy "tasks readable by scope"         on tasks         using (list_id = any ((select my_readable_lists())::uuid[]));
alter policy "task_lists readable by scope"    on task_lists    using (id = any ((select my_readable_lists())::uuid[]));
alter policy "task_sections readable by scope" on task_sections using (list_id = any ((select my_readable_lists())::uuid[]));
alter policy "task_events readable by scope"   on task_events   using (exists (select 1 from tasks t where t.id = task_events.task_id and t.list_id = any ((select my_readable_lists())::uuid[])));
alter policy "task_notes readable by scope"    on task_notes    using (exists (select 1 from tasks t where t.id = task_notes.task_id  and t.list_id = any ((select my_readable_lists())::uuid[])));
alter policy "task_photos readable by scope"   on task_photos   using (exists (select 1 from tasks t where t.id = task_photos.task_id and t.list_id = any ((select my_readable_lists())::uuid[])));

-- Office data.
alter policy "work_order_daily_stats readable by scope" on work_order_daily_stats using (property_code = any ((select my_visible_codes())::text[]));
alter policy "expenses readable by scope"       on expenses       using (property_code = any ((select my_visible_codes())::text[]));
alter policy "todos readable by scope"          on todos          using (property_code = any ((select my_visible_codes())::text[]));
alter policy "projects readable by scope"       on projects       using (property_code = any ((select my_visible_codes())::text[]));
alter policy "annual_budgets readable by scope" on annual_budgets using (property_code = any ((select my_visible_codes())::text[]));

-- Rooms and housekeeping.
alter policy "rooms readable by scope"              on rooms              using (property_code = any ((select my_room_codes())::text[]));
alter policy "room_aliases readable by scope"       on room_aliases       using (property_code = any ((select my_room_codes())::text[]));
alter policy "room_equipment readable by scope"     on room_equipment     using (property_code = any ((select my_room_codes())::text[]));
alter policy "room_events readable by scope"        on room_events        using (property_code = any ((select my_room_codes())::text[]));
alter policy "cleanings readable by scope"          on cleanings          using (property_code = any ((select my_room_codes())::text[]));
alter policy "cleaning_schedules readable by scope" on cleaning_schedules using (property_code = any ((select my_room_codes())::text[]));

-- ---------------------------------------------------------------------------
-- Every rule (tables and uploaded files): signed-in people only.
-- ---------------------------------------------------------------------------
do $$
declare p record;
begin
  for p in select schemaname, tablename, policyname from pg_policies
            where schemaname in ('public', 'storage') and roles::text <> '{authenticated}'
  loop
    execute format('alter policy %I on %I.%I to authenticated', p.policyname, p.schemaname, p.tablename);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Upload size caps.
-- ---------------------------------------------------------------------------
update storage.buckets set file_size_limit = 52428800 where id = 'receipts';
update storage.buckets set file_size_limit = 26214400 where id in ('approvals', 'vendor-contracts', 'task-files');
