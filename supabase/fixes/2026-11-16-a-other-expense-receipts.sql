-- Fix A (2026-11-16): receipts for "Other Expenses" (CapEx not tied to a project).
--
-- Receipt files live in the "receipts" bucket under a folder named after their
-- project ("<project id>/<file>"), and the storage rules look that project up to
-- decide who may see, upload or delete the file. An other expense has no
-- project, so its receipts go under the EXPENSE's own id instead
-- ("<expense id>/<file>"). This teaches the receipts rules to recognise that
-- kind of folder too, using the same can_see_property / can_edit_property walls
-- as everything else. The approvals bucket is unchanged.
--
-- Safe to re-run.

create or replace function folder_expense_property(folder text) returns text
language sql stable security definer set search_path = public as $$
  select property_code from expenses where id::text = folder and project_id is null;
$$;

drop policy if exists "receipts readable by scope" on storage.objects;
create policy "receipts readable by scope" on storage.objects
  for select using (bucket_id = 'receipts' and can_see_property(coalesce(
    folder_project_property((storage.foldername(name))[1]),
    folder_expense_property((storage.foldername(name))[1]))));

drop policy if exists "receipts insertable by editors" on storage.objects;
create policy "receipts insertable by editors" on storage.objects
  for insert with check (bucket_id = 'receipts' and can_edit_property(coalesce(
    folder_project_property((storage.foldername(name))[1]),
    folder_expense_property((storage.foldername(name))[1]))));

drop policy if exists "receipts deletable by editors" on storage.objects;
create policy "receipts deletable by editors" on storage.objects
  for delete using (bucket_id = 'receipts' and can_edit_property(coalesce(
    folder_project_property((storage.foldername(name))[1]),
    folder_expense_property((storage.foldername(name))[1]))));
