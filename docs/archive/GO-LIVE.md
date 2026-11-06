# Go-Live Plan: Multi-Company StoneAnchor

Step 8 of `docs/archive/MULTI-COMPANY-PLAN.md`. Everything below has already been built and tested on the test copy
("StoneAnchor Test"). This puts it on the live site. Takes about an hour; done together with Claude Code.

## What changes for people using the site

- **Lionel staff:** nothing they'll notice, apart from "Lionel Partners — Facilities Management" above the title.
  Same buildings, same data, same logins. Nobody needs to sign in again.
- **Lionel Admins other than Taylor:** the Admin tab's Facilities section disappears (only the Executive manages
  buildings now). Everything else on their Admin tab works as before.
- **Taylor:** becomes the Executive and lands on **Choose a Company** after signing in. At first it lists Lionel Partners
  plus the hidden internal test company.
- **Emails:** unchanged. Lionel's Admins keep getting Lionel's emails.

## Before starting

- [ ] Docker Desktop is installed and running (the whale icon in the taskbar is steady, not animating).
- [ ] The test copy passes every check (`check-walls.mjs`: 570 checks).

## The steps

| # | Step | Who | What you'll see |
|---|---|---|---|
| 1 | **Back up the live database** into `Documents\StoneAnchor backups\<date>\` (structure, data and logins) and check the copy has every row | Claude Code | Three backup files in that folder |
| 2 | **Apply the four database changes** (`supabase/multi-company/01` → `04`) | Claude Code | Nothing yet: the old site keeps working on the new database (see "Undoing it"). Don't invite anyone until step 5 is done: an invite sent in between would land in no company |
| 3 | **Confirm** Lionel Partners exists with all 4 buildings, every login and every vendor in it | Claude Code | A short report |
| 4 | **Turn on the Executive switch** for taylor@lionelpartners.com | Claude Code | — |
| 5 | **Deploy the new server functions** (Asana, logins, three emails) | Claude Code | — |
| 6 | **Publish the new site.** All the multi-company work becomes one new save point on `main` (without the test scripts, which stay on this computer), pushed to GitHub | Claude Code | my.stoneanchor.app updates within ~5 minutes |
| 7 | **Live safety check.** Creates the hidden "StoneAnchor Internal Test" company and runs the cheat check against the live site; every attempt must be refused | Claude Code | "0 failed" |
| 8 | **Click through** as yourself: Choose a Company → Lionel Partners → every tab → Admin → Company → Run Health Check | Taylor | Everything loads; health check all ✓ |
| 9 | **Next morning:** the daily compliance email arrives as usual; the hourly work order history kept running overnight | Taylor + Claude Code | The usual email |

## Undoing it

The database changes are built so the **old** site and server functions still work on the **new** database: Lionel
is simply the one company. So most problems are undone without touching the data:

- **Site problem:** put the previous version of the site back (one git step, live in ~5 minutes).
- **Server function problem:** redeploy the previous versions (a minute).
- **Database problem:** restore from the step 1 backup. This is the last resort, which is why the backup is taken and
  checked first.

## After go-live

- Replace the Executive login's password with a long unique one if it isn't already, since it now sees every company.
- Upgrade to **Supabase Pro** (daily automatic backups) and make the GitHub repository **private** once the first paying
  customer is in. Until then, take a manual backup (step 1) before any database change.
