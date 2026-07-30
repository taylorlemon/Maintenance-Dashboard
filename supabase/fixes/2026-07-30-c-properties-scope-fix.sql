-- Fix C (2026-07-30): the facility list was readable by anyone signed in,
-- including the Asana project ids for communities the person has no access to.
-- See SECURITY-AUDIT.md finding #5.
--
-- This also matters for finding #2: knowing another community's Asana project
-- id is the prerequisite for abusing the work-orders proxy, so scoping this
-- table shrinks that gap considerably.
--
-- App impact, checked before applying:
--   - populatePropertySelects() builds every property dropdown from this list;
--     non-admins now receive only their own facilities, which is what
--     restrictSelectToProperties() was already trimming them down to
--     client-side. That trim becomes a no-op rather than breaking.
--   - visibleProperties() (Work Orders) filters the same list by the same
--     codes, so it is unchanged.
--   - The Admin tab's facility table is admin-only, and admins still see all.
--   - The asana-proxy Edge Function loads this table with the caller's own
--     token. A non-admin requesting another community's project now gets
--     "Unrecognized Asana project" instead of "Not allowed to view that
--     community's work orders" — still denied, just a different message.
--
-- Safe to re-run.

drop policy if exists "properties readable by staff" on properties;
drop policy if exists "properties readable by scope" on properties;
create policy "properties readable by scope" on properties
  for select using (is_admin() or code in (select my_property_codes()));
