-- ── Multi-company step 4: each company's own Asana ──────────────────────────
-- Run after 01-companies-and-walls.sql. Safe to re-run.
--
-- Each company connects its own Asana. The server functions look up which
-- Asana key and CapEx to-dos board to use from the building being asked about,
-- so one company's key is never used for another company's buildings.
--
-- asana_token_secret says where that company's Asana key lives:
--   'env:ASANA_TOKEN'   the ASANA_TOKEN secret already set on the server
--                       functions (how Lionel Partners keeps working unchanged)
--   'asana_token_<x>'   a secret of that name in the database Vault, added by
--                       hand in the SQL Editor when setting up a new company:
--                         select vault.create_secret('<their key>', 'asana_token_<x>');
-- The key itself is never stored in a table anyone can read.

alter table companies add column if not exists asana_token_secret text;
alter table companies add column if not exists asana_capex_project_gid text;
-- Which section of the company's CapEx to-dos board a building's to-dos go in.
alter table properties add column if not exists asana_capex_section_name text;

-- Our company keeps exactly the Asana setup it has today (these were written
-- into the asana-proxy function until now).
update companies set
  asana_token_secret = coalesce(asana_token_secret, 'env:ASANA_TOKEN'),
  asana_capex_project_gid = coalesce(asana_capex_project_gid, '1210546410075012')
where name = 'Lionel Partners';
update properties set asana_capex_section_name = 'Cove Point Tasks To-Do' where code = 'CP'   and asana_capex_section_name is null;
update properties set asana_capex_section_name = 'Draper Tasks To-Do'     where code = 'VDR'  and asana_capex_section_name is null;
update properties set asana_capex_section_name = 'Cottonwood Tasks To-Do' where code = 'VCH'  and asana_capex_section_name is null;
update properties set asana_capex_section_name = 'Escalante by the lakes' where code = 'VATL' and asana_capex_section_name is null;

-- Reads a company's Asana key out of the Vault. Only our server functions (the
-- service_role key) may call it: never the site, never a signed-in person.
-- Only secrets named asana_token_... can be read this way, so a company's
-- setting can't be pointed at some other secret in the Vault.
create or replace function company_asana_token(c uuid) returns text
language sql stable security definer set search_path = public, vault as $$
  select ds.decrypted_secret
  from companies co
  join vault.decrypted_secrets ds on ds.name = co.asana_token_secret
  where co.id = c and co.asana_token_secret like 'asana\_token\_%';
$$;
revoke all on function company_asana_token(uuid) from public, anon, authenticated;
grant execute on function company_asana_token(uuid) to service_role;
