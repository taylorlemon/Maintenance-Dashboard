-- Add asana_task_gid to todos (2026-08-12): stores the Asana task id created
-- for a to-do (see js/capex.js addProjectTodo / asana-proxy's
-- createCapexTodoTask action), so checking a to-do off here can also mark
-- that Asana task complete.
--
-- Nullable — to-dos created before this change (and any where the Asana
-- sync itself failed) simply have no stored link, so completing them here
-- won't try to reach Asana for those.
--
-- Safe to re-run.

alter table todos add column if not exists asana_task_gid text;
