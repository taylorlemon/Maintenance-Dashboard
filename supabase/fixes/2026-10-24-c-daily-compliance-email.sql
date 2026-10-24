-- Daily building compliance reminder (2026-10-24): every morning, the
-- compliance-alerts Edge Function emails every Admin one message per facility
-- that has compliance items overdue or due within 7 days (facilities with
-- nothing outstanding get no email). Uses the same Vault secret as the work
-- order history schedules.
--
-- 13:00 UTC = 7am Utah time in summer (6am in winter).
--
-- Same text as the "Daily compliance reminder email" section at the bottom of
-- supabase-schema.sql. Safe to re-run.

select cron.unschedule('compliance-daily-email')
  where exists (select 1 from cron.job where jobname = 'compliance-daily-email');

select cron.schedule(
  'compliance-daily-email',
  '0 13 * * *',
  $$
  select net.http_post(
    url := 'https://yjrcosafkymedmownfny.functions.supabase.co/compliance-alerts',
    headers := jsonb_build_object(
      'x-stats-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'work_order_stats_secret'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
