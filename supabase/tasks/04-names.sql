-- People's names (2026-11-06). Run after 01-tasks.sql. Safe to re-run.
--
-- Until now notes, history and "Created by" were stamped with the person's
-- email. From now on they're stamped with their name (falling back to the email
-- if no name has been set). Records already stamped keep the email they were
-- stamped with: they're part of the permanent record and never change.
--
-- Names are set by an Admin in Admin -> Users (the existing "profiles writable
-- by admins" rule), or by the person themselves when the site first asks
-- (set_my_name below — Admins can't otherwise edit their own login).

alter table profiles add column if not exists full_name text;

-- What notes, history and task stamps record as "who".
create or replace function my_display_name() returns text
language sql stable security definer set search_path = public as $$
  select coalesce(nullif(btrim(full_name), ''), email) from profiles where id = auth.uid();
$$;

-- Lets anyone set their own name — and nothing else about their login.
create or replace function set_my_name(n text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not signed in.'; end if;
  if coalesce(btrim(n), '') = '' then raise exception 'Enter your name.'; end if;
  if length(btrim(n)) > 80 then raise exception 'That name is too long.'; end if;
  update profiles set full_name = btrim(n) where id = auth.uid();
end;
$$;

revoke all on function set_my_name(text) from public, anon;
grant execute on function set_my_name(text) to authenticated;
