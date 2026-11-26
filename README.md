# StoneAnchor

The maintenance, CapEx and compliance dashboard at **my.stoneanchor.app**.

## Where it runs (none of it on this computer)

| Piece | Lives on | What it does |
|---|---|---|
| The website | GitHub Pages | Serves the files in this folder. Pushing to `main` updates the live site within a minute or two. |
| Data, logins, photos, receipts | Supabase (project `yjrcosafkymedmownfny`) | The database and its security rules, file storage, and the server functions below. |
| Emails | Resend, sent by Supabase | 6am work orders, Monday compliance, contract expirations, monthly work order history. |
| stoneanchor.app | Cloudflare | The web address. |

There's also a separate **StoneAnchor Test** Supabase project. Opening `index.html` straight from this folder
uses it automatically (with an orange TEST banner), so changes can be tried without touching live data.

## What's in this folder

| Path | What it is |
|---|---|
| `index.html` | The page itself: every screen's layout. |
| `css/styles.css` | Colors, fonts and layout. |
| `js/` | What the page does, one file per area: `shared.js` (sign-in, the Maintenance / Projects & CapEx / Compliance tabs and their switch rows, the ⚙ Admin button, buildings), `workorders.js`, `tasks.js` (work order lists, PM, room turns, the Compliance Tracking list on the Compliance tab, the Staff screen), `capex.js`, `vendors.js`, `compliance.js`, `live.js` (live updates: open screens redraw when someone else changes a task), `rooms.js` (Maintenance → Rooms and Equipment: each room's profile, full history and equipment, plus the building's equipment overview; also on the Staff screen), `admin.js`, `company-report.js` (the summary PDF in a company's data download), `xlsx-writer.js` (Excel downloads). |
| `images/` | Logo and browser-tab icon. |
| `help/staff.html` | The printable quick-start for techs and front desk (the Help link on their screen; my.stoneanchor.app/help/staff.html). |
| `supabase/schema.sql` | The original database setup. Later changes are in the folders next to it. |
| `supabase/fixes/` | Dated one-off database changes, oldest first. |
| `supabase/multi-company/` | The company level above buildings (walls between companies, Executive tools). |
| `supabase/tasks/` | StoneAnchor's own work orders: lists, notes, history, the 6am email schedule, the Asana switch. |
| `supabase/rooms/` | Maintenance → Rooms and Equipment: each building's room list, unit types, other spellings and change log (01), the equipment in each room with equipment types and unit-type standard equipment (02), and the counts behind the "Most work orders" panel (03). |
| `supabase/functions/` | Server functions: emails, the work order numbers job, user invites, the Asana connection and import. |
| `supabase/test-data/` | Test scripts and fake data. Kept on this computer only (never published). |
| `docs/` | How-to guides and plans (below). |
| `CNAME` | Tells GitHub Pages to answer at my.stoneanchor.app. Must stay here. |
| `CLAUDE.md` | Working rules for Claude Code. Must stay here. |

## Guides (`docs/`)

| File | When to read it |
|---|---|
| `docs/RUNBOOK.md` | The site is down or something looks wrong. |
| `docs/NEW-COMPANY-CHECKLIST.md` | Setting up a new company. |
| `docs/ROADMAP.md` | What's planned next and what's been done. |
| `docs/SECURITY-AUDIT.md` | How the access rules were checked, and what's still open. |
| `docs/archive/` | Finished plans, kept for the record. |

## Passwords and keys

None are in this folder (it's public on GitHub). Test logins and keys are in
`Documents\StoneAnchor\Developer files`. Live keys are stored in Supabase.
