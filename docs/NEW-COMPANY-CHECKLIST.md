# Setting Up a New Company in StoneAnchor

Follow this each time a new company joins. Everything here is done on the StoneAnchor site
(my.stoneanchor.app), signed in as yourself (the Executive). It takes about an hour of your time, spread over a
few days while you wait on the company for information.

**Who does what**

| Who | Does |
|---|---|
| **You (Executive)** | Create the company, save its Asana key, add its buildings, run the health check, invite its first Admin |
| **The company's Admin** | Invites the rest of their staff and gives each person their buildings |
| **StoneAnchor itself** | Fills in a year of work order history for each new building, automatically, within the hour |

---

## Before your first outside company (one time only)

- [ ] **The multi-company version is live** on my.stoneanchor.app (go-live, step 8 of `docs/archive/MULTI-COMPANY-PLAN.md`).
- [ ] **Supabase Pro is on**, so the database is backed up every day. Other companies' data shouldn't be on the system without backups.
- [ ] **An agreement with the company** about their data (privacy, terms of use). This isn't a technical task, but it should exist before any real data arrives.
- [ ] **Sign-in and invite emails come from StoneAnchor** (reports@stoneanchor.app), not Supabase's generic sender.
      Set up once through Resend → Settings → Integrations → Supabase.

---

## Part 1: Collect from the company

Send them this list. You'll need everything here before Part 3.

| What | Example | Notes |
|---|---|---|
| Company name | Mesa Ridge Properties | Exactly how it should appear on screen |
| Each building's name | Oakmont Villas | |
| Each building's time zone | Arizona | So their daily emails count days correctly |
| Email address of their first Admin | dana@mesaridge.com | They'll invite everyone else |
| Their Asana key | (a long code) | See Part 2. **Never by plain email**: use a password-manager share, or have them read it to you on a call |

**You choose each building's short code** (like `MR-OAK`). It must be different from every other building in the
whole system, across all companies, so start each company's codes with the same two letters. For example,
Mesa Ridge would get `MR-OAK`, `MR-JUN` and so on.

---

## Part 2: What their Asana needs to have

StoneAnchor reads their Asana the same way it reads ours, so their Asana needs the same layout. Send them this
section as it is.

**For each building:**
- [ ] A **Work Orders** project (one task per work order, with due dates)
- [ ] A **Preventive Maintenance** list
- [ ] A **Room Turns** list with three sections whose names include **"Rent Ready"**, **"To Be Turned"** and **"Currently"**

**Shared across all their buildings:**
- [ ] One **Compliance** project, with **one section per building** (inspections, permits and certifications, with due dates)
- [ ] One **CapEx To-Dos** project, with **one section per building**. To-dos added in StoneAnchor are copied here.

**An Asana key** that StoneAnchor uses to read all of the above:
- [ ] Ideally they create a separate Asana login just for this (e.g. `stoneanchor@theircompany.com`) and give it access to every project above. That way the key isn't tied to an employee who might leave.
- [ ] Signed in as that login, they go to **app.asana.com/0/my-apps**, click **Create new token**, name it "StoneAnchor", and send you the code it shows (securely, see Part 1).

**Then collect these numbers from their Asana.** In Asana, open each one, use the "..." menu, then **Copy link**. The long
number at the end of the link is the ID.

| For | You need |
|---|---|
| Each building | Work Orders project ID, Preventive Maintenance ID, Room Turns ID, Compliance section ID |
| Each building | The **name** of its section on the CapEx To-Dos board, spelled exactly as in Asana |
| The company | The CapEx To-Dos project ID |

If the company would rather not dig these out, they can add you to their Asana and you can copy them yourself.

---

## Part 3: Create the company

1. Sign in at **my.stoneanchor.app**. On **Choose a Company**, click **+ Add a company** (under the list).
2. Fill in:
   - **Company name**
   - **Their Asana key**: paste it in. It's stored securely and **can never be shown again, not even to you**.
   - **Their CapEx To-Dos project ID**
3. Click **Create Company**. You're taken straight to the new company's **Admin → Company** page.

You can leave the key or project ID blank and add them later on **Admin → Company**. That's also where you rename
the company or **replace its Asana key** if it ever changes.

---

## Part 4: Add their buildings

1. Go to **Admin → Facilities → Add a Facility**. For each building, fill in:
   - **Name** and **Code** (your chosen short code)
   - **Time Zone**
   - the four **Asana IDs** from Part 2
   - the **CapEx To-Dos Section Name**, exactly as in Asana
2. Click **Add Facility**. It's added to the company you're working in.

Typed something wrong? Click **Edit** next to the building in the list above the form, fix it, and click **Save Changes**.
(The code itself can't be changed after it's added.)

---

## Part 5: Run the health check

Go to **Admin → Company → Run Health Check**. It checks, and shows a ✓ or ✗ for each:

- their **Asana key works**
- their **CapEx To-Dos board** opens
- **every building's Asana links** answer. If one doesn't, it tells you which ID to fix with **Edit**.
- the company has an **Admin** (this one stays ✗ until Part 6)
- everyone who isn't an Admin has at least one building
- nothing is linked to another company's buildings

**Fix anything marked ✗ and run it again.** Then click through the tabs for a quick look:

- [ ] **Work Orders:** each building's card shows open and overdue work orders, maintenance and room turns.
- [ ] **Building Compliance:** each building shows its compliance items.
- [ ] **Projects & CapEx:** make a test project, add a to-do, check it appears in **their** Asana under that building's
      section of the CapEx To-Dos board, then delete the test to-do and project.

---

## Part 6: Invite their first Admin

1. Go to **Admin → Users → Invite** and enter their first Admin's email.
2. They get an email from StoneAnchor with a link to set their password.
3. Once they've signed in, they show up in the Users list as an **Editor with no buildings**. That's
   deliberate: new logins start with no access.
4. Change their role to **Admin** and click **Save**.
5. **Run the health check one last time.** Everything should now be ✓.
6. Tell them they can invite the rest of their staff from **Admin → Users** and tick which buildings each person can
   see. Their Admins can only ever see and manage their own company.

---

## Part 7: The first few days

- [ ] **Their work order history fills itself in.** Within an hour of adding each building, StoneAnchor rebuilds its past
      year from Asana, so the trend charts aren't empty. (Days before the building was added are marked as rebuilt
      estimates; from then on the numbers are recorded as they happen.)
- [ ] **Next morning:** their Admins get the daily compliance email (only if something is overdue or due within a week;
      no email means nothing needs attention).
- [ ] **When a vendor contract is within 30 days of expiring:** their Admins get the contract alert.
- [ ] **On the 1st of the month:** their Admins get the monthly work order summary, one per building.
- [ ] **Check in with their Admin after a week** to see if anything looks wrong.

Their emails go only to **their** Admins. You get your own company's emails, not theirs.

---

## When a company leaves

Everything is on **Admin → Company → If This Company Leaves**, while working in that company.

1. **Pause the company** as soon as they cancel (or if a bill goes unpaid). Their people can still sign in but see a
   message that access is paused, nothing else, and their emails stop. Nothing is deleted. **Un-pause Company**
   gives everything back.
2. **Download All Their Data.** You get one zip file: a spreadsheet for each kind of record (buildings, people,
   projects, expenses, to-dos, budgets, vendors, contracts, work order history) plus every file they uploaded. Send it
   to them if your agreement says so, and keep a copy yourself.
3. **Remove the company permanently** when you're sure. Type the company's name in the box and click **Remove Company
   Permanently**. This only works once the company is paused. It deletes their logins, buildings, records, files and
   saved Asana key, and **can't be undone**. Their own Asana is never touched.

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
- **If their Asana key stops working** (e.g. the login it belongs to was removed), their tabs show Asana errors and the
  health check's "Asana accepts the key" turns ✗. Get a new key from them and paste it on **Admin → Company**.
- **Removing a single building** (rather than a whole company) only works if it has no projects or expenses, so
  nothing gets deleted by accident.
- **The walls between companies don't depend on setup.** They're the same rules for every company, tested every time
  they change. The health check is about whether *this* company's details are filled in correctly.
