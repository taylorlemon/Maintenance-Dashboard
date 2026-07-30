-- Fix A (2026-07-30): storage rules locked Editors and Viewers out of every file.
-- See SECURITY-AUDIT.md finding #1.
--
-- The rules were meant to check the uploaded file's folder (which is the
-- project/vendor id) against the properties the signed-in person can see.
-- Inside the subquery, `name` was written unqualified — so Postgres resolved
-- it to `projects.name` / `vendors.name` (the project's or vendor's *title*)
-- instead of `storage.objects.name` (the file's path). Comparing a uuid to a
-- title never matches, so the EXISTS was always false and every non-admin was
-- denied read, upload, and delete on all three buckets. Admins were unaffected
-- because of the separate is_admin() branch.
--
-- The only change below is qualifying it as `objects.name`. Verified before
-- applying: the old expression matched 0 stored files, the corrected one
-- matches all 11.
--
-- Safe to re-run.

-- ── receipts ────────────────────────────────────────────────────────────────

drop policy if exists "receipts readable by scope" on storage.objects;
create policy "receipts readable by scope" on storage.objects
  for select using (
    bucket_id = 'receipts' and (
      is_admin() or exists (
        select 1 from projects pr
        where pr.id::text = (storage.foldername(objects.name))[1]
          and pr.property_code in (select my_property_codes())
      )
    )
  );

drop policy if exists "receipts insertable by editors" on storage.objects;
create policy "receipts insertable by editors" on storage.objects
  for insert with check (
    bucket_id = 'receipts' and (
      is_admin() or (is_editor() and exists (
        select 1 from projects pr
        where pr.id::text = (storage.foldername(objects.name))[1]
          and pr.property_code in (select my_property_codes())
      ))
    )
  );

drop policy if exists "receipts deletable by editors" on storage.objects;
create policy "receipts deletable by editors" on storage.objects
  for delete using (
    bucket_id = 'receipts' and (
      is_admin() or (is_editor() and exists (
        select 1 from projects pr
        where pr.id::text = (storage.foldername(objects.name))[1]
          and pr.property_code in (select my_property_codes())
      ))
    )
  );

-- ── approvals ───────────────────────────────────────────────────────────────

drop policy if exists "approvals readable by scope" on storage.objects;
create policy "approvals readable by scope" on storage.objects
  for select using (
    bucket_id = 'approvals' and (
      is_admin() or exists (
        select 1 from projects pr
        where pr.id::text = (storage.foldername(objects.name))[1]
          and pr.property_code in (select my_property_codes())
      )
    )
  );

drop policy if exists "approvals insertable by editors" on storage.objects;
create policy "approvals insertable by editors" on storage.objects
  for insert with check (
    bucket_id = 'approvals' and (
      is_admin() or (is_editor() and exists (
        select 1 from projects pr
        where pr.id::text = (storage.foldername(objects.name))[1]
          and pr.property_code in (select my_property_codes())
      ))
    )
  );

drop policy if exists "approvals deletable by editors" on storage.objects;
create policy "approvals deletable by editors" on storage.objects
  for delete using (
    bucket_id = 'approvals' and (
      is_admin() or (is_editor() and exists (
        select 1 from projects pr
        where pr.id::text = (storage.foldername(objects.name))[1]
          and pr.property_code in (select my_property_codes())
      ))
    )
  );

-- ── vendor-contracts ────────────────────────────────────────────────────────

drop policy if exists "vendor-contracts readable by scope" on storage.objects;
create policy "vendor-contracts readable by scope" on storage.objects
  for select using (
    bucket_id = 'vendor-contracts' and (
      is_admin() or exists (
        select 1 from vendors v
        where v.id::text = (storage.foldername(objects.name))[1]
          and v.property_code in (select my_property_codes())
      )
    )
  );

drop policy if exists "vendor-contracts insertable by editors" on storage.objects;
create policy "vendor-contracts insertable by editors" on storage.objects
  for insert with check (
    bucket_id = 'vendor-contracts' and (
      is_admin() or (is_editor() and exists (
        select 1 from vendors v
        where v.id::text = (storage.foldername(objects.name))[1]
          and v.property_code in (select my_property_codes())
      ))
    )
  );

drop policy if exists "vendor-contracts deletable by editors" on storage.objects;
create policy "vendor-contracts deletable by editors" on storage.objects
  for delete using (
    bucket_id = 'vendor-contracts' and (
      is_admin() or (is_editor() and exists (
        select 1 from vendors v
        where v.id::text = (storage.foldername(objects.name))[1]
          and v.property_code in (select my_property_codes())
      ))
    )
  );
