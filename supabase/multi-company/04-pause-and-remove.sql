-- ── Multi-company: pausing and removing a company ───────────────────────────
-- Run after 03-executive-tools.sql. Safe to re-run.
--
-- For when a company cancels (NEW-COMPANY-CHECKLIST.md, "If a company leaves"):
--   Pause   — their people can sign in but see nothing, and their emails stop.
--             Nothing is deleted; the Executive can un-pause at any time.
--   Remove  — permanently deletes everything of theirs. Only possible once
--             paused, never for a company an Executive belongs to, and done
--             by the manage-users server function (it also has to delete their
--             logins and files, which the database can't do by itself).
-- (Downloading their data needs nothing new here: the Executive can already
-- read everything, and the page builds the zip file.)

alter table companies add column if not exists paused_at timestamptz;

-- A paused company is treated as if its people belonged to no company at all —
-- every access rule asks in_my_company(), so this one change shuts them out
-- everywhere at once. The Executive isn't affected (is_executive() comes first
-- in every rule).
create or replace function in_my_company(c uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select c is not null and c = my_company_id()
    and not exists (select 1 from companies where id = c and paused_at is not null);
$$;

-- The page asks this after sign-in, to explain an empty screen.
create or replace function my_company_paused() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select co.paused_at is not null from companies co where co.id = my_company_id()), false);
$$;

-- Companies an Executive belongs to can never be paused or removed.
create or replace function company_has_executive(c uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where company_id = c and is_executive);
$$;

create or replace function set_company_paused(c uuid, pause boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_executive() then raise exception 'Only the Executive can pause a company.'; end if;
  if pause and company_has_executive(c) then raise exception 'Your own company can''t be paused.'; end if;
  update companies set paused_at = case when pause then coalesce(paused_at, now()) else null end where id = c;
  if not found then raise exception 'Unknown company.'; end if;
end;
$$;

-- Deletes a company's rows, its Asana key and the company itself. Called only
-- by the manage-users server function, after it has checked the request and
-- deleted the company's logins and uploaded files. Children before parents.
create or replace function remove_company_rows(c uuid) returns void
language plpgsql security definer set search_path = public, vault as $$
declare
  codes text[];
  secret_name text;
begin
  if not exists (select 1 from companies where id = c and paused_at is not null) then
    raise exception 'A company has to be paused before it can be removed.';
  end if;
  if company_has_executive(c) then raise exception 'A company an Executive belongs to can''t be removed.'; end if;

  select coalesce(array_agg(code), '{}') into codes from properties where company_id = c;
  delete from project_log where project_id in (select id from projects where property_code = any(codes));
  delete from expenses where property_code = any(codes);
  delete from todos where property_code = any(codes);
  delete from projects where property_code = any(codes);
  delete from annual_budgets where property_code = any(codes);
  delete from work_order_daily_stats where property_code = any(codes);
  delete from vendor_contracts where vendor_id in (select id from vendors where company_id = c);
  delete from vendor_properties where vendor_id in (select id from vendors where company_id = c);
  delete from vendors where company_id = c;
  delete from profile_properties where property_code = any(codes);
  -- Logins are deleted by the server function first; anything left is detached.
  update profiles set company_id = null where company_id = c;
  delete from properties where company_id = c;

  select asana_token_secret into secret_name from companies where id = c;
  if secret_name like 'asana\_token\_%' then delete from vault.secrets where name = secret_name; end if;
  delete from companies where id = c;
end;
$$;

revoke all on function set_company_paused(uuid, boolean) from public, anon;
grant execute on function set_company_paused(uuid, boolean) to authenticated;
revoke all on function my_company_paused() from public, anon;
grant execute on function my_company_paused() to authenticated;
revoke all on function remove_company_rows(uuid) from public, anon, authenticated;
grant execute on function remove_company_rows(uuid) to service_role;
