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

create or replace function my_property_code()
returns text
language sql
security definer
stable
set search_path = public
as $$
  select property_code from profiles where id = auth.uid();
$$;

-- Everyone signed in can read the list of profiles (needed so the Admin
-- screen can show names, and so people can look up their own row) — but
-- only admins can change anyone's company or role, and nobody can insert a
-- row directly (that only ever happens automatically, above).
drop policy if exists "profiles readable by staff" on profiles;
create policy "profiles readable by staff" on profiles
  for select using (auth.role() = 'authenticated');

drop policy if exists "profiles writable by admins" on profiles;
create policy "profiles writable by admins" on profiles
  for update using (is_admin()) with check (is_admin());

drop policy if exists "profiles deletable by admins" on profiles;
create policy "profiles deletable by admins" on profiles
  for delete using (is_admin());

-- Run this once, with your own login email, so you have at least one admin
-- account able to use the Admin screen to set everyone else up:
-- update profiles set role = 'admin' where email = 'taylor@lionelpartners.com';

-- ── Scope every table to the logged-in person's own company ────────────────
-- Replaces the old "any signed-in staff account gets full read/write" rules.
-- Admins see everything; everyone else only ever sees rows for their own
-- assigned company — enforced here in the database, not just hidden in the
-- screen, so it can't be bypassed from the browser.

drop policy if exists "projects full access for staff" on projects;
create policy "projects scoped by company" on projects
  for all using (is_admin() or property_code = my_property_code())
  with check (is_admin() or property_code = my_property_code());

drop policy if exists "expenses full access for staff" on expenses;
create policy "expenses scoped by company" on expenses
  for all using (is_admin() or property_code = my_property_code())
  with check (is_admin() or property_code = my_property_code());

drop policy if exists "todos full access for staff" on todos;
create policy "todos scoped by company" on todos
  for all using (is_admin() or property_code = my_property_code())
  with check (is_admin() or property_code = my_property_code());

drop policy if exists "annual_budgets full access for staff" on annual_budgets;
create policy "annual_budgets scoped by company" on annual_budgets
  for all using (is_admin() or property_code = my_property_code())
  with check (is_admin() or property_code = my_property_code());

drop policy if exists "project_log full access for staff" on project_log;
create policy "project_log scoped by company" on project_log
  for all using (
    is_admin() or exists (
      select 1 from projects pr where pr.id = project_log.project_id and pr.property_code = my_property_code()
    )
  )
  with check (
    is_admin() or exists (
      select 1 from projects pr where pr.id = project_log.project_id and pr.property_code = my_property_code()
    )
  );

-- Receipts and approval files are stored as "<project id>/<filename>" —
-- scope access by looking up which company that project belongs to.
drop policy if exists "receipts full access for staff" on storage.objects;
create policy "receipts scoped by company" on storage.objects
  for all using (
    bucket_id = 'receipts' and (
      is_admin() or exists (
        select 1 from projects pr where pr.id::text = (storage.foldername(name))[1] and pr.property_code = my_property_code()
      )
    )
  )
  with check (
    bucket_id = 'receipts' and (
      is_admin() or exists (
        select 1 from projects pr where pr.id::text = (storage.foldername(name))[1] and pr.property_code = my_property_code()
      )
    )
  );

drop policy if exists "approvals full access for staff" on storage.objects;
create policy "approvals scoped by company" on storage.objects
  for all using (
    bucket_id = 'approvals' and (
      is_admin() or exists (
        select 1 from projects pr where pr.id::text = (storage.foldername(name))[1] and pr.property_code = my_property_code()
      )
    )
  )
  with check (
    bucket_id = 'approvals' and (
      is_admin() or exists (
        select 1 from projects pr where pr.id::text = (storage.foldername(name))[1] and pr.property_code = my_property_code()
      )
    )
  );
