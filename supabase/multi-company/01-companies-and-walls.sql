-- ── Multi-company step 3: companies, and a wall around each one ─────────────
-- See MULTI-COMPANY-PLAN.md. Adds a "company" level above buildings and
-- rewrites every access rule so nobody can see or change another company's
-- data, whether through the site or by talking to the database directly.
--
-- Safe to re-run. On a database that already has data (the live one), every
-- existing building, person and vendor is placed in "Lionel Partners", so
-- nothing changes for anyone today.
--
-- Not done here, on purpose: turning on the Executive switch. That's one line
-- run by hand in the SQL Editor, because nothing on the site may ever do it:
--   update profiles set is_executive = true where email = '<Taylor''s login>';

-- ── Companies ────────────────────────────────────────────────────────────────
create table if not exists companies (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);
alter table companies enable row level security;

alter table properties add column if not exists company_id uuid references companies(id);
-- Each building's own time zone, for the daily/monthly emails (used from step 4).
alter table properties add column if not exists time_zone text not null default 'America/Denver';
-- Left empty on a brand-new login until an Admin's invite fills it in, and an
-- empty company means "sees nothing".
alter table profiles add column if not exists company_id uuid references companies(id);
alter table profiles add column if not exists is_executive boolean not null default false;
alter table vendors add column if not exists company_id uuid references companies(id);

do $$
declare c uuid;
begin
  if exists (select 1 from properties where company_id is null)
     or exists (select 1 from profiles where company_id is null)
     or exists (select 1 from vendors where company_id is null) then
    insert into companies (name) values ('Lionel Partners') on conflict (name) do nothing;
    select id into c from companies where name = 'Lionel Partners';
    update properties set company_id = c where company_id is null;
    update profiles   set company_id = c where company_id is null;
    update vendors    set company_id = c where company_id is null;
  end if;
end $$;

alter table properties alter column company_id set not null;
alter table vendors alter column company_id set not null;

create index if not exists properties_company_idx on properties (company_id);
create index if not exists profiles_company_idx on profiles (company_id);
create index if not exists vendors_company_idx on vendors (company_id);

-- ── Helpers ──────────────────────────────────────────────────────────────────
-- Same style as is_admin()/is_editor(): they look things up with full access
-- (security definer) so the rules below can use them without tripping over
-- their own restrictions.

create or replace function my_company_id() returns uuid
language sql stable security definer set search_path = public as $$
  select company_id from profiles where id = auth.uid();
$$;

create or replace function is_executive() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_executive from profiles where id = auth.uid()), false);
$$;

create or replace function property_company(p_code text) returns uuid
language sql stable security definer set search_path = public as $$
  select company_id from properties where code = p_code;
$$;

create or replace function vendor_company(v_id uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select company_id from vendors where id = v_id;
$$;

create or replace function profile_company(p_id uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select company_id from profiles where id = p_id;
$$;

create or replace function project_property(p_id uuid) returns text
language sql stable security definer set search_path = public as $$
  select property_code from projects where id = p_id;
$$;

-- File paths start with a project or vendor id as text ("<id>/<file>"); compare
-- as text so a malformed folder name just matches nothing instead of erroring.
create or replace function folder_project_property(folder text) returns text
language sql stable security definer set search_path = public as $$
  select property_code from projects where id::text = folder;
$$;

create or replace function folder_vendor(folder text) returns uuid
language sql stable security definer set search_path = public as $$
  select id from vendors where id::text = folder;
$$;

-- The site doesn't say which company a new vendor is for; it's the person's own.
alter table vendors alter column company_id set default my_company_id();

-- The questions every rule below asks. Company first, always: an Admin's power
-- stops at their company's edge, and Editors/Viewers need the building to be on
-- their list AND in their company.

create or replace function in_my_company(c uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select c is not null and c = my_company_id();
$$;

create or replace function can_see_property(p_code text) returns boolean
language sql stable security definer set search_path = public as $$
  select is_executive() or (in_my_company(property_company(p_code))
    and (is_admin() or p_code in (select my_property_codes())));
$$;

create or replace function can_edit_property(p_code text) returns boolean
language sql stable security definer set search_path = public as $$
  select is_executive() or (in_my_company(property_company(p_code))
    and (is_admin() or (is_editor() and p_code in (select my_property_codes()))));
$$;

create or replace function can_admin_company(c uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select is_executive() or (is_admin() and in_my_company(c));
$$;

-- Vendors are company-wide; Editors/Viewers see the ones tied to their buildings.
create or replace function can_see_vendor(v_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select is_executive() or (in_my_company(vendor_company(v_id)) and (is_admin()
    or exists (select 1 from vendor_properties vp where vp.vendor_id = v_id and vp.property_code in (select my_property_codes()))));
$$;

-- Changing the vendor itself: an Editor only when every building it serves is theirs.
create or replace function can_edit_vendor(v_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select is_executive() or (in_my_company(vendor_company(v_id))
    and (is_admin() or (is_editor() and vendor_fully_in_my_scope(v_id))));
$$;

-- Adding/removing a vendor's contracts: an Editor when it serves any of their buildings.
create or replace function can_edit_vendor_contracts(v_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select is_executive() or (in_my_company(vendor_company(v_id)) and (is_admin()
    or (is_editor() and exists (select 1 from vendor_properties vp where vp.vendor_id = v_id and vp.property_code in (select my_property_codes())))));
$$;

-- ── Rules ────────────────────────────────────────────────────────────────────
-- Old rule names are dropped alongside the new ones so this file can re-run.

-- companies
drop policy if exists "companies readable by members" on companies;
create policy "companies readable by members" on companies
  for select using (is_executive() or in_my_company(id));
drop policy if exists "companies writable by executive" on companies;
create policy "companies writable by executive" on companies
  for all using (is_executive()) with check (is_executive());

-- properties: everyone sees their buildings; only the Executive adds, changes or
-- removes them (each needs Asana set up by hand).
drop policy if exists "properties readable by scope" on properties;
create policy "properties readable by scope" on properties
  for select using (can_see_property(code));
drop policy if exists "properties insertable by admins" on properties;
drop policy if exists "properties insertable by executive" on properties;
create policy "properties insertable by executive" on properties
  for insert with check (is_executive());
drop policy if exists "properties updatable by admins" on properties;
drop policy if exists "properties updatable by executive" on properties;
create policy "properties updatable by executive" on properties
  for update using (is_executive()) with check (is_executive());
drop policy if exists "properties deletable by admins" on properties;
drop policy if exists "properties deletable by executive" on properties;
create policy "properties deletable by executive" on properties
  for delete using (is_executive());

-- profiles: yourself, your company's people if you're an Admin, everyone for the
-- Executive. Admins can't edit their own profile (see the guard further down).
drop policy if exists "profiles readable by self or admin" on profiles;
create policy "profiles readable by self or admin" on profiles
  for select using (id = auth.uid() or can_admin_company(company_id));
drop policy if exists "profiles writable by admins" on profiles;
create policy "profiles writable by admins" on profiles
  for update using (can_admin_company(company_id) and (is_executive() or id <> auth.uid()))
  with check (can_admin_company(company_id));
drop policy if exists "profiles deletable by admins" on profiles;
create policy "profiles deletable by admins" on profiles
  for delete using (can_admin_company(company_id) and (is_executive() or id <> auth.uid()));

-- profile_properties (who is assigned which buildings): the person and the
-- building must both be in the Admin's company, and never their own list.
drop policy if exists "profile_properties readable by self or admin" on profile_properties;
create policy "profile_properties readable by self or admin" on profile_properties
  for select using (profile_id = auth.uid() or can_admin_company(profile_company(profile_id)));
drop policy if exists "profile_properties writable by admins" on profile_properties;
create policy "profile_properties writable by admins" on profile_properties
  for all using (
    is_executive() or (can_admin_company(profile_company(profile_id)) and profile_id <> auth.uid())
  ) with check (
    is_executive() or (can_admin_company(profile_company(profile_id)) and profile_id <> auth.uid()
      and property_company(property_code) = profile_company(profile_id))
  );

-- projects, annual_budgets, todos: by building.
drop policy if exists "projects readable by scope" on projects;
create policy "projects readable by scope" on projects
  for select using (can_see_property(property_code));
drop policy if exists "projects insertable by editors" on projects;
create policy "projects insertable by editors" on projects
  for insert with check (can_edit_property(property_code));
drop policy if exists "projects updatable by editors" on projects;
create policy "projects updatable by editors" on projects
  for update using (can_edit_property(property_code)) with check (can_edit_property(property_code));
drop policy if exists "projects deletable by editors" on projects;
create policy "projects deletable by editors" on projects
  for delete using (can_edit_property(property_code));

drop policy if exists "annual_budgets readable by scope" on annual_budgets;
create policy "annual_budgets readable by scope" on annual_budgets
  for select using (can_see_property(property_code));
drop policy if exists "annual_budgets insertable by editors" on annual_budgets;
create policy "annual_budgets insertable by editors" on annual_budgets
  for insert with check (can_edit_property(property_code));
drop policy if exists "annual_budgets updatable by editors" on annual_budgets;
create policy "annual_budgets updatable by editors" on annual_budgets
  for update using (can_edit_property(property_code)) with check (can_edit_property(property_code));
drop policy if exists "annual_budgets deletable by editors" on annual_budgets;
create policy "annual_budgets deletable by editors" on annual_budgets
  for delete using (can_edit_property(property_code));

-- A to-do or expense linked to a project must be for that project's building,
-- so nothing can be hung on another company's project.
drop policy if exists "todos readable by scope" on todos;
create policy "todos readable by scope" on todos
  for select using (can_see_property(property_code));
drop policy if exists "todos insertable by editors" on todos;
create policy "todos insertable by editors" on todos
  for insert with check (can_edit_property(property_code)
    and (project_id is null or project_property(project_id) = property_code));
drop policy if exists "todos updatable by editors" on todos;
create policy "todos updatable by editors" on todos
  for update using (can_edit_property(property_code)) with check (can_edit_property(property_code)
    and (project_id is null or project_property(project_id) = property_code));
drop policy if exists "todos deletable by editors" on todos;
create policy "todos deletable by editors" on todos
  for delete using (can_edit_property(property_code));

drop policy if exists "expenses readable by scope" on expenses;
create policy "expenses readable by scope" on expenses
  for select using (can_see_property(property_code));
drop policy if exists "expenses insertable by editors" on expenses;
create policy "expenses insertable by editors" on expenses
  for insert with check (can_edit_property(property_code)
    and (project_id is null or project_property(project_id) = property_code));
drop policy if exists "expenses updatable by editors" on expenses;
create policy "expenses updatable by editors" on expenses
  for update using (can_edit_property(property_code)) with check (can_edit_property(property_code)
    and (project_id is null or project_property(project_id) = property_code));
drop policy if exists "expenses deletable by admins" on expenses;
create policy "expenses deletable by admins" on expenses
  for delete using (can_admin_company(property_company(property_code)));

-- project_log: follows its project's building.
drop policy if exists "project_log readable by scope" on project_log;
create policy "project_log readable by scope" on project_log
  for select using (can_see_property(project_property(project_id)));
drop policy if exists "project_log insertable by editors" on project_log;
create policy "project_log insertable by editors" on project_log
  for insert with check (can_edit_property(project_property(project_id)));

-- work order history: read-only on the site (the server writes it).
drop policy if exists "work_order_daily_stats readable by scope" on work_order_daily_stats;
create policy "work_order_daily_stats readable by scope" on work_order_daily_stats
  for select using (can_see_property(property_code));

-- vendors: one list per company.
drop policy if exists "vendors readable by scope" on vendors;
create policy "vendors readable by scope" on vendors
  for select using (can_see_vendor(id));
drop policy if exists "vendors insertable by editors" on vendors;
create policy "vendors insertable by editors" on vendors
  for insert with check (is_executive() or ((is_admin() or is_editor()) and in_my_company(company_id)));
drop policy if exists "vendors updatable by editors" on vendors;
create policy "vendors updatable by editors" on vendors
  for update using (can_edit_vendor(id))
  with check (is_executive() or (can_edit_vendor(id) and in_my_company(company_id)));
drop policy if exists "vendors deletable by editors" on vendors;
create policy "vendors deletable by editors" on vendors
  for delete using (can_edit_vendor(id));

-- vendor_properties: the vendor and the building must be in the same company.
drop policy if exists "vendor_properties readable by scope" on vendor_properties;
create policy "vendor_properties readable by scope" on vendor_properties
  for select using (can_see_property(property_code) and vendor_company(vendor_id) = property_company(property_code));
drop policy if exists "vendor_properties insertable by scope" on vendor_properties;
create policy "vendor_properties insertable by scope" on vendor_properties
  for insert with check (can_edit_property(property_code) and vendor_company(vendor_id) = property_company(property_code));
drop policy if exists "vendor_properties deletable by scope" on vendor_properties;
create policy "vendor_properties deletable by scope" on vendor_properties
  for delete using (can_edit_property(property_code) and vendor_company(vendor_id) = property_company(property_code));

-- vendor_contracts
drop policy if exists "vendor_contracts readable by scope" on vendor_contracts;
create policy "vendor_contracts readable by scope" on vendor_contracts
  for select using (can_see_vendor(vendor_id));
drop policy if exists "vendor_contracts insertable by editors" on vendor_contracts;
create policy "vendor_contracts insertable by editors" on vendor_contracts
  for insert with check (can_edit_vendor_contracts(vendor_id));
drop policy if exists "vendor_contracts deletable by editors" on vendor_contracts;
create policy "vendor_contracts deletable by editors" on vendor_contracts
  for delete using (can_edit_vendor_contracts(vendor_id));

-- Uploaded files: receipts and approvals live under their project's id,
-- vendor contracts under their vendor's id.
drop policy if exists "receipts readable by scope" on storage.objects;
create policy "receipts readable by scope" on storage.objects
  for select using (bucket_id = 'receipts' and can_see_property(folder_project_property((storage.foldername(name))[1])));
drop policy if exists "receipts insertable by editors" on storage.objects;
create policy "receipts insertable by editors" on storage.objects
  for insert with check (bucket_id = 'receipts' and can_edit_property(folder_project_property((storage.foldername(name))[1])));
drop policy if exists "receipts deletable by editors" on storage.objects;
create policy "receipts deletable by editors" on storage.objects
  for delete using (bucket_id = 'receipts' and can_edit_property(folder_project_property((storage.foldername(name))[1])));

drop policy if exists "approvals readable by scope" on storage.objects;
create policy "approvals readable by scope" on storage.objects
  for select using (bucket_id = 'approvals' and can_see_property(folder_project_property((storage.foldername(name))[1])));
drop policy if exists "approvals insertable by editors" on storage.objects;
create policy "approvals insertable by editors" on storage.objects
  for insert with check (bucket_id = 'approvals' and can_edit_property(folder_project_property((storage.foldername(name))[1])));
drop policy if exists "approvals deletable by editors" on storage.objects;
create policy "approvals deletable by editors" on storage.objects
  for delete using (bucket_id = 'approvals' and can_edit_property(folder_project_property((storage.foldername(name))[1])));

drop policy if exists "vendor-contracts readable by scope" on storage.objects;
create policy "vendor-contracts readable by scope" on storage.objects
  for select using (bucket_id = 'vendor-contracts' and can_see_vendor(folder_vendor((storage.foldername(name))[1])));
drop policy if exists "vendor-contracts insertable by editors" on storage.objects;
create policy "vendor-contracts insertable by editors" on storage.objects
  for insert with check (bucket_id = 'vendor-contracts' and can_edit_vendor_contracts(folder_vendor((storage.foldername(name))[1])));
drop policy if exists "vendor-contracts deletable by editors" on storage.objects;
create policy "vendor-contracts deletable by editors" on storage.objects
  for delete using (bucket_id = 'vendor-contracts' and can_edit_vendor_contracts(folder_vendor((storage.foldername(name))[1])));

-- ── Guards: nobody can raise their own access ───────────────────────────────
-- Runs as whoever made the change (not security definer), so current_user tells
-- us who's asking: 'authenticated' = a signed-in person on the site,
-- 'service_role' = our own server functions, anything else = someone working
-- directly in the database (the SQL Editor), who is allowed everything.
create or replace function guard_profile_changes() returns trigger
language plpgsql set search_path = public as $$
declare
  from_site boolean := current_user in ('authenticated', 'anon');
  from_app boolean := current_user in ('authenticated', 'anon', 'service_role');
  old_company uuid;
begin
  -- The Executive switch can only be set directly in the database.
  if from_app and (
       (tg_op = 'INSERT' and new.is_executive)
    or (tg_op = 'UPDATE' and new.is_executive is distinct from old.is_executive)) then
    raise exception 'The Executive setting can only be changed directly in the database.';
  end if;

  -- Only the Executive can change or remove the Executive's own profile.
  if tg_op in ('UPDATE', 'DELETE') and from_site and old.is_executive and not is_executive() then
    raise exception 'Only the Executive can change the Executive''s login.';
  end if;

  if tg_op = 'UPDATE' and from_site and not is_executive() then
    if new.id = auth.uid() and (new.role is distinct from old.role or new.company_id is distinct from old.company_id) then
      raise exception 'You can''t change your own role or company.';
    end if;
    if new.company_id is distinct from old.company_id then
      raise exception 'Only the Executive can move someone to another company.';
    end if;
  end if;

  -- A company must always keep at least one Admin, so it can't lock itself out.
  if from_app and tg_op in ('UPDATE', 'DELETE') and old.role = 'admin' and old.company_id is not null
     and (tg_op = 'DELETE' or new.role <> 'admin' or new.company_id is distinct from old.company_id) then
    old_company := old.company_id;
    if not exists (select 1 from profiles p where p.company_id = old_company and p.role = 'admin' and p.id <> old.id) then
      raise exception 'This is the company''s last Admin. Make someone else an Admin first.';
    end if;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists guard_profile_changes on profiles;
create trigger guard_profile_changes
  before insert or update or delete on profiles
  for each row execute function guard_profile_changes();
