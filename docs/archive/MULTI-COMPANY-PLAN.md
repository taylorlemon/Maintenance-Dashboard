# Multi-Company Plan — adding a "Company" level above buildings

Written 2026-10-28. This expands step 4 of `docs/ROADMAP.md` into a full plan. Update this
file as decisions change or steps get done.

**Progress (2026-10-31), all on the test copy and the local `multi-company` branch, nothing live yet:**
- Steps 0-4 done: the test project "StoneAnchor Test", three fake companies, the company walls
  (`supabase/multi-company/01-...sql`), each company's own Asana and emails (`02-...sql` + server functions).
- Step 5 done: the Executive company picker (added at Taylor's request), Admin tab touch-ups.
- Step 6: `supabase/test-data/check-walls.mjs` (the "try to cheat" check) passes 512 checks.
- Step 7: `docs/NEW-COMPANY-CHECKLIST.md` is written; a practice run on the test copy is still to do.
- The domain is done: **StoneAnchor** at my.stoneanchor.app; emails send from reports@stoneanchor.app.
- Still open: the manual backup method (Docker Desktop or Supabase Pro) before step 8.

**The one rule this whole plan exists to protect:** a person at one company must
never be able to see, change, or download anything belonging to another company,
whether by clicking around the site or by talking to the database directly. The
code is public on GitHub, so we have to assume someone *will* try the second one.
The database's own rules (RLS) are the wall; hiding things on screen is not.

---

## Decisions made (2026-10-27 / 28)

| Question | Decision |
|---|---|
| Who are the first outside companies? | Only companies Taylor reaches out to and sets up by hand. No public sign-up. |
| Asana | Each company has its own Asana, connected by Taylor by hand during setup. |
| Roles | Keep today's **Admin / Editor / Viewer**, fenced inside one company. No separate "Building Admin" role. |
| Emails | All of a company's emails go to **that company's Admins**, and only them. A company can have several Admins; each gets their own copy. |
| Taylor | A special **Executive** switch on Taylor's account only: sees every company and can switch between them. Separately, Taylor is an ordinary Admin of their own company and gets that company's emails, and no one else's. |
| Who adds/removes buildings | Only Taylor (Executive), since every building needs Asana set up by hand. |
| Vendors | Each company has its own separate vendor list. Nothing shared between companies, even the same plumber. |
| People in more than one company | Not allowed (except Taylor). Someone working for two companies gets two logins. |
| Testing | Build and test on a separate **test copy** first, using fake companies. Then add a small fake company to the real site as a final check before any real company joins. |
| Supabase Pro | Not yet. We use free alternatives for the safety net (see Step 1). |
| Domain name | Taylor can buy it. **Needed before a second company joins** (see "Blocker: email"). |

## What's true today (checked in the project files, 2026-10-28)

- **Admin is all-or-nothing.** Every access rule says "allowed if Admin, *or* if
  the building is on your list." The building checkboxes on an Admin do nothing.
- **Admins can change anyone's access, including their own:** roles, building
  lists, inviting and deleting logins, adding and removing buildings, deleting
  expenses.
- **Editors and Viewers are properly limited to their buildings,** enforced by
  the database (projects, expenses, to-dos, budgets, files, vendors, contracts,
  work order history, and Asana data through our server). They can't change
  their own access.
- **Every Admin gets every building's emails** (daily compliance, monthly work
  orders, contract expirations).
- **Things written into the code that only fit our company:**
  - one Asana key for everything (`ASANA_TOKEN`)
  - the CapEx to-do Asana board and its four section names (in `supabase/functions/asana-proxy`)
  - one shared "LPFM Compliance Tracking" Asana project
  - Utah time for every building (`America/Denver` in two email functions)
  - "Property Pulse" in email headers (to become StoneAnchor)
- **Caveat:** this was read from the project files, not the live database. A
  safety check blocked a direct look at the live database. Step 0 confirms the
  two match.

---

## How it will work when done

### Who can do what

| | **Executive** (Taylor only) | **Admin** | **Editor** | **Viewer** |
|---|---|---|---|---|
| Sees | Every company (switches between them) | Every building in **their own company** | Only their assigned buildings, inside their company | Same as Editor |
| Changes data | Anything | Anything in their company | Their buildings | Nothing |
| Invites/removes people | Anyone, into any company | Only into their own company | No | No |
| Changes someone's role/buildings | Anyone | People in their company, never themselves, never above Admin | No | No |
| Adds/removes buildings | Yes | No | No | No |
| Gets emails | Only as a normal Admin of their own company | Yes, for their company | No | No |

### The walls, in plain terms

1. **Every building belongs to exactly one company.** Every project, expense,
   to-do, budget, file, vendor, contract and work order record traces back to a
   company, either directly or through its building.
2. **Every person belongs to exactly one company** (Taylor too, as an Admin of
   their own company). The Executive switch sits on top of that.
3. **Every access rule checks the company first.** An Admin's power stops at
   their company's edge. Editors and Viewers get a double check: the building
   must be on their list *and* in their company. If someone's building list were
   ever wrong, they still couldn't cross into another company.
4. **Nobody can raise their own access.** The database itself refuses:
   - changing your own role, company, or building list
   - anyone but Taylor turning on the Executive switch. It can only be set
     directly in the database, never from the site.
   - an Admin moving someone into another company, or giving them a building
     from another company
   - an Admin removing the last Admin of their company, so a company can't lock
     itself out
5. **New logins start with no access.** When someone is invited, they belong to
   the inviting Admin's company and have no buildings until they're assigned
   some. If anything goes wrong mid-invite, the result is "sees nothing," never
   "sees everything."
6. **Each company's Asana key is locked away.** Keys are stored in Supabase's
   secure vault, readable only by our server functions, never by any page or
   person. The server only uses a company's key for that company's buildings.

---

## Blocker: email delivery (needs the domain)

Emails go out through Resend, which is still on its test sender. In test mode,
Resend **only delivers to the address that owns the Resend account.** So
today, Admins other than Taylor may already not be getting their copies.
For other companies' Admins to get anything, we need to:

1. Buy the domain (`stoneanchor.app`, roadmap step 2).
2. Verify it with Resend (a few settings at the domain seller; ~15 minutes).
3. Send from an address like `alerts@stoneanchor.app`.

This can happen any time before the first outside company joins. Doing it
early also fixes email for Admins in our own company.

---

## The steps

Each step is done and tested before the next starts. Steps 1–7 only touch the
**test copy**. The real site doesn't change until Step 8.

### Step 0 — Confirm the starting point (small, read-only)

- Look at the live database's access rules and roles, and confirm they match
  the project files. Read-only, but it needs Taylor's OK because it touches the
  live database.
- Check the old second Supabase project Taylor already has: what's in it, and
  whether it's safe to wipe and reuse as the test copy. The free plan allows two
  projects, so reusing it avoids deleting anything.

### Step 1 — Safety net, the free version

- **Test copy:** turn the second Supabase project into a copy of the real setup:
  same tables, same rules, same server functions, **fake data only**.
- **A switch for which database the site talks to:** a local copy of the site
  opened on Taylor's computer can be pointed at the test copy. The live website
  always uses the real database. Mixing them up must be impossible, so the test
  version shows a big "TEST" banner.
- **Manual backups:** without Pro there are no automatic backups. Before Step 8
  touches the real database, take a full manual backup using the Supabase
  command-line tool, saved somewhere safe on Taylor's computer, and confirm it
  can actually be restored (into the test copy). This also stays useful as a
  habit until Pro is turned on.

### Step 2 — Fake companies, all filled out

At least **two** fake companies are needed, because the whole point is proving
Company A can't see Company B:

- **"Mesa Ridge Properties"** (fake): 3 buildings, 2 Admins, 2 Editors with
  different building lists, 1 Viewer.
- **"Saguaro Living"** (fake): 2 buildings, 1 Admin, 1 Editor.
- Each gets realistic fake projects, expenses, to-dos, budgets, receipts and
  approval files, vendors with contracts, and work order history.
- Fake logins use email addresses Taylor controls (for example
  `taylor+mesa-admin@...`), so invite emails and alerts can be checked.
- Asana: a free Asana test workspace per fake company if practical. Otherwise
  the Asana parts get tested with one test workspace and two fake setups.

### Step 3 — Database changes (test copy)

- New **companies** table: name, plus that company's Asana settings and the
  location of its Asana key in the vault.
- Every **building** gets a company. Every **person** gets a company. Every
  **vendor** gets a company.
- New **Executive** switch on people, settable only directly in the database.
- **Every access rule rewritten** around the company (list below), plus the
  "can't raise your own access" guards.
- **Building codes** (like "CP") stay globally unique. Taylor sets up every
  building, so Taylor picks codes that don't clash (for example `MR-OAK`).

Everything that gets new rules, so nothing is missed: buildings, people,
people's building lists, projects, expenses, to-dos, yearly budgets, project
history log, vendors, vendors' building lists, vendor contracts, work order
daily history, and the three file folders (receipts, approvals, vendor
contracts).

### Step 4 — Server function changes (test copy)

- **asana-proxy:** looks up the building's company and uses *that* company's
  Asana key and settings. Today's hard-coded Cove Point board and section names
  move into the database as our company's settings.
- **manage-users (invites/removals):** an Admin can only invite into, and remove
  from, their own company. Taylor (Executive) picks the company.
- **compliance-alerts, work-order-stats, contract-alerts (emails):** each
  company's emails go only to that company's Admins, covering only that
  company's buildings. Each building gets its own time zone instead of
  assuming Utah.
- Email headers say StoneAnchor instead of Property Pulse (if the rename is ready).

### Step 5 — Screen changes (test copy)

- **Executive company switcher** (Taylor only): a dropdown at the top to pick
  which company you're looking at, with your own company as the default.
- **Admin tab:** an Admin sees and manages only their own company's people. The
  "add/remove building" controls show only for Taylor.
- Room for Taylor's Executive-only tools later (for example "set up a new
  company").
- Nothing changes for Editors and Viewers except that everything is fenced to
  their company.

### Step 6 — Prove the walls hold (test copy)

Two kinds of checks, both required to pass:

1. **Click-through checklist.** Log in as each fake person and confirm what
   they can and can't see and do, on every tab, including downloading files and
   exporting spreadsheets/PDFs. Each check is written as "as Mesa Editor 1, open
   Vendors, expect only Mesa vendors for Oak building."
2. **"Try to cheat" checks, automated.** A script logs in as each fake person
   and talks to the database **directly**, skipping the website, the way someone
   who read our public code could. It tries to read, change and delete the other
   company's data, raise its own role, move itself to another company, and
   download the other company's files. **Every attempt must be refused.** The
   script is kept in the project and re-run before any future change to access
   rules goes live.

Anything that leaks gets fixed and the full set of checks re-run, not just the
one that failed.

### Step 7 — Final review before going live

- Walk Taylor through the results in plain language.
- Re-read every new access rule one more time against the decisions table.
- Write the "how to set up a new company" checklist (Step 9) and test it once
  on the test copy by setting up a third fake company from scratch.

### Step 8 — Go live (real database)

1. Pick a quiet time and warn our own staff.
2. Take and verify a fresh **manual backup** (Step 1).
3. Apply the changes. Our existing company is created, and all four current
   buildings, all current people and all vendors are placed in it. Current
   Admins stay Admins **of our company** and stop seeing anything else (today
   there *is* nothing else, so nobody notices). Taylor's Executive switch is
   turned on.
4. Deploy the updated server functions.
5. Push the site update.
6. Add one small **fake company** to the real database, with one fake Admin and
   one fake Editor, and run the "try to cheat" script against the real site.
   This is the final proof. The fake company can stay as a permanent test
   company (hidden from everyone but Taylor) to re-run checks in the future.
7. Check our own company still works normally: tabs load, Asana shows up, and
   the next morning's emails arrive.

**If something goes wrong:** the site update can be undone in a minute (git).
The database changes would be undone from the manual backup, which is why that
backup gets test-restored in Step 1, before it's ever needed.

### Step 9 — First real company

A written checklist Taylor follows each time:

1. Create the company (name).
2. Connect their Asana: their key goes into the vault, and their project and
   section IDs go into their settings.
3. Add their buildings (codes, names, time zones, Asana IDs).
4. Invite their first Admin, who can then invite the rest of their staff.
5. Log in as the fake test company and run the "try to cheat" script once more.
6. Confirm their Admins receive the next day's emails.

---

## Separate, but worth doing

- **Domain name** (roadmap step 2): needed for emails before Step 9, and gives
  the site its proper StoneAnchor address. It can be done any time, independent of
  everything else here.
- **Supabase Pro** (when Taylor is ready): automatic daily backups would replace
  the manual backup routine, and leaked-password protection gets turned on.
  Especially worth it once outside companies' data is in the system.
- **Public GitHub repository:** once other companies' data is involved, consider
  making the repository private. The walls don't depend on the code being
  secret, but there's no reason to hand out the blueprints. Free private
  hosting options exist.
- **Terms/privacy agreement** with each company about their data. Not a
  technical task, but it should exist before real data arrives.

## Not in this plan (on purpose)

- Public self sign-up, and billing/charging companies
- People belonging to more than one company (other than Taylor)
- A separate "Building Admin" role
- Replacing Asana with a built-in work order system
- Sharing vendors between companies

## Biggest risks, and how this plan handles them

| Risk | Handling |
|---|---|
| One access rule gets missed and leaks data | Full list of what needs rules (Step 3), plus an automated "try to cheat" script that tests every one directly (Step 6) |
| Someone raises their own access | Database-level guards, tested by the script |
| The change breaks our own company's live site | Built and tested on a test copy first; manual backup that has been test-restored; quick undo of the site |
| One company's Asana key used for another's buildings | Keys stored per company in the vault; the server looks up the company from the building every time; tested in Step 6 |
| Emails sent to the wrong company | Email recipients chosen per company; fake companies with Taylor-controlled addresses show exactly who receives what |
| No automatic backups (no Pro yet) | Manual backup before the go-live step, verified by actually restoring it |
