# Property Pulse — Growth & Robustness Plan

Started 2026-07-30, last updated 2026-10-24. This is a living planning document —
update it as decisions get made or priorities change, rather than keeping that
context only in chat history.

**The goal (as of 2026-10-24):** get Property Pulse ready to roll out to other
buildings at other companies — more robust, faster, and feeling like a real app.

## Where things stand today

- **The site:** `index.html` plus companion files (`js/` for each tab's logic,
  `css/styles.css` for the look). No build step — opens directly in a browser.
- **Hosting:** free on GitHub Pages, at `taylorlemon.github.io/Maintenance-Dashboard`.
  Every push to the `main` branch goes live within a minute or two — there's
  still **no test copy of the site**.
- **Data:** Supabase (database + logins + file storage), project
  `yjrcosafkymedmownfny`, on the **free plan — no automatic backups**. The
  GitHub repository is public, so the database's permission rules (RLS) are the
  only thing protecting the data — see `SECURITY-AUDIT.md`.
- **Server-side jobs (Edge Functions):** `asana-proxy` (talks to Asana for the
  page), `contract-alerts` (daily contract expiration email), `compliance-alerts`
  (daily compliance reminder email), `manage-users` (Admin tab invites), and
  `work-order-stats` (hourly work order history + monthly email). What runs
  when, and how to tell if one stopped: `RUNBOOK.md` → "Scheduled jobs and
  emails". Claude can deploy these directly via the Supabase CLI.
- **Email:** sent through Resend, still on its test sender
  (`onboarding@resend.dev`). Until a domain is verified (step 2 below), Resend
  only delivers to the address that owns the Resend account — other Admins may
  not receive the monthly reports, compliance reminders or contract alerts.
- **Everything is built for one company.** Admins see every building, there's a
  single Asana connection shared by all buildings, and some Cove Point–specific
  details are written into the code (e.g. the Asana section names for CapEx
  to-dos in `supabase/functions/asana-proxy`).

## Next up — plan of record

Agreed order, 2026-10-24. Each step makes the next one safer.

### 1. Treat Asana work order names as plain text — security fix — ✅ Done 2026-10-24

Work order names, room-turn notes, building names and error messages are now
shown as plain text, so text from Asana can never run as code in the
dashboard ("cross-site scripting"). See the done log.

### 2. Own domain name + installable phone app — next up

**Name decided:** the product is being renamed **Tendwell**. Buy `tendwell.com`
(and `tendwell.app` to protect it, optional) — ~$10–20/year each — and point
GitHub Pages at it: free, and it comes with HTTPS (the padlock). Doing this also:
- lets us verify the domain with Resend, which fixes the email limit above
  (monthly reports and contract alerts reach every Admin)
- gives the app a real address to share with other companies

Before buying: check the name isn't already in use by another product (domain
and trademark). Logins and invite emails will need their allowed web address
updated in Supabase when the domain changes.

**Being findable online:** a domain alone won't put Property Pulse in search
results — the dashboard is behind a login, so search engines can't see it. That
needs a simple public front page (what it is, who it's for, a sign-in button).

**Installable app ("Progressive Web App"):** add an app icon, app name, and a
small file that makes the site load fast. People open the site and tap "Add to
Home Screen" — it gets its own icon and opens full-screen like a normal app. No
App Store, no $99/year Apple fee, no review process. If App Store / Google Play
listings are wanted later, the same site can be wrapped into a store app.

### 3. Safety net: staging (test) environment + Supabase Pro

**Staging:** a second, separate copy of the site — a second Supabase project
holding sample data, plus a second web address — where changes get tried out
before they touch the real site. Changes get tested there first, then promoted
to the real site once confirmed good.

**Supabase Pro (~$25/month):** turns on daily backups (none exist today) and
leaked-password protection (`SECURITY-AUDIT.md` #7). Taylor has committed to
upgrading — just not yet — and will say when. When that happens: confirm
backups are actually on, turn on leaked-password protection, and update this
file and `RUNBOOK.md` (both say no backups exist).

**Why before step 4:** step 4 rewrites every permission rule on live data.
That should be proven on a test copy first, with backups in place in case
anything goes wrong.

### 4. Company level above buildings (multi-company)

The biggest change on this list. Starts with a **dedicated planning session**
before any building. What it involves:

- **A "Company" layer:** buildings and users belong to a company; nobody ever
  sees another company's data. Taylor sits above all companies as the overall
  owner.
- **Company admins:** someone at each company who can invite and manage their
  own staff without Taylor doing it.
- **Per-company settings instead of code:** each company's own Asana
  connection and Asana section names; each building's time zone (the work
  order history currently assumes Utah time for every building).
- **Every permission rule rewritten** to separate companies from each other.

Questions for the planning session:
- Who are the customers — separate property management companies, each with
  their own Asana account?
- How does a new company get set up — Taylor sets it up, or they sign up?
- Will companies be charged, and how?
- What's the agreement with them about their data (privacy, terms of use)?
- Should the code stay in a public GitHub repository once outside companies'
  data is involved? (Free hosting options exist for private repositories too.)
- **The Asana question — the biggest one for market size.** Today every
  customer would need Asana, set up exactly like ours. Options: (1) stay
  Asana-based but let each company map its own Asana setup (recommended
  starting point, 2026-10-24); (2) build Tendwell's own simple work order
  system so Asana isn't required; (3) connect to several systems (Asana,
  AppFolio, etc.). Test with one or two friendly companies before deciding.

**Name:** the product is being renamed **Tendwell** (chosen 2026-10-24) —
`tendwell.com` for the public page, `app.tendwell.com` for the dashboard.

### Smaller known issues (fix along the way)

- **Counting limits:** the "Avg Days to Complete (30d)" number on each card,
  and the Room Turns lists, only ever look at the first 100 items Asana sends
  back. A busier building would quietly get wrong numbers. (The work order
  history table counts everything correctly — this is only the cards.)
- **Consistent look:** colors are now one system (done 2026-10-24). Still to
  do: fonts (three typefaces, including a typewriter-style one in ~40 places),
  and a clear "loading / failed — try again" state on every tab.
- **Graph's dashed "net" line:** the dotted line on the work order graph is a
  running total that's capped at zero, so it usually sits flat on the bottom
  and doesn't tell you much. Either make it meaningful or remove it.

## Done log

### 2026-10-24 (later) — Security fix, new colors, compliance emails, contract alerts fixed
- **Asana text shown as plain text** (roadmap step 1) — verified with a booby-
  trapped task name that ran code before the fix and doesn't after.
- **New color system** (green and gold): one brand color, a colorblind-checked
  gold/green pair for charts and CapEx, and status colors used only for
  good / watch / problem. All defined once at the top of `css/styles.css`.
- **Daily compliance reminder email:** every morning, each Admin gets one email
  per building with compliance items overdue or due within 7 days.
- **Contract expiration alerts fixed** — they had never successfully sent. The
  job read a vendor column removed in the multi-community change, and sent one
  message to all Admins at once (rejected under Resend's test sender). Now
  reads `vendor_properties` and emails each Admin separately; a contract only
  counts as alerted once someone actually received the email.
- `RUNBOOK.md` now lists every scheduled job and how to tell if one stopped.

### 2026-10-24 — Work order history, faster trend chart, backups of the history
- **Trend chart now loads in about a second** instead of waiting on Asana. A new
  `work-order-stats` Edge Function saves one row per building per day (added,
  completed, open, overdue, days-to-complete) into the `work_order_daily_stats`
  table, every hour. Two years were rebuilt from Asana's records; those rebuilt
  days are marked "≈" on screen and "Rebuilt from Asana (estimate)" in files.
- **History section under the chart:** four headline numbers that follow the
  chosen range and compare with the period before, then a month → week → day
  list that opens one level per click.
- **Fixed:** the chart's range buttons were being reset by the CapEx / Admin tab
  toggles, which broke the chart's next load.
- **Download history button** (Admins and Editors): the building being viewed,
  for a chosen time range, as an Excel file.
- **Monthly email:** on the 1st of each month, every Admin gets one email per
  building covering the month that just ended, with an Excel file attached.
  First real run: 2026-11-01. Check the second Admin actually receives theirs
  (see the email limit under "Where things stand").
- Details: `supabase/fixes/2026-10-24-a-*.sql` and `-b-*.sql`.

### 2026-07-30 to 2026-09 — Foundations
- **Supabase CLI access** — Claude can push database and Edge Function changes
  directly instead of Taylor copy-pasting into the Supabase website.
- **Code split into files** (`js/shared.js`, one file per tab, `css/styles.css`)
  — no behavior change; makes each tab safer and cheaper to change.
- **Permission (RLS) audit** — see `SECURITY-AUDIT.md`. Six issues found and
  fixed; leaked-password protection deferred (needs Pro).
- **Error tracking (Sentry)** and an incident guide (`RUNBOOK.md`).

## Cost roadmap

| Item | Free tier limit | Cost once you outgrow it |
|---|---|---|
| Supabase Pro plan | — | ~$25/month — turns on **daily backups** (none exist today), removes the "project pauses after a week idle" risk, unlocks leaked-password protection (`SECURITY-AUDIT.md` #7), raises every limit below |
| Database size | 500 MB | Included up to 8 GB on Pro. The work order history adds only a few hundred KB a year — not a concern |
| File storage (contracts, receipts) | 1 GB | Included up to 100 GB on Pro, then ~$0.021/GB/month — the one to actually watch, since PDFs/photos add up faster than data rows |
| Bandwidth ("egress") | 2 GB/month | Included up to 250 GB/month on Pro, then ~$0.09/GB |
| Outgoing email (Resend) | Free for a few thousand emails/month | Fine for now; needs a verified domain (step 2) to reach every Admin |
| Custom domain (step 2) | — | ~$12–20/year |
| Apple App Store listing (optional, later) | — | $99/year — not needed for the installable web app |
| Error monitoring (Sentry) | Free tier | Likely $0 for a while |

**The real trigger point isn't storage — it's backups.** Upgrade to Pro before
other companies' data is on the system, not when a storage number turns red.

## Reusable prompts for future sessions

- *"I bought tendwell.com — set up the domain, rename the app to Tendwell, and
  verify the domain with Resend so emails reach every Admin."*
- *"Make the site an installable app (home-screen icon, full-screen, fast to load)."*
- *"Set up a staging Supabase project and staging deployment, and describe how to
  promote a tested change to production."*
- *"Let's plan the company level above buildings — walk me through the questions
  in ROADMAP.md step 4."*
- *"Pull current Supabase storage and database usage and tell me how close we are
  to the free-tier limits."*
