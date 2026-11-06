-- Daily 6am work order email (tasks-digest Edge Function). Runs every hour at
-- the top of the hour; the function itself picks the buildings where it's
-- 6am (or a missed morning before noon) and never sends a building twice in a
-- day (task_digest_sends, in 01-tasks.sql). Uses the same Vault secret as the
-- other daily emails.
--
-- LIVE project only (the URL below is the live one). Safe to re-run.

select cron.unschedule('tasks-daily-email')
  where exists (select 1 from cron.job where jobname = 'tasks-daily-email');

select cron.schedule(
  'tasks-daily-email',
  '0 * * * *',
  $$
  select net.http_post(
    url := 'https://yjrcosafkymedmownfny.functions.supabase.co/tasks-digest',
    headers := jsonb_build_object(
      'x-stats-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'work_order_stats_secret'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
