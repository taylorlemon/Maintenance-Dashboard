# Setting Up a New Company in StoneAnchor

Follow this each time a new company joins. Everything here is done on the StoneAnchor site
(my.stoneanchor.app), signed in as yourself (the Executive). It takes about half an hour, plus a short wait while
their first Admin sets a password.

New companies don't use Asana at all. Their work orders, preventative maintenance, room turns and compliance items
live in StoneAnchor's own lists, which are set up automatically for every building you add.

**Who does what**

| Who | Does |
|---|---|
| **You (Executive)** | Create the company, add its buildings, invite its first Admin, run the health check |
| **The company's Admin** | Invites the rest of their people (office staff as Admin, Editor or Viewer; techs and front desk as Staff) and gives each person their buildings |
| **StoneAnchor itself** | Sets up each building's lists, sends the daily and monthly emails, and records the work order numbers every hour |

---

## Before your first outside company (one time only)

- [x] **The multi-company version is live** on my.stoneanchor.app (done 2026-10-31).
- [ ] **Supabase Pro is on**, so the database is backed up every day. Other companies' data shouldn't be on the system without backups.
- [ ] **An agreement with the company** about their data (privacy, terms of use). This isn't a technical task, but it should exist before any real data arrives.
- [ ] **Sign-in and invite emails come from StoneAnchor** (reports@stoneanchor.app), not Supabase's generic sender.
      Set up once through Resend → Settings → Integrations → Supabase.

---

## Part 1: Collect from the company

| What | Example | Notes |
|---|---|---|
| Company name | Mesa Ridge Properties | Exactly how it should appear on screen |
| Each building's name | Oakmont Villas | |
| Each building's time zone | Arizona | So their daily emails and due dates count days correctly |
| Their first Admin's name and email | Dana Whitfield, dana@mesaridge.com | They'll invite everyone else |

**You choose each building's short code** (like `MR-OAK`). It must be different from every other building in the
whole system, across all companies, so start each company's codes with the same two letters. For example,
Mesa Ridge would get `MR-OAK`, `MR-JUN` and so on.

---

## Part 2: Create the company

1. Sign in at **my.stoneanchor.app**. On **Choose a Company**, click **+ Add a company** (under the list).
2. Type the **Company name** and click **Create Company**. Leave "Asana settings" closed. You're taken straight to the
   new company's **Admin → Company** page.

You can rename the company there later.

---

## Part 3: Add their buildings

1. Go to **Admin → Facilities → Add a Facility**. For each building, fill in its **Name**, **Code** and **Time Zone**.
   Leave "Asana settings" closed.
2. Click **Add Facility**. It's added to the company you're working in, and its **Work Orders, Preventative
   Maintenance, Room Turns and Compliance Tracking** lists are created automatically.

Typed something wrong? Click **Edit** next to the building, fix it, and click **Save Changes**.
(The code itself can't be changed after it's added.)

---

## Part 4: Invite their first Admin

1. Go to **Admin → Users → Invite**, enter their first Admin's **name** and **email**, and click **Invite**.
2. They get an email from StoneAnchor with a link to set their password.
3. Once they've signed in, they show up in the Users list as an **Editor with no buildings**. That's
   deliberate: new logins start with no access.
4. Change their role to **Admin** and click **Save**.
5. Tell them to invite the rest of their people from **Admin → Users**, ticking which buildings each person can see:
   - **Admin, Editor or Viewer** for office staff, who use the full dashboard.
   - **Staff** for maintenance techs and front desk. They only see their buildings' Work Orders, PM and Room Turns,
     and they get the 6am work order email.

---

## Part 5: Run the health check

Go to **Admin → Company → Run Health Check**. It shows a ✓ or ✗ for each of these:

- the company has buildings, and each one has its Work Orders, PM and Room Turns lists
- the company has an **Admin** (stays ✗ until Part 4 is done)
- everyone who isn't an Admin has at least one building
- nothing is linked to another company's buildings

**Fix anything marked ✗ and run it again.** Then click through for a quick look:

- [ ] **Work Orders → Lists:** each building has its lists. Add a test work order, check it off, and Undo.
- [ ] **Work Orders → Numbers & charts:** each building's card loads (all zeros at first is normal).
- [ ] **Building Compliance:** each building's card loads.

---

## Part 6: The first few days

- [ ] **Every hour,** StoneAnchor records each building's work order numbers, so the trend charts fill in from day one.
- [ ] **Every morning at 6am** (building time), their Staff get the work order email, only when something is urgent,
      overdue or due today.
- [ ] **Every morning,** their Admins get the compliance email, only if something is overdue or due within a week.
- [ ] **When a vendor contract is within 30 days of expiring,** their Admins get the contract alert.
- [ ] **On the 1st of the month,** their Admins get the monthly work order summary, one per building.
- [ ] **Check in with their Admin after a week** to see if anything looks wrong.

Their emails go only to **their** people. You get your own company's emails, not theirs.

---

## When a company leaves

Everything is on **Admin → Company → If This Company Leaves**, while working in that company.

1. **Pause the company** as soon as they cancel (or if a bill goes unpaid). Their people can still sign in but only
   see a message that access is paused, and their emails stop. Nothing is deleted. **Un-pause Company** gives
   everything back.
2. **Download All Their Data.** You get one zip file with a spreadsheet for each kind of record plus every file they
   uploaded. Send it to them if your agreement says so, and keep a copy yourself.
3. **Remove the company permanently** when you're sure. Type the company's name in the box and click **Remove Company
   Permanently**. This only works once the company is paused. It deletes their logins, buildings, records and files,
   and **can't be undone**.

Your own company can't be paused or removed.

---

## Adding another Executive (e.g. an assistant)

On purpose, there's no button on the site for this. Even someone who stole a password can't make themselves an
Executive. It takes about two minutes in the Supabase dashboard:

1. On StoneAnchor, while working in **your own company**, invite them on **Admin → Users** like anyone else. Wait for
   them to set their password, then make them an **Admin** there.
2. Go to **supabase.com/dashboard**, open the **CapEX Dashboard** project, and click **Table Editor** in the left sidebar.
3. Open the **profiles** table and find their row by email address.
4. Click their **is_executive** cell, set it to **true**, and save.
5. They sign out and back in, and see **Choose a Company** with every company.

To take Executive access away later, set the same cell back to **false**. An Executive belongs to your company and
gets your company's emails, like you.

---

## Good to know

- **Only you can add, change or remove buildings, and change a company's settings.** Their Admins can't.
- **A person belongs to one company.** Someone who works for two companies needs two logins (with different email addresses).
- **A company can't lose its last Admin.** The system refuses to remove or demote them until someone else is an Admin.
- **Nothing in the work order lists can be deleted,** by anyone. Mistakes are cancelled with a reason and stay on record.
- **Removing a single building** (rather than a whole company) only works if it has no projects or expenses, so
  nothing gets deleted by accident.
- **The walls between companies don't depend on setup.** They're the same rules for every company, tested every time
  they change. The health check is about whether *this* company's details are filled in correctly.
- **Older buildings still on Asana** (the "Asana settings" links) are covered in the git history of this file, from
  before 2026-11-06.
