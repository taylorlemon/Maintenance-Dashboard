-- ── StoneAnchor Rooms, part 3: which rooms generate the most work orders ───
-- Run after supabase/rooms/02-equipment.sql. Safe to re-run.
--
-- For the "Most work orders" panel at the top of the Rooms tab's room list:
-- how many work orders each room had since a date (or ever), and how many of
-- those are still open. Only the Work Orders lists count — not PM (scheduled
-- by the building) or room turns (move-outs) — and cancelled ones don't count.
-- Work orders typed with another spelling of a room ("Apt 118") count toward
-- that room, the same matching the room pages use.
--
-- Not security definer: the task rules still decide what each person sees.

create or replace function room_work_order_counts(p_code text, p_since timestamptz default null)
returns table (room_id uuid, total bigint, open_count bigint)
language sql stable set search_path = public as $$
  with k as materialized (select * from room_keys(p_code))
  select k.room_id, count(*), count(*) filter (where t.completed_at is null)
    from k
    join tasks t on t.property_code = p_code and room_key(t.room) = k.k
    join task_lists l on l.id = t.list_id and l.kind = 'work_orders'
   where t.cancelled_at is null
     and (p_since is null or t.created_at >= p_since)
   group by k.room_id;
$$;

revoke all on function room_work_order_counts(text, timestamptz) from public, anon;
grant execute on function room_work_order_counts(text, timestamptz) to authenticated;
