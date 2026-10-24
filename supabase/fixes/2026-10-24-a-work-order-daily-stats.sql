-- Work order daily history (2026-10-24): one saved row per facility per day,
-- filled in by the work-order-stats Edge Function (supabase/functions/
-- work-order-stats). The Work Orders tab's trend chart and weekly history
-- table read this instead of asking Asana live every time, which is slow.
--
-- Same text as the "Work order daily history" section at the bottom of
-- supabase-schema.sql. Safe to re-run.
--
-- Before the schedule at the bottom can work, the work-order-stats function
-- must be deployed, and the same random value set in two places — as the
-- function's STATS_SECRET, and in the database Vault under the name
-- "work_order_stats_secret" (the schedule reads it from the Vault, so the
-- value never has to be written into this public repository).

create table if not exists work_order_daily_stats (
  property_code text not null references properties(code) on delete cascade,
  stat_date date not null,
  added integer not null default 0,              -- work orders created that day
  completed integer not null default 0,          -- work orders completed that day
  open_count integer not null default 0,         -- still open at the end of the day
  overdue_count integer not null default 0,      -- open and past their due date
  completed_days_total numeric not null default 0, -- sum of created-to-completed days for that day's completions
  is_estimate boolean not null default false,    -- true = rebuilt after the fact, not recorded on the day
  updated_at timestamptz not null default now(),
  primary key (property_code, stat_date)
);

alter table work_order_daily_stats enable row level security;

-- Read-only from the app: same facility scoping as every other table. There
-- are deliberately no insert/update/delete policies — only the Edge Function
-- writes here, using the service role key, which isn't subject to these rules.
drop policy if exists "work_order_daily_stats readable by scope" on work_order_daily_stats;
create policy "work_order_daily_stats readable by scope" on work_order_daily_stats
  for select using (is_admin() or property_code in (select my_property_codes()));

-- Hourly schedule. Minute 10 of every hour; each run rewrites today's and
-- yesterday's rows, so the last run before midnight effectively closes out
-- the day. timeout_milliseconds is raised from pg_net's 5-second default so
-- the database doesn't give up on the call before the function finishes.
select cron.unschedule('work-order-daily-stats')
  where exists (select 1 from cron.job where jobname = 'work-order-daily-stats');

select cron.schedule(
  'work-order-daily-stats',
  '10 * * * *',
  $$
  select net.http_post(
    url := 'https://yjrcosafkymedmownfny.functions.supabase.co/work-order-stats',
    headers := jsonb_build_object(
      'x-stats-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'work_order_stats_secret'),
      'Content-Type', 'application/json'
    ),
    body := '{"mode":"recent"}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
