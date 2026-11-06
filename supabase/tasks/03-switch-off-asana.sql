-- Switching a building off Asana (2026-11-06). Run after 01-tasks.sql. Safe
-- to re-run.
--
-- properties.task_source says where a building's work orders, PM, room turns
-- and compliance tasks live:
--   'asana'       (default) the dashboard reads Asana, as it always has
--   'stoneanchor' everything reads StoneAnchor's own task lists instead:
--                 the Work Orders tab cards, the hourly work-order-stats job
--                 (trend chart, history, monthly email), the Building
--                 Compliance tab and its daily email; the Lists view opens to
--                 everyone at the building; CapEx to-dos stop being copied
--                 into Asana.
-- Flipped per building by the Executive in Admin -> Facilities (the existing
-- "properties updatable by executive" rule). Flipping back undoes it all;
-- nothing is deleted either way.

alter table properties add column if not exists task_source text not null default 'asana';
alter table properties drop constraint if exists properties_task_source_check;
alter table properties add constraint properties_task_source_check check (task_source in ('asana', 'stoneanchor'));
