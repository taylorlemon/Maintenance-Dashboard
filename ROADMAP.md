# CapEX Dashboard — Growth & Robustness Plan

Written 2026-07-30. This is a living planning document — update it as decisions get
made or priorities change, rather than keeping that context only in chat history.

## Where things stand today

- The whole application is one file, `index.html` (currently 3,899 lines) — the
  structure, the visual styling, and all the logic for every tab are mixed together
  in it.
- It's hosted for free on GitHub Pages, and every push to the `main` branch goes
  live immediately — there's no test copy of the site.
- Data lives in Supabase (a hosted database + login system + file storage). There's
  a `supabase-schema.sql` file and two small server-side scripts ("Edge Functions") —
  one for contract expiration alerts, one that talks to Asana — but none of it is
  currently connected to a tool that lets changes be pushed automatically. Today,
  any database or Edge Function change has to be copy-pasted by hand into the
  Supabase website.
- Everyone using the site so far has been using the free tier of Supabase, which has
  no automatic backups and fairly small storage/data limits.

## Plan of record

### 1. Set up Supabase CLI access (removes the copy-paste step)

**What this involves:** installing a small command-line tool ("CLI") for
Supabase, and a one-time step where you generate an access credential on the
Supabase website and hand it to me. After that, I can push database and Edge
Function changes directly instead of preparing text for you to paste by hand.

**Why moved to first:** you asked for this to happen before anything else,
since it's the direct fix for the copy-paste hassle you're running into right
now. One tradeoff to have in mind: until the staging environment (#4 below)
exists, any change I push through the CLI goes straight to the live production
database — same as editing `index.html` today, just without the manual paste
step. I'll still tell you exactly what a change does and ask before running
anything that alters real data or structure.

### 2. Split the code into separate files (no framework, no build step)

**What changes:** `index.html` stays as the entry point, but the JavaScript
(the logic — what happens when you click things, how data loads and saves) moves
out into a handful of companion files grouped by feature, e.g.:

- `js/shared.js` — the Supabase connection, and helpers used by every tab
- `js/workorders.js`, `js/vendors.js`, `js/admin.js`, `js/capex.js` — one file per tab
- `css/styles.css` — the visual styling, separated from the logic

`index.html` just points to these files with simple tags — no installer, no
package manager, no "build" step. You'd still be able to open the page the same
way you do now.

**Why it's worth doing:**
- **Reliability:** a change to one tab is much less likely to accidentally break a
  different tab (this is what happened when the permissions overhaul broke Work
  Orders) once the code for each tab is physically separated.
- **Efficiency:** when you ask me to change something on, say, the Vendors tab, I'll
  only need to open the one small Vendors file instead of searching through all
  3,900 lines every time — fewer tokens spent per request, faster turnaround.

**Risk:** low. This is a reorganization, not a behavior change — every feature
should look and work identically afterward. Still a "big" change per our process
below (own branch, full manual test pass before merging).

### 3. Audit Supabase's Row Level Security (RLS) policies

**Plain-language version:** your page's JavaScript is not a real lock on the
data — anyone can open their browser's built-in developer tools and read or
tinker with it. The actual lock is a set of permission rules that live inside
Supabase itself, called Row Level Security (RLS): rules like "a user can only
read expense rows for properties they're assigned to." Those rules are the only
thing standing between "a user at Property A" and "Property B's financial data,"
regardless of what the webpage does.

**What this involves:** going table by table (properties, projects, expenses,
vendors, vendor_contracts, profiles, etc.) and confirming the RLS policy on each
one actually matches what it's supposed to allow — including edge cases like an
admin vs. a regular user, and someone assigned to multiple properties.

**Why first:** this is the one item on this whole plan that's a genuine security
gap if it's wrong, and it only gets more consequential as more people log in. It
doesn't cost anything and doesn't require the paid plan.

### 4. Add a staging (test) environment

**Plain-language version:** a second, separate copy of the site — a second free
Supabase project holding fake/sample data, plus a second small web address — where
changes get tried out before they touch the real site real people use. Right now,
pushing to `main` goes live instantly with no safety net in between.

**What this involves:** creating a second Supabase project, pointing a
non-production copy of the page at it (a separate branch or a query-string toggle
would both work — we'll decide when we get there), and changing our workflow so
new features get tested there first, then promoted to the real site once
confirmed good. Once this exists, CLI access (#1) can push a change to staging
first, you look at it, then I promote the same change to production — all
without manual copy-paste at any step.

**Why last:** it's high value, but it assumes the RLS rules underneath it are
already sound — no point building a safe testing lane if the underlying locks
are the thing that's broken. Until this exists, CLI changes (#1) go straight to
production, same as today's copy-paste process.

## Suggested order

1. **Supabase CLI access** — fixes the copy-paste hassle right away (moved up
   at your request)
2. RLS audit (safety net, free, no dependencies)
3. Split the code into files (reliability + makes future work cheaper/faster)
4. Staging environment

Reasonable to reorder further if priorities shift — just flag it and I'll
update this document.

## Cost roadmap (holding off on paying for now)

You've said you'll hold off upgrading Supabase for the moment — noting here so we
remember why and when to revisit it.

| Item | Free tier limit | Cost once you outgrow it |
|---|---|---|
| Supabase Pro plan | — | ~$25/month — turns on **daily backups** (none exist today), removes the "project pauses after a week idle" risk, raises every limit below |
| Database size | 500 MB | Included up to 8 GB on Pro, then pay-as-you-go — unlikely to be the trigger, this is just text/rows |
| File storage (contracts, receipts) | 1 GB | Included up to 100 GB on Pro, then ~$0.021/GB/month — the one to actually watch, since PDFs/photos add up faster than data rows |
| Bandwidth ("egress") | 2 GB/month | Included up to 250 GB/month on Pro, then ~$0.09/GB |
| Outgoing email (password resets, invites) | Shared, rate-limited — fine for testing | For real users, a proper email sender (e.g. Resend) — free for the first few thousand emails/month |
| Custom domain (optional) | — | ~$12–20/year |
| Error monitoring (optional) | Most tools have a free tier | Likely $0 for a while |

**The real trigger point isn't storage — it's backups.** The free tier has no
automatic backups at all, so the honest recommendation is to upgrade to Pro before
real users' data would be painful to lose, not when a storage number turns red.
Once CLI access (#4 above) is set up, I can pull your actual current
storage/database usage from Supabase directly so this isn't a guess.

## Working efficiently with Claude

- **Model to use day-to-day:** Sonnet 5 (what we're on now) — good default for
  regular feature work and bug fixes.
- **Worth switching to Opus ("fast mode", `/fast`) for:** the RLS audit and
  planning the file-split — higher-stakes, one-time thinking where getting it
  right matters more than speed.
- **Avoid Haiku for this project:** it's the fastest/cheapest option, but almost
  everything here touches real data for real people — not worth trading care for
  speed, except maybe a trivial wording/color tweak.

## Reusable prompts for future sessions

- *"Audit every table's Row Level Security policy and report any gap where a user
  could see or edit data outside their assigned property."*
- *"Split index.html into separate files by feature (Work Orders, Vendors, Admin,
  CapEx, shared helpers) with no behavior changes — pure reorganization."*
- *"Set up a staging Supabase project and staging deployment, and describe how to
  promote a tested change to production."*
- *"Set up Supabase CLI access so you can push schema and Edge Function changes
  directly."*
- *"Pull current Supabase storage and database usage and tell me how close we are
  to the free-tier limits."*
