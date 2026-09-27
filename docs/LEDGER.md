# The ledger (P2)

The mod writes every money, harvest, field-work, machine and hired-worker event to an append-only
log. The bridge copies each line into the Supabase table `events`, keyed by
`(save_id, branch_id, seq)`. Everything else is computed by SQL views, so the web app only reads,
and one set of formulas serves every screen.

The formulas are pinned by golden fixtures in
[`packages/schema/fixtures/ledger/`](../packages/schema/fixtures/ledger): event lines in, the rows
each view must hold out. The SQL views run them today (`supabase/test/analytics.test.ts`); the
mod's in-game ledger (P3) will run the same files, so the two implementations cannot drift apart.

## Tables

| Table | Key | What it holds |
| --- | --- | --- |
| `saves` | `id`, the mod's saveId | Owner, name, map, mod version, last sync |
| `save_members` | `(save_id, user_id)` | Who else sees the save: `member` (reads and syncs) or `viewer` (reads) |
| `save_branches` | `(save_id, branch_id)` | Each line of play: its parent, where it forked, when it was last played |
| `events` | `(save_id, branch_id, seq)` | Every event line, append-only; a repeated insert does nothing |
| `snapshots` | `(save_id, branch_id, day)` | Once per game day: the `farm` object of `live_farm.json` |

Migrations: [`supabase/migrations/`](../supabase/migrations). The bridge never inserts branches
itself: an event's insert trigger creates its branch, and a `session` event records where the
branch forked and when it was played.

## The event log in the game

The mod writes each event as one JSON line to
`modSettings/FS25_FarmLink/<saveId>/events/<day>.ndjson`, where the day is the game day it happened
on. Lines go out in batches: once a second of real time, when the career is saved, and when the
session ends. The code is `mod/FS25_FarmLink/scripts/core/EventLog.lua`.

- **Seqs never repeat.** `heads.xml`, next to the log, holds the highest seq claimed on each branch.
  Every batch claims its seqs there before its lines are written. A crash can therefore leave a gap,
  which the bridge reports, but never write the same key twice (PLAN_REVIEW.md F2).
- **The savegame knows where it stands.** `farmLink.xml` in the savegame folder records the branch
  and seq the save was made at. Before recording it, every module flushes what it is still
  collecting, and the log writes it.
- **Loading an older save forks.** If the savegame's seq is behind its branch's head in
  `heads.xml`, events were logged that this savegame never saw. The session then starts a new branch
  that continues from the savegame's seq. Its first line, a `session` event, names the parent branch
  and the fork seq. Loading a save and quitting without saving has the same effect the next time that
  save is loaded.
- **If the game refuses append mode** (F1, answered by the P0 probe), the log keeps a file open per
  day instead, named `<day>-<session>-<n>.ndjson`.

The bridge reads each complete line and checks it against the contract. It then runs the gap check:
each branch starts at 1, or right after its fork seq, and has no holes. `--doctor` reports both in
its "Event log" line, along with the write mode the mod is using.

## Which events count

Reloading an older savegame starts a new branch (PLAN_REVIEW.md F2). Its first event is a `session`
event carrying `parentBranchId` and `forkSeq`, the seq the savegame was at, and its seqs continue from
there. The views count:

- the **active branch**, the one whose latest `session` started last (`save_active_branch`), in full;
- each **ancestor** up to the smallest fork seq on the way down to it (`save_lineage`).

Events of abandoned branches, and an ancestor's events after the fork, never count. Loading a
branch's latest savegame again continues that branch and makes it active again. `ledger_events` is
the counted events, and every analytics view reads from it.

## Seasons

A season is the game year, `environment.currentYear`, which every event carries in the envelope
(`year`). It is recorded rather than derived from the day number because days per month can change
mid-save (C1).

## Analytics

### `vehicle_cost_per_hour`

One row per machine the ledger has seen.

```text
cost_per_hour         = (capital + fuel + wages + upkeep) / hours
machine_cost_per_hour = (capital + fuel + upkeep) / hours
hours                 = latest operating hours - hours when bought (or first seen)
```

- **Capital** is what was paid less what the machine brought back.
  - Paid: the `shop` money booked to the machine, else its `vehicle_added` price.
  - Brought back: once sold, the `shop` money booked to the sale, else the `salePrice` on
    `vehicle_removed`. Nothing once gone without a sale. Otherwise today's `sellValue` from
    `vehicle_hours`.
- **Leased machine.** Capital is the fee paid up front; the running leasing costs are upkeep.
- **A machine the farm had before FarmLink.** There is no purchase to go on, so capital is unknown
  (`capital_known = false`) and only its running costs count.
- **Fuel, wages, upkeep.** `money` events whose context names the machine: `fuel`, `wage`, and
  `vehicle` (repairs, leasing, paint).

### `field_season_pnl`

One row per field and season. The handoff asks for one per field, fill type and season. Costs cannot
be split between the crops of one field, so the row lists every fill type the field gave in `yields`,
and `fill_type` is the one that earned most.

```text
revenue = Σ liters harvested × price per liter          (per fill type)
costs   = input costs + machine costs + wages
net     = revenue − costs;  net_per_ha = net / area_ha
```

- **Price per liter.** Grain is pooled in silos, so a sale cannot be traced to a field.
  - `sales`: the farm's realized price for that fill type in that season, total sale income ÷
    liters sold.
  - `market`: when none was sold, the average offered price of that season from the daily `prices`
    event.
  - If neither exists, revenue for that fill type is missing and `revenue_incomplete` is true.
- **Input costs.** `money` events with an `input` context for the field: seed, fertilizer or spray a
  hired worker bought on the spot. Inputs taken from the farm's own storage were paid for when they
  were bought, and are not a field cost here.
- **Machine costs.** Each harvest and field-work event's `workedHours` × that machine's
  `machine_cost_per_hour`. A machine without a known cost adds hours but no cost.
- **Wages.** `money` events with a `wage` context, credited to the field of their job. Job ids
  restart every session, so a wage belongs to the latest `worker_start` of its job id before it.
- **Area.** From the latest snapshot's `fields` list; `null` for a field no snapshot has listed.

### `worker_downtime`

One row per season, farm and stop reason.

| Column | Meaning |
| --- | --- |
| `outcome` | `finished` (`SUCCESS_FINISHED_JOB`, `SUCCESS_SILO_EMPTY`), `stopped` (`SUCCESS_STOPPED_BY_USER`), `failed` (`ERROR_*`) or `unknown` |
| `stops` | How many jobs ended with this reason |
| `idle_minutes` | Game minutes from each stop to that machine's next start |
| `open_stops` | Stops with no restart yet |
| `wages` | What those jobs cost; for jobs that did not finish, sum the `failed` rows |

### `money_reconciliation`

The P2 exit check (C3). Between two consecutive `day_rollover` events of a farm, the `money` events
must add up to the change in its balance. `difference` should be 0; the exit criterion allows 1.

### Also available

| View | What it holds |
| --- | --- |
| `prices` | Daily selling prices per station and fill type |
| `vehicles` | Every machine's latest hours and value |
| `fields` | Field sizes and owners |
| `my_saves()` | The caller's saves with their role on each |

## Access

Row-level security is on for every table, and every view runs as its caller
(`security_invoker`), so a view shows exactly the rows its tables would.

| | Owner | Member | Viewer | Anyone else |
| --- | --- | --- | --- | --- |
| Read the save, its events and its analytics | yes | yes | yes | no |
| Sync events and snapshots | yes | yes | no | no |
| Update name, map, mod version, last sync | yes | yes | no | no |
| Add or remove members | yes | no | no | no |
| Leave the save | | yes | yes | |
| Delete the save | yes | no | no | no |

- **Events are append-only.** Nobody can update or delete one: the grants leave both out.
- **anon has no access at all.** Supabase grants new tables and functions to `anon` and
  `authenticated` by default, so the migrations revoke everything and grant back only what is
  needed.
- **The bridge writes as the signed-in player**, never with the service role.

## What the mod writes today

| Event | Written by | When |
| --- | --- | --- |
| `session` | `core/EventLog.lua` | First line of every session; names the parent branch after a fork |
| `money` | `ledger/MoneyFunnel.lua` | Every balance change, with its context |
| `worker_start`, `worker_stop` | `hooks/AIWorkers.lua` | A hired worker starts or stops; the stop carries the job's wages |
| `harvest` | `ledger/Harvest.lua` | Liters a combine threshed on a field, gathered per machine, field and fill type |
| `field_work` | `ledger/FieldWork.lua` | Hectares sown, sprayed, fertilized or tilled on a field, with the input used |
| `vehicle_added`, `vehicle_removed` | `ledger/Machines.lua` | A machine bought, leased, sold, given back or gone, with the shop money paired with it |
| `vehicle_hours` | `ledger/Machines.lua` | Every machine's first hours; then, before each rollover, the machines whose hours changed |
| `day_rollover` | `ledger/DayRollover.lua` | A new day, once per player farm, after everything gathered is written |
| `prices` | `ledger/Prices.lua` | Session start and every new day |

**The money funnel.** Each booking takes its context from the game function it happened in:

| Context | Game function |
| --- | --- |
| `sale` | `SellingStation.sellFillType` |
| `fuel` | `FillTrigger.fillVehicle` |
| `wage` | `AIJob.updateCost` and `AIJob.stop` |
| `input` | Seed a hired worker buys in `SowingMachine.onEndWorkAreaProcessing`; fertilizer it buys in `Sprayer.onStartWorkAreaProcessing` |
| `vehicle` | Repairs, in `WearableRepairEvent.run` |
| `none` | Everything else |

The context is set for the duration of that call and read by the booking inside it. The handoff's
context stack instead holds entries for up to 1 s; a scoped context cannot attach to an unrelated
booking. Fuel, wages and bought inputs arrive every frame or so, and are gathered into one event with
a `count` (F3). Everything else is written as it happens.

**Harvest and field work.**
- Harvest comes from `Combine.addCutterArea`, which returns the liters actually added.
- Field work comes from what each tool reports through `updateFarmStats` inside its
  `onEndWorkAreaProcessing`:
  - `SowingMachine`: seeding, with the seed used.
  - `Sprayer`: spraying (herbicide) or fertilizing, with what was sprayed.
  - `Cultivator` and `Plow`: tillage.
- Both are gathered per machine, field and kind, and written once the machine stops, every 30 s while
  it goes on, when it moves to another field, and before a rollover or a save.
- The field comes from the machine's position. On contract land it is left out.
- Field work is credited to the machine pulling the tool, which has the operating hours, fuel and
  wages. `workedHours` is that machine's operating time over the gathered stretch.

**Machines (the fleet diff).**
- The game's `VEHICLE_ADDED` and `VEHICLE_REMOVED` do not say which machine, and loading a savegame
  adds every machine too. So the mod compares the farm's machines with the ones it knows every 2 s.
- The first comparison of a session, once the mission has started, only takes stock. A machine the
  ledger has never seen gets its baseline `vehicle_hours`, not a purchase.
- The machines the ledger knows are kept in the savegame's `farmLink.xml`, with the operating time
  last written for each, so they roll back with the save.
- **Pairing with the money.** A purchase is booked once the machine has loaded, and a sale as it
  goes. A machine that appears or leaves alone on its farm takes that farm's matching shop booking
  from the money funnel: `SHOP_VEHICLE_BUY`, `LEASING_COSTS` or `SHOP_VEHICLE_SELL`. It waits up to
  10 s for one; with none, a purchase keeps the store price (for a lease, the game's up-front fee
  for it), and a departure is `deleted` or, if leased, `returned`.
- **Machines that appear together** (a pack) share one booking, so each keeps its store price.
- **A machine reset to the shop** is deleted and loaded again under the same id. If it comes back
  within those 10 s, it never left.
- A save settles whatever is still waiting, so those events come before the savegame's seq.
- Only what the game lists in its vehicle overview counts (owned or leased, not contract equipment
  or pallets), and only for a player farm.

**Not written yet:** the `shop` money context, and the hourly gathering of periodic money such as
upkeep. Each waits on an answer from the P0 session's probe.

## What the mod and bridge must send

These are requirements for the P2 event log (mod) and sync (bridge), which follow this schema.

- **The year.** Every event carries it in the envelope.
- **Money context**, which is what ties an amount to a machine, a field or a sale:
  - `sale`: selling fill types, with station, fill type and liters.
  - `fuel`: buying fuel, with the machine.
  - `wage`: hired-worker wages, with the job and machine.
  - `shop`: buying, leasing or selling machines, with the machine once its id is known.
  - `input`: seed, fertilizer or spray a hired worker buys, with the field.
  - `vehicle`: repairs, repaint, running leasing costs.
  - `none`: everything else.
- **`workedHours`** on `harvest` and `field_work`. These are the operating hours the machine logged
  over the flushed interval, credited to the machine that logs operating hours.
- **Baseline hours.** The first session on a save writes one `vehicle_hours` for every machine,
  including its `sellValue`. After that, only machines whose hours changed, once a day.
- **`vehicle_added` and `vehicle_removed`.**
  - `vehicle_added` is only for machines bought or leased while FarmLink runs, with `operatingHours`
    for a used one. Machines found at the first session are baseline hours, not purchases.
  - `price` is what was paid, and for a lease the fee paid up front. `vehicle_removed` carries the
    `salePrice` of a sale, and says `returned` for a leased machine given back.
  - A machine reset to the shop is still the same machine, so the mod must not report it as
    removed and added.
- **Flush before a save.** Flush every coalescing bucket before `day_rollover` (F3), and also
  before the savegame records its seq. Otherwise a reload restores a balance that already includes
  money the log only wrote after the save.
- **Contract (mission) work.** It is not the farm's field work, so harvest and field work on a
  mission field carry `fieldId: null`.
- **Snapshots.** The bridge upserts one per game day and branch: the `farm` object of
  `live_farm.json`, which now carries `fields`.
- **Order.** The bridge inserts each branch's lines in seq order, in batches with
  `on conflict do nothing`.

## Known limits

- **Machine cost per hour is lifetime to date.** As a machine ages, its current value and hours
  change, and so do the machine costs of past seasons.
- **An idle machine's value.** Its `sellValue` is written with its hours, so it is only refreshed
  when the machine next works.
- **Pairing a machine with its money** assumes the shop books within 10 s of the machine appearing
  or leaving, under `SHOP_VEHICLE_BUY`, `LEASING_COSTS` and `SHOP_VEHICLE_SELL`. The P0 probe's
  `shop` section checks that in the game. Machines bought as a pack keep their store prices.
- **Trailed implements.** A trailed tool logs no operating hours of its own, so its capital reaches
  field P&L only if the mod credits it the tractor's hours.
- **Winter crops.** A crop sown in autumn is costed in that year and earns in the next, because a
  season is the game year.
- **Market price.** The average over every station and day of the season, not the station the farm
  sells at.
- **Taken saveIds.** A saveId another user already owns makes the second user's sync fail (see the
  risk "Global saveIds" in PLAN_REVIEW.md).

## Performance

`supabase/test/scale.test.ts` builds a save of 100,000 events (1,000 game days) and times every
view. It is the P4 exit criterion ("under 1 s for a save with 100k events"), run ahead of time with
`SCALE_TEST=1`.

| View | Time on the development container (Postgres 16) |
| --- | --- |
| `field_season_pnl` | 0.5 s; 0.85 s when Postgres JIT-compiles the query |
| `vehicle_cost_per_hour` | 0.19 s |
| `money_reconciliation` | 0.10 s |
| `prices`, `worker_downtime` | under 0.1 s |

These times include reading every row into Node. The views are written as sorts, window functions
and hash joins with no range joins; the first version, with range joins, took 21 s for field P&L.
If JIT dominates on the Supabase project, `alter role authenticated set jit = off` is the fix to
measure in P4.

## Running the tests

```sh
pnpm --filter @farmlink/supabase test                 # schema, RLS, branches, golden fixtures
SCALE_TEST=1 pnpm --filter @farmlink/supabase test    # plus the 100k-event timing
```

The tests need Postgres. With `DATABASE_URL` set they use that server, and they need permission to
create databases there. Otherwise they start a throwaway cluster from the local Postgres binaries
(`PG_BIN`, `pg_config`, `/usr/lib/postgresql/*/bin` or `PATH`). Without either they are skipped,
unless `REQUIRE_POSTGRES` is set, as it is in CI. `supabase/test/shim.sql` stands in for what a
Supabase project provides: the API roles, `auth.uid()` and the default grants.
