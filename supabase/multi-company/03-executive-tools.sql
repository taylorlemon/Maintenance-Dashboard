-- ── Multi-company: the Executive's own setup tools ──────────────────────────
-- Run after 02-company-asana-settings.sql. Safe to re-run.
--
-- Lets the Executive set up and look after a company entirely from the site
-- (NEW-COMPANY-CHECKLIST.md), with no one working in the database by hand:
-- create a company, save or replace its Asana key, and run a health check.
-- Every function here refuses anyone who isn't the Executive.

-- Saves (or replaces) a company's Asana key in the Vault. The key goes in and
-- can never come back out to the site: company_asana_token() (02-...) is only
-- callable by the server functions.
create or replace function set_company_asana_token(c uuid, token text) returns void
language plpgsql security definer set search_path = public, vault as $$
declare
  secret_name text := 'asana_token_' || replace(c::text, '-', '');
  existing uuid;
begin
  if not is_executive() then raise exception 'Only the Executive can change a company''s Asana key.'; end if;
  if not exists (select 1 from companies where id = c) then raise exception 'Unknown company.'; end if;
  token := btrim(coalesce(token, ''));
  if length(token) < 20 then raise exception 'That doesn''t look like an Asana key.'; end if;
  select id into existing from vault.secrets where name = secret_name;
  if existing is null then
    perform vault.create_secret(token, secret_name, 'Asana key for company ' || c);
  else
    perform vault.update_secret(existing, token);
  end if;
  update companies set asana_token_secret = secret_name where id = c;
end;
$$;

create or replace function create_company(company_name text, asana_token text, capex_project_gid text) returns uuid
language plpgsql security definer set search_path = public as $$
declare new_id uuid;
begin
  if not is_executive() then raise exception 'Only the Executive can add a company.'; end if;
  company_name := btrim(coalesce(company_name, ''));
  if company_name = '' then raise exception 'Enter the company''s name.'; end if;
  if exists (select 1 from companies where lower(name) = lower(company_name)) then
    raise exception 'There''s already a company called "%".', company_name;
  end if;
  insert into companies (name, asana_capex_project_gid)
    values (company_name, nullif(btrim(coalesce(capex_project_gid, '')), ''))
    returning id into new_id;
  if btrim(coalesce(asana_token, '')) <> '' then
    perform set_company_asana_token(new_id, asana_token);
  end if;
  return new_id;
end;
$$;

-- Everything about a company's setup that can be checked inside the database.
-- (Whether its Asana key and IDs actually work is checked by the asana-proxy
-- server function, which is the only thing that can use the key.)
create or replace function company_health(c uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare result jsonb;
begin
  if not is_executive() then raise exception 'Only the Executive can run a health check.'; end if;
  select jsonb_build_object(
    'buildings',             (select count(*) from properties where company_id = c),
    'buildingsMissingAsana', (select coalesce(jsonb_agg(name order by name), '[]') from properties where company_id = c
                                and (asana_project_gid is null or asana_pm_section_gid is null or asana_rt_section_gid is null
                                  or asana_compliance_section_gid is null or asana_capex_section_name is null)),
    'people',                (select count(*) from profiles where company_id = c),
    'admins',                (select count(*) from profiles where company_id = c and role = 'admin'),
    'peopleWithNoBuildings', (select coalesce(jsonb_agg(email order by email), '[]') from profiles p where company_id = c and role <> 'admin'
                                and not exists (select 1 from profile_properties pp where pp.profile_id = p.id)),
    'vendors',               (select count(*) from vendors where company_id = c),
    -- These two should always be empty; the access rules stop them happening.
    'crossCompanyAssignments', (select count(*) from profile_properties pp join profiles p on p.id = pp.profile_id
                                join properties pr on pr.code = pp.property_code where p.company_id = c and pr.company_id <> c),
    'crossCompanyVendorLinks', (select count(*) from vendor_properties vp join vendors v on v.id = vp.vendor_id
                                join properties pr on pr.code = vp.property_code where v.company_id = c and pr.company_id <> c),
    'asanaKeySaved',         (select asana_token_secret is not null from companies where id = c),
    'capexBoardSet',         (select asana_capex_project_gid is not null from companies where id = c),
    -- Logins that were invited but never attached to any company (they can see nothing).
    'loginsWithNoCompany',   (select count(*) from profiles where company_id is null)
  ) into result;
  return result;
end;
$$;

revoke all on function set_company_asana_token(uuid, text) from public, anon;
revoke all on function create_company(text, text, text) from public, anon;
revoke all on function company_health(uuid) from public, anon;
grant execute on function set_company_asana_token(uuid, text) to authenticated;
grant execute on function create_company(text, text, text) to authenticated;
grant execute on function company_health(uuid) to authenticated;
