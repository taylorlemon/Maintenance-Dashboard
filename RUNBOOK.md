# CapEX Dashboard — What To Do When Things Break

A short, plain-language guide for the two situations most likely to actually
happen: the site is down, or something looks wrong with the data. Written
2026-08-11. Update it if the setup described below changes (e.g. once a
staging environment or Supabase Pro exists — see `ROADMAP.md`).

## First, know what you're dealing with

- **The website** (what people type into their browser) is hosted for free by
  GitHub Pages, at whatever address is set up under the repository's
  Settings → Pages.
- **The data** (properties, projects, expenses, vendors, logins) lives in
  Supabase, a separate hosted service — project reference `yjrcosafkymedmownfny`.
- These are two different services. One can be down while the other is fine.

## The site won't load at all

1. Try it from a different device or your phone's cellular data (rules out
   "it's just my wifi/computer").
2. Check GitHub's own status page: https://www.githubstatus.com — if GitHub
   Pages is down, there's nothing to fix on our end; it resolves on its own.
3. Check the repository's Actions/Pages deployment status on GitHub — a red X
   there means the last push failed to publish. Tell Claude Code what you see
   and it can look at what broke.
4. If GitHub itself is fine, the problem is more likely in the page's code —
   tell Claude Code "the site won't load" and describe what you see (a blank
   page? an error message? Ask it to check first — do not paste error text
   containing anything that looks like a password or long random code).

## The site loads, but no one can log in

1. Go to the Supabase dashboard for this project → **Authentication** → confirm
   the service shows as healthy (no banner/warning at the top).
2. Check Supabase's own status page: https://status.supabase.com
3. Confirm the person trying to log in has actually been invited (an
   administrator adds their email under the Admin tab first — logging in
   before that won't work, by design).
4. If one specific person can't log in but others can, it's likely a
   password issue on their end — use "forgot password" first before treating
   it as an outage.

## Data looks wrong, missing, or corrupted

1. **Don't panic-edit.** Changes made while investigating can make it harder
   to tell what happened.
2. Check who last touched the record — the app timestamps most changes.
3. Note: there is **no automatic backup today**. The free Supabase tier
   doesn't include them (see `ROADMAP.md`'s cost table — this is the main
   reason an upgrade to Supabase Pro is worth doing before it's urgent, not
   after). Until then, there is no "restore to yesterday" button — a serious
   data-loss event would mean rebuilding the record by hand from other
   sources (emails, Asana, paper receipts).
4. If you suspect someone saw or changed data they shouldn't have had access
   to, that's a security question, not just a data question — see
   `SECURITY-AUDIT.md` for how permissions are supposed to work, and flag it
   so the relevant rule can be checked.

## The site is slow

1. Confirm it's not just your connection (try another network).
2. Check the Supabase dashboard's usage numbers — if the project is near the
   free tier's limits (see `ROADMAP.md`'s cost table), that can cause slowness
   as a warning sign before anything actually breaks.
3. A free Supabase project also **pauses itself after a week with no
   activity** — if the site has sat unused, the first load afterward can be
   slow while it wakes back up. This is a free-tier limitation, not a bug.

## Scheduled jobs and emails

These run on their own, on Supabase's servers — nobody has to have the site
open. All times are Utah time (an hour earlier in winter).

| Job | When | What it does | How you'd notice it stopped |
|---|---|---|---|
| Work order history (`work-order-stats`) | Every hour, 10 past | Saves each building's work order numbers for the day | The "Saved from Asana …" line under the Work Orders history list shows an old time |
| Daily compliance reminder (`compliance-alerts`) | Every day, ~7am | Emails each Admin, per building, about compliance items overdue or due within 7 days. No email for a building that's all clear | A building shows overdue items on the Building Compliance tab, but no email arrived that morning |
| Contract expiration alert (`contract-alerts`) | Every day, ~7am | Emails Admins once about vendor contracts within 30 days of expiring | A contract is near or past its expiration date on the Vendors tab and nobody was emailed |
| Monthly work order report (`work-order-stats`) | 1st of each month, ~7am | Emails each Admin, per building, last month's summary with an Excel file attached | No report on the 1st |

**If one seems to have stopped:** tell Claude Code which one and what you
noticed. It can check the job's last result directly (the database keeps the
last few hours of each job's response) and re-run it by hand.

**Email limit to know about:** until the Tendwell domain is set up and
verified with Resend (see `ROADMAP.md` step 2), emails are sent from Resend's
test address, which only reliably reaches the address that owns the Resend
account (Taylor's). Other Admins may not receive them.

**Lesson learned (2026-10-24):** the contract-expiration alert had been
failing silently every day since roughly August, after the vendors table
changed shape and the job wasn't updated with it. Nobody noticed because
"no email" looks the same as "nothing to report". When a change touches a
table, it's worth checking whether any scheduled job reads it.

## Who to notify

Fill this in once decided — currently informal (Taylor is the main admin;
there are two Admin logins as of 2026-10-24).

## Related documents

- `ROADMAP.md` — the overall plan, including what's already been fixed and
  what's still deferred (like backups) and why.
- `SECURITY-AUDIT.md` — what protects the data today, and the one item
  (leaked-password protection) still waiting on a paid plan upgrade.
