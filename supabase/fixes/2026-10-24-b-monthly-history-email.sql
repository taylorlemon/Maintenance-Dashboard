-- Monthly work order history email (2026-10-24): on the 1st of each month,
-- the work-order-stats Edge Function emails every Admin one message per
-- facility covering the month that just ended, with that month's day-by-day
-- numbers attached as a spreadsheet file — a backup copy of the history kept
-- outside Supabase. Uses the same Vault secret as the hourly schedule.
--
-- 13:00 UTC = 7am Utah time in summer (6am in winter) — after midnight's
-- hourly run has finalized the last day of the month.
--
-- Same text as the end of the "Work order daily history" section of
-- supabase-schema.sql. Safe to re-run.

select cron.unschedule('work-order-monthly-email')
  where exists (select 1 from cron.job where jobname = 'work-order-monthly-email');

select cron.schedule(
  'work-order-monthly-email',
  '0 13 1 * *',
  $$
  select net.http_post(
    url := 'https://yjrcosafkymedmownfny.functions.supabase.co/work-order-stats',
    headers := jsonb_build_object(
      'x-stats-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'work_order_stats_secret'),
      'Content-Type', 'application/json'
    ),
    body := '{"mode":"monthly-email"}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
