-- Fix B (2026-07-30): every signed-in user could read every other user's
-- email and role, and the full map of who is assigned to which facility.
-- See SECURITY-AUDIT.md findings #3 and #4.
--
-- Both tables were readable by anyone signed in (auth.role() = 'authenticated').
-- The app only ever reads your own row (js/shared.js loadMyProfile /
-- loadMyPropertyCodes, and the asana-proxy Edge Function), except on the Admin
-- screen (js/admin.js loadAdminUsers), which only admins can reach. So
-- restricting to "your own row, or any row if you're an admin" preserves every
-- current feature.
--
-- Note: is_admin() is SECURITY DEFINER, so its internal read of profiles is not
-- itself subject to these rules — no infinite recursion.
--
-- Safe to re-run.

drop policy if exists "profiles readable by staff" on profiles;
drop policy if exists "profiles readable by self or admin" on profiles;
create policy "profiles readable by self or admin" on profiles
  for select using (id = auth.uid() or is_admin());

drop policy if exists "profile_properties readable by staff" on profile_properties;
drop policy if exists "profile_properties readable by self or admin" on profile_properties;
create policy "profile_properties readable by self or admin" on profile_properties
  for select using (profile_id = auth.uid() or is_admin());
