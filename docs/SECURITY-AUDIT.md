# Security Audit — Row Level Security (RLS) and related access rules

## Second audit — 2026-11-27 (security and "can it go down?")

Re-checked everything added since July (companies, Tasks, Rooms, Housekeeping,
live updates) on the live database, plus the server functions, page code, git
history, GitHub settings and scheduled jobs. Break-in suites: `check-walls`
572/572 and `check-rooms-housekeeping` 858/858 on TEST, and `check-live --live`
56/56. Live and TEST have identical rules and functions (fingerprints compared).
Backup taken first: `Documents\StoneAnchor\Backups\2026-11-27 before security hardening`.

| # | Finding | Status |
|---|---|---|
| 9 | **Signed-out visitors could overload the database.** Every rule applied to signed-out visitors too, and refusing them meant checking every row: 7.4 s for work orders, 12.4 s for history. A few dozen requests could stall the site. | ✅ Fixed (`fixes/2026-11-27-a-faster-access-checks.sql`): rules are signed-in only, so it now takes 0.08 ms to refuse |
| 10 | **Read rules got slower with every work order.** They checked permission per row: 1.7 s to open CP's biggest list, against an 8 s limit. | ✅ Fixed (same file): checked once per request. 93 ms |
| 11 | No upload size limit | ✅ Receipts 50 MB (two are 43 MB), other folders 25 MB |
| 12 | Contract-expiration job gave up after 5 s (timed out 2026-11-27) | ✅ Now waits 2 min like the others. Its 2 pending contracts are in White Door (no Admins), so no email is expected |
| 13 | The page loaded "latest 2.x" of supabase-js with no tamper check | ✅ Pinned to 2.119.2, with integrity fingerprints on all four CDN files |
| 14 | One receipt list didn't escape file names (not exploitable: storage rejects `<>"`) | ✅ Escaped |
| 15 | TEST was behind live on `my_display_name` and `search_tasks` | ✅ Synced |
| 16 | Public sign-up was on (anyone could make a login and trigger emails) | Taylor: Authentication → Sign In / Providers → "Allow new users to sign up" off |
| 17 | No two-step login on GitHub / Supabase / Cloudflare / Resend / email | Taylor |
| 18 | No automatic backups; leaked-password protection | ⏸️ Needs Supabase Pro |

**Rule for future database scripts:** new or re-created rules must say
`to authenticated`. Read rules on big tables should compare against
`my_readable_lists()`, `my_visible_codes()` or `my_room_codes()` written as
`(select f())::type[]`, not call a check per row. A script that drops and
re-creates one of the rules above undoes finding 9 or 10 for that rule.
Re-running the 2026-11-27 fix file afterwards puts it back.

Checked and fine: all tables have RLS on; no secrets anywhere in git history
(only the public anon keys); GitHub secret scanning and push protection are on,
and Pages enforces HTTPS; the scheduled functions require their secret; and
`manage-users` and `asana-proxy` check the caller's identity and role before acting.

---

Audit performed 2026-07-30 against the **live production database**
(project `yjrcosafkymedmownfny`), not just the checked-in `supabase/schema.sql`
file.

## Status — all findings fixed except one dashboard toggle

| # | Finding | Status |
|---|---|---|
| 1 | Storage rules locked Editors/Viewers out of all files | ✅ Fixed & verified |
| 2 | Asana proxy request check could be bypassed | ✅ Fixed & deployed |
| 3 | Everyone could read all users' emails and roles | ✅ Fixed & verified |
| 4 | Everyone could read the who-works-where map | ✅ Fixed & verified |
| 5 | Everyone could read all facilities incl. Asana ids | ✅ Fixed & verified |
| 6 | Contract-alert email callable by anyone | ✅ Fixed & verified |
| 7 | Leaked-password protection disabled | ⏸️ **Blocked — needs Supabase Pro** |
| 8 | Housekeeping notes | ℹ️ No action needed |

Fixes applied to the live database live in `supabase/fixes/` and have been
folded back into `supabase/schema.sql` so re-running it won't undo them.

**Also worth knowing:** this repository is **public** on GitHub (required for
free GitHub Pages hosting). Nothing sensitive is in it — the Supabase anon key
is designed to be public, and there's no service-role key or Asana token
committed — but it does mean the database rules audited here are the *only*
thing protecting your data. The `ALERT_SECRET` from finding #6 was deliberately
kept out of git for this reason.

## What "RLS" means here

Your page's JavaScript is not a real lock on the data. Anyone signed in can open
their browser's developer tools and ask the database for anything. The actual
lock is a set of rules stored inside Supabase itself, called Row Level Security
(RLS) — rules like *"a user can only read expense rows for properties they're
assigned to."* This audit checks whether those rules actually say what we think
they say.

## The good news first

I checked these against the live database and they are all correct:

- **All 10 tables have RLS turned on.** Nothing is sitting unprotected.
- **No leftover "everyone can do everything" policies.** Earlier versions of the
  schema had permissive `full access for staff` rules. I confirmed they are
  genuinely gone from the live database, not just deleted in the file.
- **All 3 file buckets are private** (receipts, approvals, vendor-contracts) —
  none are publicly downloadable.
- **Signed-out visitors can read nothing at all.**
- **Viewers genuinely cannot change anything** — not just hidden buttons; the
  database itself refuses their writes.
- **Nobody can promote themselves.** A regular user cannot change their own role
  to admin, and cannot assign themselves extra facilities. This is the single
  most important thing to get right, and it's right.
- **The project history log is genuinely append-only** — no one can edit or
  delete past entries, including admins.
- **The indirect checks are correct** — e.g. a contract's visibility correctly
  follows from its vendor's property, and a log entry's from its project's.

## Findings

### 1. Editors and Viewers are locked out of every file — HIGH impact, but fails *safe* — ✅ FIXED

**What's wrong:** The storage rules for all three file buckets contain a
copy-paste-style mistake. They were meant to check the *uploaded file's folder*
against the project it belongs to. Instead they accidentally check the
*project's title*.

In practice the rule compares a project's ID (`0242feea-e38d-…`) against a
folder name derived from its title (`"Front door replacement"`). Those can never
match. I confirmed this on live data: **zero rows match, ever**.

**Effect:** Admins are unaffected (a separate part of the rule lets them
through). But **every Editor and Viewer is silently unable to see, open, upload,
or delete any receipt, approval proof, or vendor contract.** They'd see empty
file lists and failed uploads with no clear explanation.

You have 1 admin and 2 editors today — so this is likely affecting 2 real people
right now, and you wouldn't have noticed because you're the admin.

**Why it's not a leak:** the mistake makes the rule *too strict*, not too loose.
No data is exposed. It's a broken-functionality bug living in the security layer.

**Fix:** one word per rule — tell it to read the file's name rather than the
project's name. Nine rules total (3 buckets × read/upload/delete).

### 2. The Asana work-orders proxy can be tricked into fetching other communities' data — MEDIUM — ✅ FIXED

**What's wrong:** The `asana-proxy` server-side function is supposed to confirm
that every Asana request belongs to a community you're allowed to see. It does
this by scanning the requested web address for ID numbers and checking those.

The problem is it scans for *any* ID anywhere in the address, rather than
checking the ID that actually determines what gets returned. So a request like
`/tasks/<someone else's task>?project=<a project I AM allowed to see>` passes the
check — the proxy sees an allowed ID and waves it through — but Asana then
returns the other community's task.

**Effect:** An Editor at one community could read individual work-order tasks
belonging to another community, and could list every Asana project in the
workspace. They'd need to already know a task's ID number (a 16-digit number,
not practically guessable), so this is a real gap but not a wide-open door.

**Fix:** replace the "scan for any ID" check with a short list of the four
address shapes the app actually uses, and validate the ID that actually matters
in each. The app only ever makes four kinds of request, so this is a tight,
low-risk change.

### 3. Every signed-in user can read every other user's email and role — LOW-MEDIUM — ✅ FIXED

**What's wrong:** The `profiles` table is readable by anyone signed in.

**Effect:** A Viewer at one community can pull a list of every person with an
account, their email addresses, and their role. Not financial data, but it's a
staff directory that shouldn't be handed to everyone.

**Fix:** change the rule to "you can read your own row, and admins can read all
rows." I verified this is safe — the app only ever reads your own row, except on
the Admin screen, which only admins reach.

### 4. Every signed-in user can read who has access to what — LOW-MEDIUM — ✅ FIXED

**What's wrong:** Same issue on the `profile_properties` table (the list of which
people are assigned to which facilities).

**Effect:** Combined with #3, any signed-in user can reconstruct your full org
chart — who works where. Again, not financial data.

**Fix:** same shape as #3, and same verification — safe to restrict.

### 5. Every signed-in user can read all facilities, including ones they can't access — LOW — ✅ FIXED

**What's wrong:** The `properties` table is readable by anyone signed in. That
includes the Asana project IDs for communities the person has no access to.

**Effect:** Minor on its own — but those Asana IDs are exactly what finding #2
needs to be exploited, so the two combine.

**Fix:** restrict to assigned facilities. Slightly more delicate than #3/#4
because dropdowns are built from this list, so it needs a careful test pass.

### 6. The daily contract-alert email can be triggered by anyone — MEDIUM (worse than first assessed) — ✅ FIXED

**What's wrong:** The `contract-alerts` function doesn't check who's calling it.
It's meant to be called once a day by the database's scheduler.

**Worse than first assessed:** while applying the fixes I checked the function's
deployed settings and found it has sign-in verification switched *off*
(`verify_jwt: false`). So it wasn't merely callable by anyone holding the app's
public key — it was callable by **anyone on the internet who knew the URL**, with
no credential at all. Internally it runs with full database privileges.

**Effect:** No data is returned to the caller beyond a count — but someone could
force the "contracts expiring" email to all admins at will, or hammer it to
exhaust the email service's free quota so genuine alerts stop being delivered.

**Fix:** the function now requires a long random shared secret in an
`x-alert-secret` header, which only the scheduled job knows. Verified: calls with
no secret and with a wrong secret are refused; the scheduled job's own call still
succeeds. The secret is stored as a Supabase function secret and deliberately not
committed, since this repository is public.

**Fix:** add a shared secret that the scheduled job passes and the function
checks.

### 7. Leaked-password protection is turned off — LOW — ⏸️ BLOCKED (needs Supabase Pro)

Supabase can check new passwords against a database of known-breached passwords
and reject them. It's currently off.

Checked 2026-07-30: this is a **paid-plan feature**, not available on the free
tier, so it's deferred rather than skipped. Worth turning on whenever you upgrade
— which per `docs/ROADMAP.md` is a question of *when*, not *if*, since the free tier
also has no automatic backups. Note it's the weakest of the findings; everything
that actually gated access to data has been fixed.

Until then, the practical substitute is simply telling anyone you invite not to
reuse a password from another site.

### 8. Housekeeping notes — informational only

- Supabase's linter flags four internal helper functions as callable directly.
  Three of them (`is_admin`, `is_editor`, `my_property_codes`) only ever report
  facts about *you* to *you*, so there's nothing to leak. **Important:** do not
  "fix" these by revoking access — the security rules themselves depend on
  calling them, so revoking would break everything. The fourth
  (`handle_new_user`) can't actually be run this way in practice.
- An expense or to-do can technically be linked to a project at a different
  property. Doing so requires knowing an ID you aren't allowed to read, so it's a
  data-tidiness issue rather than a security one.

## Suggested order to fix

1. **#1 (storage lockout)** — it's actively breaking things for 2 real users
   today, and the fix is small and well understood.
2. **#3, #4** — small, safe, and close a real (if modest) information leak.
3. **#2 (Asana proxy)** — the most genuinely security-relevant item, but needs
   the most careful testing since it touches the Work Orders tab.
4. **#5, #6, #7** — cleanup, whenever convenient.

## Important caveat about applying these fixes

There is still no staging environment (item #4 on `docs/ROADMAP.md`), so **any change
to these rules applies to the live database immediately**. Fixing #1 in
particular changes what real users can do — it restores file access for your two
Editors — so it's worth doing at a moment when you can check the result right
away.
