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

create policy "properties readable by staff" on properties
  for select using (auth.role() = 'authenticated');

create policy "projects full access for staff" on projects
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create policy "expenses full access for staff" on expenses
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create policy "todos full access for staff" on todos
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
