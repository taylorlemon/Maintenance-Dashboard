# Security Audit — Row Level Security (RLS) and related access rules

Audit performed 2026-07-30 against the **live production database**
(project `yjrcosafkymedmownfny`), not just the checked-in `supabase-schema.sql`
file. Nothing was changed — this is a read-only report.

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

### 1. Editors and Viewers are locked out of every file — HIGH impact, but fails *safe*

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

### 2. The Asana work-orders proxy can be tricked into fetching other communities' data — MEDIUM

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

### 3. Every signed-in user can read every other user's email and role — LOW-MEDIUM

**What's wrong:** The `profiles` table is readable by anyone signed in.

**Effect:** A Viewer at one community can pull a list of every person with an
account, their email addresses, and their role. Not financial data, but it's a
staff directory that shouldn't be handed to everyone.

**Fix:** change the rule to "you can read your own row, and admins can read all
rows." I verified this is safe — the app only ever reads your own row, except on
the Admin screen, which only admins reach.

### 4. Every signed-in user can read who has access to what — LOW-MEDIUM

**What's wrong:** Same issue on the `profile_properties` table (the list of which
people are assigned to which facilities).

**Effect:** Combined with #3, any signed-in user can reconstruct your full org
chart — who works where. Again, not financial data.

**Fix:** same shape as #3, and same verification — safe to restrict.

### 5. Every signed-in user can read all facilities, including ones they can't access — LOW

**What's wrong:** The `properties` table is readable by anyone signed in. That
includes the Asana project IDs for communities the person has no access to.

**Effect:** Minor on its own — but those Asana IDs are exactly what finding #2
needs to be exploited, so the two combine.

**Fix:** restrict to assigned facilities. Slightly more delicate than #3/#4
because dropdowns are built from this list, so it needs a careful test pass.

### 6. The daily contract-alert email can be triggered by anyone — LOW

**What's wrong:** The `contract-alerts` function doesn't check who's calling it.
It's meant to be called once a day by the database's scheduler, but it can be
invoked by anyone who has the app's public key (which is, by design, public).

**Effect:** No data is returned to the caller — but someone could force the
"contracts expiring" email to send to all admins early. Nuisance, not a breach.

**Fix:** add a shared secret that the scheduled job passes and the function
checks.

### 7. Leaked-password protection is turned off — LOW, one toggle

Supabase can check new passwords against a database of known-breached passwords
and reject them. It's currently off. This is a single switch in the Supabase
dashboard, no code change.

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

There is still no staging environment (item #4 on `ROADMAP.md`), so **any change
to these rules applies to the live database immediately**. Fixing #1 in
particular changes what real users can do — it restores file access for your two
Editors — so it's worth doing at a moment when you can check the result right
away.
