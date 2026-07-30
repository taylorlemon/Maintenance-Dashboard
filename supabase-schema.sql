-- Lionel Partners — Projects / Expenses / To-Dos schema
-- Run this once in the Supabase SQL Editor (Project → SQL Editor → New query).

create table if not exists properties (
  code text primary key,
  name text not null
);

insert into properties (code, name) values
  ('CP',   'Cove Point'),
  ('VDR',  'Valencia at Draper'),
  ('VCH',  'Valencia at Cottonwood Heights'),
  ('VATL', 'Valencia at the Lakes')
on conflict (code) do nothing;

create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  property_code text not null references properties(code),
  name text not null,
  description text,
  status text not null default 'planned'
    check (status in ('planned','in_progress','on_hold','completed')),
  budget numeric(12,2),
  start_date date,
  target_date date,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists expenses (
  id uuid primary key default gen_random_uuid(),
  property_code text not null references properties(code),
  project_id uuid references projects(id) on delete set null,
  vendor text,
  category text,
  amount numeric(12,2) not null,
  expense_date date not null default current_date,
  status text not null default 'pending'
    check (status in ('pending','approved','paid')),
  notes text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists todos (
  id uuid primary key default gen_random_uuid(),
  property_code text not null references properties(code),
  project_id uuid references projects(id) on delete set null,
  title text not null,
  due_date date,
  assignee text,
  priority text not null default 'medium'
    check (priority in ('low','medium','high')),
  completed boolean not null default false,
  completed_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

-- Row Level Security: any signed-in staff account gets full read/write.
-- There is no public signup for this app — accounts are invited manually
-- via Authentication -> Users, so "authenticated" already means "staff".

alter table properties enable row level security;
alter table projects   enable row level security;
alter table expenses   enable row level security;
alter table todos      enable row level security;

drop policy if exists "properties readable by staff" on properties;
create policy "properties readable by staff" on properties
  for select using (auth.role() = 'authenticated');

drop policy if exists "projects full access for staff" on projects;
create policy "projects full access for staff" on projects
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

drop policy if exists "expenses full access for staff" on expenses;
create policy "expenses full access for staff" on expenses
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

drop policy if exists "todos full access for staff" on todos;
create policy "todos full access for staff" on todos
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- Whether a project is a facility Improvement or a Repair/Replacement — shown as a
-- distinct badge everywhere a project appears. Existing projects default to
-- Repair/Replacement until edited.
alter table projects add column if not exists project_type text not null default 'repair_replacement'
  check (project_type in ('improvement', 'repair_replacement'));

-- When a project was marked complete — drives the Completed Projects list and is
-- cleared again if it's ever moved back to active.
alter table projects add column if not exists completed_at timestamptz;

-- One row per property per calendar year — the community-wide CapEx budget Taylor
-- types in, compared against actual spending for that same year. There's no row for
-- a new year until someone sets one, which is the intended "resets every January"
-- behavior.
create table if not exists annual_budgets (
  id uuid primary key default gen_random_uuid(),
  property_code text not null references properties(code),
  year integer not null,
  budget numeric(12,2) not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (property_code, year)
);

alter table annual_budgets enable row level security;

drop policy if exists "annual_budgets full access for staff" on annual_budgets;
create policy "annual_budgets full access for staff" on annual_budgets
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- Receipt files. Before running this, create a Storage bucket named exactly
-- "receipts" (Dashboard -> Storage -> New bucket), leaving "Public" turned OFF —
-- this policy is what lets logged-in staff (and only logged-in staff) upload,
-- view, and delete files in that bucket.
drop policy if exists "receipts full access for staff" on storage.objects;
create policy "receipts full access for staff" on storage.objects
  for all using (bucket_id = 'receipts' and auth.role() = 'authenticated')
  with check (bucket_id = 'receipts' and auth.role() = 'authenticated');

-- Project approval: who signed off, where, when, and an optional proof file.
-- Unchecking "Approved" later clears these live fields back out — the permanent
-- record of the approval (and of it being removed) lives in project_log below,
-- so nothing is actually lost.
alter table projects add column if not exists approved boolean not null default false;
alter table projects add column if not exists approved_by text;
alter table projects add column if not exists approved_location text;
alter table projects add column if not exists approved_date date;
alter table projects add column if not exists approval_file_path text;

-- Permanent, append-only activity log per project. Approvals/removals, marking a
-- project complete or moving it back to active, and budget changes each write one
-- row here and nothing is ever deleted — this is the transparent history Taylor can
-- pull up for any project at any future date, independent of whatever the live
-- fields on `projects` currently say.
create table if not exists project_log (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  event_type text not null
    check (event_type in ('approval_granted', 'approval_removed', 'status_changed', 'budget_changed')),
  summary text not null,
  metadata jsonb,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

alter table project_log enable row level security;

drop policy if exists "project_log full access for staff" on project_log;
create policy "project_log full access for staff" on project_log
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- Approval proof files. Before running this, create a Storage bucket named exactly
-- "approvals" (Dashboard -> Storage -> New bucket), leaving "Public" turned OFF —
-- same setup as the "receipts" bucket above.
drop policy if exists "approvals full access for staff" on storage.objects;
create policy "approvals full access for staff" on storage.objects
  for all using (bucket_id = 'approvals' and auth.role() = 'authenticated')
  with check (bucket_id = 'approvals' and auth.role() = 'authenticated');

-- ── Per-company accounts ────────────────────────────────────────────────────
-- Which company (property) each login belongs to, and whether they're an
-- administrator who can see every company. A row here is created
-- automatically the instant you invite someone (Supabase Dashboard ->
-- Authentication -> Users -> Invite user), with no company assigned yet
-- until you set one on the in-app Admin screen.

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  property_code text references properties(code),
  role text not null default 'staff' check (role in ('admin', 'staff')),
  created_at timestamptz not null default now()
);

alter table profiles enable row level security;

-- Fill in a profile row for every login that already exists today (e.g. any
-- CapEx accounts created before this ran). Safe to re-run — it skips anyone
-- who already has a row.
insert into public.profiles (id, email)
select id, email from auth.users
on conflict (id) do nothing;

-- From now on, new invites get a profile row automatically the moment
-- they're created, so they show up in the Admin screen ready to be assigned
-- a company — nobody has to type in an internal ID by hand.
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure handle_new_user();

-- Helper functions used by the access rules below. SECURITY DEFINER lets
-- them read the profiles table on the logged-in person's behalf without
-- that read itself being blocked by the very rules it's used to enforce
-- (otherwise checking "is this person an admin?" would recursively trigger
-- the same check).
create or replace function is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select coalesce((select role = 'admin' from profiles where id = auth.uid()), false);
$$;

-- Everyone signed in can read the list of profiles (needed so the Admin
-- screen can show names, and so people can look up their own row) — but
-- only admins can change anyone's company or role, and nobody can insert a
-- row directly (that only ever happens automatically, above).
-- Security audit 2026-07-30 (SECURITY-AUDIT.md #3): this used to be readable
-- by anyone signed in, which handed every user a directory of everyone else's
-- email and role. The app only reads your own row, except on the Admin screen.
drop policy if exists "profiles readable by staff" on profiles;
drop policy if exists "profiles readable by self or admin" on profiles;
create policy "profiles readable by self or admin" on profiles
  for select using (id = auth.uid() or is_admin());

drop policy if exists "profiles writable by admins" on profiles;
create policy "profiles writable by admins" on profiles
  for update using (is_admin()) with check (is_admin());

drop policy if exists "profiles deletable by admins" on profiles;
create policy "profiles deletable by admins" on profiles
  for delete using (is_admin());

-- Run this once, with your own login email, so you have at least one admin
-- account able to use the Admin screen to set everyone else up:
-- update profiles set role = 'admin' where email = 'taylor@lionelpartners.com';

-- ── Facilities, multi-facility access, and Editor/Viewer roles ─────────────
-- Run this once, after everything above. Safe to re-run.
--
-- What this changes:
--   1. Facilities ("properties") can now be added and removed from the
--      in-app Admin screen instead of only by editing the page's code. Each
--      facility can optionally carry its Asana IDs, so its Work Orders tab
--      knows what to pull — a brand-new facility can be added without them;
--      its Work Orders tab just stays empty until they're filled in later.
--   2. A person can now be given more than one facility (previously exactly
--      one). The old single "property_code" column on profiles is replaced
--      by a new profile_properties table listing every facility a person
--      has been given.
--   3. Roles become three-tier: Admin (everything, including this Admin
--      screen), Editor (full add/edit/delete, but only within their
--      assigned facilities), Viewer (read-only, only within their assigned
--      facilities). The old "staff" role is renamed to "editor" — same
--      access as before, new name.

-- Asana IDs live on the facility itself now, not hardcoded in the page.
alter table properties add column if not exists asana_project_gid text;
alter table properties add column if not exists asana_pm_section_gid text;
alter table properties add column if not exists asana_rt_section_gid text;

-- Carry over the IDs that were previously hardcoded, so the four facilities
-- already in use keep working exactly as they do today.
update properties set asana_project_gid = '1210546579390444', asana_pm_section_gid = '1210546579390447', asana_rt_section_gid = '1210546579390440' where code = 'CP'   and asana_project_gid is null;
update properties set asana_project_gid = '1210546579390437', asana_pm_section_gid = '1210546579390434', asana_rt_section_gid = '1210546579390431' where code = 'VDR'  and asana_project_gid is null;
update properties set asana_project_gid = '1210546583182221', asana_pm_section_gid = '1210546583182224', asana_rt_section_gid = '1210546583182227' where code = 'VCH'  and asana_project_gid is null;
update properties set asana_project_gid = '1213560305303692', asana_pm_section_gid = '1213560305303695', asana_rt_section_gid = '1213560305303689' where code = 'VATL' and asana_project_gid is null;

-- Anyone signed in can still read the facility list (needed for dropdowns
-- everywhere); only admins can add, edit, or remove a facility. There is no
-- delete cascade on purpose — removing a facility that still has projects,
-- expenses, or to-dos on record will fail with an error rather than quietly
-- destroying that history. The app surfaces that error in plain language.
drop policy if exists "properties writable by admins" on properties;
drop policy if exists "properties insertable by admins" on properties;
create policy "properties insertable by admins" on properties
  for insert with check (is_admin());
drop policy if exists "properties updatable by admins" on properties;
create policy "properties updatable by admins" on properties
  for update using (is_admin()) with check (is_admin());
drop policy if exists "properties deletable by admins" on properties;
create policy "properties deletable by admins" on properties
  for delete using (is_admin());

-- ── Multiple facilities per person ──────────────────────────────────────────

create table if not exists profile_properties (
  profile_id uuid not null references profiles(id) on delete cascade,
  property_code text not null references properties(code) on delete cascade,
  primary key (profile_id, property_code)
);

-- Carry over everyone's existing single facility so nobody loses access.
-- One-time migration — only meaningful the first time this ever runs, before
-- the old property_code column below is dropped. Guarded so re-running this
-- file later (once that column is already gone) skips it instead of erroring.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'property_code'
  ) then
    insert into profile_properties (profile_id, property_code)
    select id, property_code from profiles where property_code is not null
    on conflict do nothing;
  end if;
end $$;

alter table profile_properties enable row level security;

-- Security audit 2026-07-30 (SECURITY-AUDIT.md #4): same story as profiles —
-- this exposed the full map of who is assigned to which facility.
drop policy if exists "profile_properties readable by staff" on profile_properties;
drop policy if exists "profile_properties readable by self or admin" on profile_properties;
create policy "profile_properties readable by self or admin" on profile_properties
  for select using (profile_id = auth.uid() or is_admin());

drop policy if exists "profile_properties writable by admins" on profile_properties;
create policy "profile_properties writable by admins" on profile_properties
  for all using (is_admin()) with check (is_admin());

-- ── Three-tier roles: admin / editor / viewer ───────────────────────────────

alter table profiles drop constraint if exists profiles_role_check;
update profiles set role = 'editor' where role = 'staff';
alter table profiles add constraint profiles_role_check check (role in ('admin', 'editor', 'viewer'));
alter table profiles alter column role set default 'editor';

create or replace function is_editor()
returns boolean
language sql security definer stable set search_path = public
as $$
  select coalesce((select role = 'editor' from profiles where id = auth.uid()), false);
$$;

create or replace function my_property_codes()
returns setof text
language sql security definer stable set search_path = public
as $$
  select property_code from profile_properties where profile_id = auth.uid();
$$;

-- ── Re-scope every table: Admins see everything; Editors and Viewers see only
-- their assigned facilities; only Admins and Editors can write. ─────────────

-- Security audit 2026-07-30 (SECURITY-AUDIT.md #5): the facility list was
-- readable by anyone signed in, including the Asana project ids of communities
-- they have no access to — which is exactly what's needed to probe the
-- work-orders proxy. Scoped here rather than where the table is first created,
-- because my_property_codes() doesn't exist until just above this line.
drop policy if exists "properties readable by staff" on properties;
drop policy if exists "properties readable by scope" on properties;
create policy "properties readable by scope" on properties
  for select using (is_admin() or code in (select my_property_codes()));

drop policy if exists "projects full access for staff" on projects;
drop policy if exists "projects scoped by company" on projects;
drop policy if exists "projects readable by scope" on projects;
create policy "projects readable by scope" on projects
  for select using (is_admin() or property_code in (select my_property_codes()));
drop policy if exists "projects insertable by editors" on projects;
create policy "projects insertable by editors" on projects
  for insert with check (is_admin() or (is_editor() and property_code in (select my_property_codes())));
drop policy if exists "projects updatable by editors" on projects;
create policy "projects updatable by editors" on projects
  for update using (is_admin() or (is_editor() and property_code in (select my_property_codes())))
  with check (is_admin() or (is_editor() and property_code in (select my_property_codes())));
drop policy if exists "projects deletable by editors" on projects;
create policy "projects deletable by editors" on projects
  for delete using (is_admin() or (is_editor() and property_code in (select my_property_codes())));

drop policy if exists "expenses full access for staff" on expenses;
drop policy if exists "expenses scoped by company" on expenses;
drop policy if exists "expenses readable by scope" on expenses;
create policy "expenses readable by scope" on expenses
  for select using (is_admin() or property_code in (select my_property_codes()));
drop policy if exists "expenses insertable by editors" on expenses;
create policy "expenses insertable by editors" on expenses
  for insert with check (is_admin() or (is_editor() and property_code in (select my_property_codes())));
drop policy if exists "expenses updatable by editors" on expenses;
create policy "expenses updatable by editors" on expenses
  for update using (is_admin() or (is_editor() and property_code in (select my_property_codes())))
  with check (is_admin() or (is_editor() and property_code in (select my_property_codes())));
drop policy if exists "expenses deletable by editors" on expenses;
create policy "expenses deletable by editors" on expenses
  for delete using (is_admin() or (is_editor() and property_code in (select my_property_codes())));

drop policy if exists "todos full access for staff" on todos;
drop policy if exists "todos scoped by company" on todos;
drop policy if exists "todos readable by scope" on todos;
create policy "todos readable by scope" on todos
  for select using (is_admin() or property_code in (select my_property_codes()));
drop policy if exists "todos insertable by editors" on todos;
create policy "todos insertable by editors" on todos
  for insert with check (is_admin() or (is_editor() and property_code in (select my_property_codes())));
drop policy if exists "todos updatable by editors" on todos;
create policy "todos updatable by editors" on todos
  for update using (is_admin() or (is_editor() and property_code in (select my_property_codes())))
  with check (is_admin() or (is_editor() and property_code in (select my_property_codes())));
drop policy if exists "todos deletable by editors" on todos;
create policy "todos deletable by editors" on todos
  for delete using (is_admin() or (is_editor() and property_code in (select my_property_codes())));

drop policy if exists "annual_budgets full access for staff" on annual_budgets;
drop policy if exists "annual_budgets scoped by company" on annual_budgets;
drop policy if exists "annual_budgets readable by scope" on annual_budgets;
create policy "annual_budgets readable by scope" on annual_budgets
  for select using (is_admin() or property_code in (select my_property_codes()));
drop policy if exists "annual_budgets insertable by editors" on annual_budgets;
create policy "annual_budgets insertable by editors" on annual_budgets
  for insert with check (is_admin() or (is_editor() and property_code in (select my_property_codes())));
drop policy if exists "annual_budgets updatable by editors" on annual_budgets;
create policy "annual_budgets updatable by editors" on annual_budgets
  for update using (is_admin() or (is_editor() and property_code in (select my_property_codes())))
  with check (is_admin() or (is_editor() and property_code in (select my_property_codes())));
drop policy if exists "annual_budgets deletable by editors" on annual_budgets;
create policy "annual_budgets deletable by editors" on annual_budgets
  for delete using (is_admin() or (is_editor() and property_code in (select my_property_codes())));

drop policy if exists "project_log full access for staff" on project_log;
drop policy if exists "project_log scoped by company" on project_log;
drop policy if exists "project_log readable by scope" on project_log;
create policy "project_log readable by scope" on project_log
  for select using (
    is_admin() or exists (select 1 from projects pr where pr.id = project_log.project_id and pr.property_code in (select my_property_codes()))
  );
drop policy if exists "project_log insertable by editors" on project_log;
create policy "project_log insertable by editors" on project_log
  for insert with check (
    is_admin() or (is_editor() and exists (select 1 from projects pr where pr.id = project_log.project_id and pr.property_code in (select my_property_codes())))
  );

drop policy if exists "receipts full access for staff" on storage.objects;
drop policy if exists "receipts scoped by company" on storage.objects;
drop policy if exists "receipts readable by scope" on storage.objects;
create policy "receipts readable by scope" on storage.objects
  for select using (
    bucket_id = 'receipts' and (is_admin() or exists (select 1 from projects pr where pr.id::text = (storage.foldername(objects.name))[1] and pr.property_code in (select my_property_codes())))
  );
drop policy if exists "receipts insertable by editors" on storage.objects;
create policy "receipts insertable by editors" on storage.objects
  for insert with check (
    bucket_id = 'receipts' and (is_admin() or (is_editor() and exists (select 1 from projects pr where pr.id::text = (storage.foldername(objects.name))[1] and pr.property_code in (select my_property_codes()))))
  );
drop policy if exists "receipts deletable by editors" on storage.objects;
create policy "receipts deletable by editors" on storage.objects
  for delete using (
    bucket_id = 'receipts' and (is_admin() or (is_editor() and exists (select 1 from projects pr where pr.id::text = (storage.foldername(objects.name))[1] and pr.property_code in (select my_property_codes()))))
  );

drop policy if exists "approvals full access for staff" on storage.objects;
drop policy if exists "approvals scoped by company" on storage.objects;
drop policy if exists "approvals readable by scope" on storage.objects;
create policy "approvals readable by scope" on storage.objects
  for select using (
    bucket_id = 'approvals' and (is_admin() or exists (select 1 from projects pr where pr.id::text = (storage.foldername(objects.name))[1] and pr.property_code in (select my_property_codes())))
  );
drop policy if exists "approvals insertable by editors" on storage.objects;
create policy "approvals insertable by editors" on storage.objects
  for insert with check (
    bucket_id = 'approvals' and (is_admin() or (is_editor() and exists (select 1 from projects pr where pr.id::text = (storage.foldername(objects.name))[1] and pr.property_code in (select my_property_codes()))))
  );
drop policy if exists "approvals deletable by editors" on storage.objects;
create policy "approvals deletable by editors" on storage.objects
  for delete using (
    bucket_id = 'approvals' and (is_admin() or (is_editor() and exists (select 1 from projects pr where pr.id::text = (storage.foldername(objects.name))[1] and pr.property_code in (select my_property_codes()))))
  );

-- Every policy above has now been replaced, so nothing references the old
-- single-facility helper anymore — safe to remove it and the column it read.
drop function if exists my_property_code();
alter table profiles drop column if exists property_code;

-- ── Vendors and their contracts ─────────────────────────────────────────────
-- Run this once, after everything above. Safe to re-run.

create table if not exists vendors (
  id uuid primary key default gen_random_uuid(),
  property_code text not null references properties(code),
  name text not null,
  trade text,
  contact_name text,
  phone text,
  email text,
  notes text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table vendors enable row level security;

drop policy if exists "vendors readable by scope" on vendors;
create policy "vendors readable by scope" on vendors
  for select using (is_admin() or property_code in (select my_property_codes()));
drop policy if exists "vendors insertable by editors" on vendors;
create policy "vendors insertable by editors" on vendors
  for insert with check (is_admin() or (is_editor() and property_code in (select my_property_codes())));
drop policy if exists "vendors updatable by editors" on vendors;
create policy "vendors updatable by editors" on vendors
  for update using (is_admin() or (is_editor() and property_code in (select my_property_codes())))
  with check (is_admin() or (is_editor() and property_code in (select my_property_codes())));
drop policy if exists "vendors deletable by editors" on vendors;
create policy "vendors deletable by editors" on vendors
  for delete using (is_admin() or (is_editor() and property_code in (select my_property_codes())));

-- Contract files for a vendor. A vendor can have any number of contracts on
-- file — renewals are kept as history alongside the old one, never
-- overwritten. Every contract requires an expiration date; that's what the
-- reminder system below watches. expiration_alert_sent_at marks a contract
-- once it's been included in an email so the same one is never emailed twice.
create table if not exists vendor_contracts (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors(id) on delete cascade,
  file_path text not null,
  file_name text not null,
  expires_on date not null,
  expiration_alert_sent_at timestamptz,
  uploaded_by uuid references auth.users(id),
  uploaded_at timestamptz not null default now()
);

alter table vendor_contracts enable row level security;

drop policy if exists "vendor_contracts readable by scope" on vendor_contracts;
create policy "vendor_contracts readable by scope" on vendor_contracts
  for select using (
    is_admin() or exists (select 1 from vendors v where v.id = vendor_contracts.vendor_id and v.property_code in (select my_property_codes()))
  );
drop policy if exists "vendor_contracts insertable by editors" on vendor_contracts;
create policy "vendor_contracts insertable by editors" on vendor_contracts
  for insert with check (
    is_admin() or (is_editor() and exists (select 1 from vendors v where v.id = vendor_contracts.vendor_id and v.property_code in (select my_property_codes())))
  );
drop policy if exists "vendor_contracts deletable by editors" on vendor_contracts;
create policy "vendor_contracts deletable by editors" on vendor_contracts
  for delete using (
    is_admin() or (is_editor() and exists (select 1 from vendors v where v.id = vendor_contracts.vendor_id and v.property_code in (select my_property_codes())))
  );

-- Contract files. Before running this, create a Storage bucket named exactly
-- "vendor-contracts" (Dashboard -> Storage -> New bucket), leaving "Public"
-- turned OFF — same setup as the "receipts" and "approvals" buckets above.
-- Files are stored as "<vendor id>/<filename>".
drop policy if exists "vendor-contracts readable by scope" on storage.objects;
create policy "vendor-contracts readable by scope" on storage.objects
  for select using (
    bucket_id = 'vendor-contracts' and (
      is_admin() or exists (select 1 from vendors v where v.id::text = (storage.foldername(objects.name))[1] and v.property_code in (select my_property_codes()))
    )
  );
drop policy if exists "vendor-contracts insertable by editors" on storage.objects;
create policy "vendor-contracts insertable by editors" on storage.objects
  for insert with check (
    bucket_id = 'vendor-contracts' and (
      is_admin() or (is_editor() and exists (select 1 from vendors v where v.id::text = (storage.foldername(objects.name))[1] and v.property_code in (select my_property_codes())))
    )
  );
drop policy if exists "vendor-contracts deletable by editors" on storage.objects;
create policy "vendor-contracts deletable by editors" on storage.objects
  for delete using (
    bucket_id = 'vendor-contracts' and (
      is_admin() or (is_editor() and exists (select 1 from vendors v where v.id::text = (storage.foldername(objects.name))[1] and v.property_code in (select my_property_codes())))
    )
  );

-- ── Daily contract-expiration email check ───────────────────────────────────
-- Schedules the database itself to call the "contract-alerts" Edge Function
-- once a day. Requires two one-time steps first:
--   1. Deploy the contract-alerts Edge Function (see supabase/functions/contract-alerts).
--   2. Dashboard -> Database -> Extensions -> enable "pg_cron" and "pg_net".
--   3. Pick a long random value and set it on the function:
--        supabase secrets set ALERT_SECRET=<value>
--      then paste the same value in place of <ALERT_SECRET> below before
--      running this. See SECURITY-AUDIT.md #6 — the function is deployed with
--      JWT verification off, so this shared secret is the only thing stopping
--      anyone who knows the URL from triggering the alert emails themselves.
--      Do not commit the real value: this repository is public.
-- Then run this. Safe to re-run — it replaces the existing schedule by name.
select cron.unschedule('contract-expiration-alerts')
  where exists (select 1 from cron.job where jobname = 'contract-expiration-alerts');

select cron.schedule(
  'contract-expiration-alerts',
  '0 13 * * *', -- 1pm UTC daily
  $$
  select net.http_post(
    url := 'https://yjrcosafkymedmownfny.functions.supabase.co/contract-alerts',
    headers := jsonb_build_object(
      'x-alert-secret', '<ALERT_SECRET>',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
