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
