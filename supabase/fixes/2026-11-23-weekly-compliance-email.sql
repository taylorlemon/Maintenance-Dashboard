-- Compliance reminder email: daily -> Mondays only (2026-11-23).
-- Already applied to live. Same time as before: 13:00 UTC = 7am Utah time in
-- summer (6am in winter). The job keeps its old name (compliance-daily-email).
-- Safe to re-run.

select cron.alter_job(jobid, schedule := '0 13 * * 1')
  from cron.job where jobname = 'compliance-daily-email';
