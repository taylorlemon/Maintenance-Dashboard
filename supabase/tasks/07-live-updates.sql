-- Live updates (js/live.js): turns on Supabase Realtime for tasks and their
-- notes and photos, so every open dashboard hears about a change straight
-- away instead of waiting for a refresh. Realtime only sends each browser the
-- rows its person is allowed to read (the same access rules as everywhere
-- else), so no building's tasks reach anyone outside it.
-- Safe to run more than once.

do $$
declare t text;
begin
  foreach t in array array['tasks', 'task_notes', 'task_photos'] loop
    if not exists (select 1 from pg_publication_tables
                    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end;
$$;
