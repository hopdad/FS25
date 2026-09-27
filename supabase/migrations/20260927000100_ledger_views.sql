-- The ledger's views: which events count, and the analytics computed from them (docs/LEDGER.md).
--
-- Every view is security_invoker, so row-level security on the tables applies to whoever queries
-- it, and each one reads only the events that count: those of the save's active branch and of its
-- ancestors up to where each fork happened. A reloaded older save therefore never double-counts.

-- Which events count -------------------------------------------------------------------------------

-- The branch a save is on: the one whose latest session started last.
create view public.save_active_branch with (security_invoker = true) as
select distinct on (save_id) save_id, branch_id
from public.save_branches
order by save_id, last_session_at desc nulls last, created_at desc, branch_id;

-- The branches whose events count for each save, with the last seq that counts on each (null: all).
-- An ancestor counts up to the smallest fork seq on the way down to the active branch.
create view public.save_lineage with (security_invoker = true) as
with recursive lineage (save_id, branch_id, max_seq, depth) as (
  select a.save_id, a.branch_id, null::bigint, 0
  from public.save_active_branch a
  union all
  select l.save_id, c.parent_branch_id, least(l.max_seq, c.fork_seq), l.depth + 1
  from lineage l
  join public.save_branches c on c.save_id = l.save_id and c.branch_id = l.branch_id
  where c.parent_branch_id is not null and l.depth < 64
)
select save_id, branch_id, max_seq, depth from lineage;

create view public.ledger_events with (security_invoker = true) as
select e.*
from public.events e
join public.save_lineage l on l.save_id = e.save_id and l.branch_id = e.branch_id
where l.max_seq is null or e.seq <= l.max_seq;

-- What the events say about the world ------------------------------------------------------------

-- Selling prices per game day, station and fill type, from the daily `prices` event (F3).
create view public.prices with (security_invoker = true) as
select distinct on (e.save_id, e.day, entry ->> 'stationId', entry ->> 'fillType')
  e.save_id,
  e.day,
  e.year,
  entry ->> 'stationId' as station_id,
  entry ->> 'fillType' as fill_type,
  (entry ->> 'pricePer1000L')::numeric as price_per_1000l
from public.ledger_events e
cross join lateral jsonb_array_elements(e.data -> 'entries') as entry
where e.type = 'prices'
order by e.save_id, e.day, entry ->> 'stationId', entry ->> 'fillType', e.seq desc;

-- Every machine the ledger has seen, with its latest hours and value. hours_at_start is its hours
-- when bought, or when FarmLink first saw it for a machine the farm already had. Operating hours only
-- ever grow, so the first and latest hours are min and max; everything else that needs an order
-- takes the latest (seq desc), which lets Postgres sort each machine's events once.
create view public.vehicles with (security_invoker = true) as
with v as (
  select save_id, farm_id, seq, type, day, data, data ->> 'vehicleId' as vehicle_id,
    (data ->> 'operatingHours')::numeric as operating_hours
  from public.ledger_events
  where type in ('vehicle_added', 'vehicle_removed', 'vehicle_hours')
)
select
  save_id,
  vehicle_id,
  (array_agg(farm_id order by seq desc))[1] as farm_id,
  (array_agg(data ->> 'storeItem' order by seq desc) filter (where type = 'vehicle_added'))[1] as store_item,
  (array_agg(data ->> 'name' order by seq desc) filter (where type = 'vehicle_added'))[1] as name,
  (array_agg((data ->> 'price')::numeric order by seq desc) filter (where type = 'vehicle_added'))[1] as price,
  coalesce(
    (array_agg((data ->> 'leased')::boolean order by seq desc) filter (where type = 'vehicle_added'))[1], false
  ) as leased,
  min(day) filter (where type = 'vehicle_added') as bought_day,
  max(day) filter (where type = 'vehicle_removed' and data ->> 'reason' = 'sold') as sold_day,
  max(day) filter (where type = 'vehicle_removed') as removed_day,
  (array_agg((data ->> 'salePrice')::numeric order by seq desc)
    filter (where type = 'vehicle_removed' and data ->> 'salePrice' is not null))[1] as sale_price,
  max(operating_hours) filter (where type in ('vehicle_hours', 'vehicle_removed')) as operating_hours,
  (array_agg((data ->> 'sellValue')::numeric order by seq desc)
    filter (where type = 'vehicle_hours' and data ->> 'sellValue' is not null))[1] as sell_value,
  case
    when bool_or(type = 'vehicle_added')
      then coalesce(min(operating_hours) filter (where type = 'vehicle_added'), 0)
    else min(operating_hours) filter (where type = 'vehicle_hours')
  end as hours_at_start
from v
group by save_id, vehicle_id;

-- Field sizes and owners from the latest daily snapshot (its `fields` list): the active branch's,
-- or its parent's while the active branch has none yet.
create view public.fields with (security_invoker = true) as
with latest as (
  select distinct on (s.save_id) s.save_id, s.day, s.payload
  from public.snapshots s
  join public.save_lineage l on l.save_id = s.save_id and l.branch_id = s.branch_id
  order by s.save_id, l.depth, s.day desc
)
select
  latest.save_id,
  (f ->> 'fieldId')::integer as field_id,
  (f ->> 'farmlandId')::integer as farmland_id,
  (f ->> 'areaHa')::numeric as area_ha,
  nullif((f ->> 'ownerFarmId')::integer, 0) as owner_farm_id,
  latest.day as last_seen_day
from latest
cross join lateral jsonb_array_elements(coalesce(latest.payload -> 'fields', '[]'::jsonb)) as f;

-- Analytics ---------------------------------------------------------------------------------------

-- What each machine costs per operating hour: (capital + fuel + wages + repairs and other upkeep)
-- ÷ hours since bought. Capital is what was paid (the shop money booked to the machine, else the
-- price on vehicle_added) less what it brought back: the sale once sold (the shop money booked to
-- it, else the sale price on vehicle_removed), nothing once gone without a sale, else what the shop
-- would pay today. For a leased machine capital is the fee paid up front, and the running leasing
-- costs are upkeep. Capital is unknown for a machine the farm had before FarmLink.
-- machine_cost_per_hour leaves wages out; field P&L adds wages separately.
create view public.vehicle_cost_per_hour with (security_invoker = true) as
with money as (
  select
    save_id,
    (data ->> 'amount')::numeric as amount,
    data -> 'context' ->> 'kind' as kind,
    data -> 'context' ->> 'vehicleId' as vehicle_id
  from public.ledger_events
  where type = 'money' and data -> 'context' ->> 'vehicleId' is not null
),
costs as (
  select
    save_id,
    vehicle_id,
    -sum(amount) filter (where kind = 'shop' and amount < 0) as purchase_paid,
    sum(amount) filter (where kind = 'shop' and amount > 0) as sale_income,
    coalesce(-sum(amount) filter (where kind = 'fuel'), 0) as fuel,
    coalesce(-sum(amount) filter (where kind = 'wage'), 0) as wages,
    coalesce(-sum(amount) filter (where kind = 'vehicle'), 0) as upkeep
  from money
  group by save_id, vehicle_id
),
priced as (
  select
    v.*,
    case when v.bought_day is not null then coalesce(c.purchase_paid, v.price) end as paid,
    coalesce(c.sale_income, v.sale_price) as sold_for,
    coalesce(c.fuel, 0) as fuel,
    coalesce(c.wages, 0) as wages,
    coalesce(c.upkeep, 0) as upkeep,
    case
      when v.bought_day is null then null
      when v.leased then coalesce(c.purchase_paid, v.price)
      else coalesce(c.purchase_paid, v.price) - coalesce(
        c.sale_income,
        v.sale_price,
        case when v.removed_day is not null then 0 end,
        v.sell_value
      )
    end as capital_cost,
    greatest(coalesce(v.operating_hours, 0) - coalesce(v.hours_at_start, 0), 0) as hours
  from public.vehicles v
  left join costs c on c.save_id = v.save_id and c.vehicle_id = v.vehicle_id
)
select
  save_id,
  farm_id,
  vehicle_id,
  name,
  store_item,
  leased,
  bought_day,
  sold_day,
  paid as purchase_paid,
  sold_for as sale_income,
  sell_value,
  capital_cost,
  capital_cost is not null as capital_known,
  fuel,
  wages,
  upkeep,
  hours,
  (coalesce(capital_cost, 0) + fuel + wages + upkeep) / nullif(hours, 0) as cost_per_hour,
  (coalesce(capital_cost, 0) + fuel + upkeep) / nullif(hours, 0) as machine_cost_per_hour
from priced;

-- Hired-worker stops per season, farm and reason: how many, the game minutes each machine then stood
-- until its next start (open_stops: not restarted yet), and the wages the stopped jobs cost.
-- `outcome` sorts the reasons: finished, stopped (by the player), failed (ERROR_*) or unknown, so
-- the wages of jobs that did not finish are the `failed` rows.
create view public.worker_downtime with (security_invoker = true) as
with w as (
  select
    save_id, farm_id, year, seq, type, day * 1440 + minute as game_minute, data,
    data ->> 'vehicleId' as vehicle_id
  from public.ledger_events
  where type in ('worker_start', 'worker_stop')
),
ordered as (
  select
    w.*,
    lead(type) over (partition by save_id, vehicle_id order by seq) as next_type,
    lead(game_minute) over (partition by save_id, vehicle_id order by seq) as next_minute
  from w
)
select
  save_id,
  year as season,
  farm_id,
  data ->> 'reason' as reason,
  case
    when data ->> 'reason' in ('SUCCESS_FINISHED_JOB', 'SUCCESS_SILO_EMPTY') then 'finished'
    when data ->> 'reason' = 'SUCCESS_STOPPED_BY_USER' then 'stopped'
    when data ->> 'reason' like 'ERROR\_%' then 'failed'
    else 'unknown'
  end as outcome,
  count(*) as stops,
  coalesce(sum(next_minute - game_minute) filter (where next_type = 'worker_start'), 0) as idle_minutes,
  count(*) filter (where next_type is distinct from 'worker_start') as open_stops,
  coalesce(sum((data ->> 'wagesTotal')::numeric), 0) as wages
from ordered
where type = 'worker_stop'
group by save_id, year, farm_id, data ->> 'reason';

-- Profit and loss per field and season (game year). Revenue is the harvest valued at the season's
-- realized sale price for the fill type (grain is pooled in silos, so a sale cannot be traced to a
-- field), or at the average offered price when that fill type was not sold. Costs are inputs a
-- hired worker bought for the field, machine hours on the field at each machine's cost per hour,
-- and the wages of jobs on the field. `yields` lists every fill type the field gave.
--
-- Each part is summed on its own, and the parts are stacked and grouped once. That keeps the plan to
-- sorts, window functions and hash joins, and a save of 100,000 events under a second
-- (docs/LEDGER.md, "Performance").
create view public.field_season_pnl with (security_invoker = true) as
with harvests as (
  select
    save_id, farm_id, year, (data ->> 'fieldId')::integer as field_id, data ->> 'fillType' as fill_type,
    sum((data ->> 'liters')::numeric) as liters
  from public.ledger_events
  where type = 'harvest' and data ->> 'fieldId' is not null
  group by 1, 2, 3, 4, 5
),
sales as (
  select
    save_id, farm_id, year, data -> 'context' ->> 'fillType' as fill_type,
    sum((data ->> 'amount')::numeric) / nullif(sum((data -> 'context' ->> 'liters')::numeric), 0)
      as price_per_liter
  from public.ledger_events
  where type = 'money' and data -> 'context' ->> 'kind' = 'sale'
  group by 1, 2, 3, 4
),
market as (
  select save_id, year, fill_type, avg(price_per_1000l) / 1000 as price_per_liter
  from public.prices
  group by 1, 2, 3
),
valued as (
  select
    h.save_id, h.farm_id, h.year, h.field_id, h.fill_type, h.liters,
    coalesce(s.price_per_liter, m.price_per_liter) as price_per_liter,
    case when s.price_per_liter is not null then 'sales' when m.price_per_liter is not null then 'market' end
      as price_basis
  from harvests h
  left join sales s using (save_id, farm_id, year, fill_type)
  left join market m using (save_id, year, fill_type)
),
revenue as (
  select
    save_id, farm_id, year, field_id,
    sum(liters * price_per_liter) as revenue,
    bool_or(price_per_liter is null) as revenue_incomplete,
    (array_agg(fill_type order by coalesce(liters * price_per_liter, 0) desc, liters desc))[1] as main_fill_type,
    jsonb_agg(
      jsonb_build_object(
        'fillType', fill_type, 'liters', liters, 'pricePerLiter', price_per_liter,
        'priceBasis', price_basis, 'revenue', liters * price_per_liter
      )
      order by liters desc
    ) as yields
  from valued
  group by 1, 2, 3, 4
),
inputs as (
  select
    save_id, farm_id, year, (data -> 'context' ->> 'fieldId')::integer as field_id,
    -sum((data ->> 'amount')::numeric) as input_costs
  from public.ledger_events
  where type = 'money' and data -> 'context' ->> 'kind' = 'input' and data -> 'context' ->> 'fieldId' is not null
  group by 1, 2, 3, 4
),
machine as (
  select
    w.save_id, w.farm_id, w.year, (w.data ->> 'fieldId')::integer as field_id,
    sum((w.data ->> 'workedHours')::numeric) as machine_hours,
    sum((w.data ->> 'workedHours')::numeric * c.machine_cost_per_hour) as machine_costs
  from public.ledger_events w
  left join public.vehicle_cost_per_hour c on c.save_id = w.save_id and c.vehicle_id = w.data ->> 'vehicleId'
  where w.type in ('harvest', 'field_work') and w.data ->> 'fieldId' is not null
    and w.data ->> 'workedHours' is not null
  group by 1, 2, 3, 4
),
-- Job ids restart every session, so a wage belongs to the latest start of its job before it: `run`
-- counts the starts of a job id so far, and the first event of each run is its start.
jobs as (
  select j.*, count(*) filter (where type = 'worker_start') over (partition by save_id, job_id order by seq) as run
  from (
    select save_id, farm_id, year, seq, type, data, coalesce(data ->> 'jobId', data -> 'context' ->> 'jobId') as job_id
    from public.ledger_events
    where type = 'worker_start' or (type = 'money' and data -> 'context' ->> 'kind' = 'wage')
  ) j
),
wages as (
  select save_id, farm_id, year, field_id, -sum((data ->> 'amount')::numeric) as wages
  from (
    select jobs.*, first_value((data ->> 'fieldId')::integer) over (partition by save_id, job_id, run order by seq) as field_id
    from jobs
    where run > 0
  ) attributed
  where type = 'money' and field_id is not null
  group by 1, 2, 3, 4
),
parts as (
  select
    save_id, farm_id, year, field_id, revenue, revenue_incomplete, main_fill_type, yields,
    null::numeric as input_costs, null::numeric as machine_hours, null::numeric as machine_costs,
    null::numeric as wages
  from revenue
  union all
  select save_id, farm_id, year, field_id, null, null, null, null, input_costs, null, null, null from inputs
  union all
  select save_id, farm_id, year, field_id, null, null, null, null, null, machine_hours, machine_costs, null
  from machine
  union all
  select save_id, farm_id, year, field_id, null, null, null, null, null, null, null, wages from wages
),
totals as (
  select
    save_id, farm_id, year, field_id,
    coalesce(sum(revenue), 0) as revenue,
    coalesce(bool_or(revenue_incomplete), false) as revenue_incomplete,
    min(main_fill_type) as main_fill_type,
    (array_agg(yields) filter (where yields is not null))[1] as yields,
    coalesce(sum(input_costs), 0) as input_costs,
    coalesce(sum(machine_hours), 0) as machine_hours,
    coalesce(sum(machine_costs), 0) as machine_costs,
    coalesce(sum(wages), 0) as wages
  from parts
  group by 1, 2, 3, 4
)
select
  t.save_id,
  t.farm_id,
  t.year as season,
  t.field_id,
  f.area_ha,
  t.main_fill_type as fill_type,
  coalesce(t.yields, '[]'::jsonb) as yields,
  t.revenue,
  t.revenue_incomplete,
  t.input_costs,
  t.machine_costs,
  t.machine_hours,
  t.wages,
  t.input_costs + t.machine_costs + t.wages as costs,
  t.revenue - t.input_costs - t.machine_costs - t.wages as net,
  (t.revenue - t.input_costs - t.machine_costs - t.wages) / nullif(f.area_ha, 0) as net_per_ha
from totals t
left join public.fields f on f.save_id = t.save_id and f.field_id = t.field_id;

-- The P2 exit check (C3): between consecutive day rollovers of a farm, the money events must add up
-- to the change in its balance. One pass in seq order keeps a running total of each farm's money, so
-- the money of an interval is the difference of the totals at its two rollovers: no joins, which
-- keeps it fast however many days a save has.
create view public.money_reconciliation with (security_invoker = true) as
with stream as (
  select
    save_id, farm_id, seq, day, type,
    (data ->> 'balance')::numeric as balance,
    sum(case when type = 'money' then (data ->> 'amount')::numeric else 0 end)
      over (partition by save_id, farm_id order by seq) as money_so_far
  from public.ledger_events
  where type in ('money', 'day_rollover')
),
rollovers as (
  select
    save_id, farm_id, seq, day, balance, money_so_far,
    lag(seq) over w as prev_seq,
    lag(day) over w as prev_day,
    lag(balance) over w as prev_balance,
    lag(money_so_far) over w as prev_money_so_far
  from stream
  where type = 'day_rollover'
  window w as (partition by save_id, farm_id order by seq)
)
select
  save_id,
  farm_id,
  prev_day as from_day,
  day as to_day,
  prev_seq as from_seq,
  seq as to_seq,
  balance - prev_balance as balance_change,
  money_so_far - prev_money_so_far as money_total,
  balance - prev_balance - (money_so_far - prev_money_so_far) as difference
from rollovers
where prev_seq is not null;

-- Supabase grants new views to anon and authenticated by default; they are read-only for the
-- signed-in, and row-level security on the tables underneath decides which rows.
revoke all on
  public.save_active_branch, public.save_lineage, public.ledger_events, public.prices,
  public.vehicles, public.fields, public.vehicle_cost_per_hour, public.worker_downtime,
  public.field_season_pnl, public.money_reconciliation
from public, anon, authenticated;

grant select on
  public.save_active_branch, public.save_lineage, public.ledger_events, public.prices,
  public.vehicles, public.fields, public.vehicle_cost_per_hour, public.worker_downtime,
  public.field_season_pnl, public.money_reconciliation
to authenticated;
