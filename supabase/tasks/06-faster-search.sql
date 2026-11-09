-- Faster work order search (2026-11-09).
--
-- search_tasks used to let the row rules decide, one task (and one note) at a
-- time, whether the person could see it — thousands of the same check per
-- search, about 1.3 seconds for a 1,600-task building, and timeouts on slow
-- connections. Now it asks once per list (can_read_list, the exact rule the
-- tasks and task_notes tables use), then searches only those lists' tasks.
-- Who sees what is unchanged: Staff only their kinds of list, Editors and
-- Viewers only their buildings, nobody another company's.
--
-- security definer so the per-row rules don't run again; can_read_list still
-- runs as the person asking (auth.uid() reads their sign-in).
-- Safe to run again.

create or replace function search_tasks(p_codes text[], q text) returns setof tasks
language sql stable security definer set search_path = public as $$
  with pattern as (
    select '%' || replace(replace(replace(btrim(q), '\', '\\'), '%', '\%'), '_', '\_') || '%' as p
  ),
  readable as (
    select l.id from task_lists l
     where l.property_code = any(p_codes) and can_read_list(l.id)
  )
  select t.* from tasks t, pattern
   where t.list_id in (select id from readable)
     and t.property_code = any(p_codes)
     and btrim(q) <> ''
     and (t.room ilike pattern.p or t.title ilike pattern.p or t.details ilike pattern.p
          or exists (select 1 from task_notes n where n.task_id = t.id and n.body ilike pattern.p))
   order by t.created_at desc
   limit 300;
$$;

revoke all on function search_tasks(text[], text) from public, anon;
grant execute on function search_tasks(text[], text) to authenticated;
