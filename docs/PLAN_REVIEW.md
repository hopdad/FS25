# Plan review

Review of [HANDOFF.md](HANDOFF.md) (Sep 26, 2026), done before writing mod code. The
source-level answers to the verify-first items are in [VERIFY_FIRST.md](VERIFY_FIRST.md); this
document covers what those answers mean for the plan.

## Verdict

The plan is sound. Files-only transport, a server-authoritative ledger from P0, the
`(saveId, branchId, seq)` natural key and the phase gates are the right calls, and nothing found
here argues against them. Reading real FS25 code turned up three problems that would have surfaced
as rework in P1 and P2 (F1 to F3), one hook choice worth measuring before P2 (F4), and one feature
that cannot work as specified (F5). None of them blocks P0.

Each finding is marked:

- **Adopted**: the code on this branch already follows the recommendation. It changes no locked
  decision; edit this file to override.
- **Decision**: it touches a locked decision or product scope, so it waits for you.

## Findings

### F1. The mod cannot read text files (Adopted, pending P0 confirmation)

VDTelemetry, the most complete FS25 file-channel mod, reports that the FS25 sandbox allows
`io.open` in write mode only; `XMLFile` is the only way a mod reads a file. The handoff has the mod
reading two JSON files: `commands.ndjson` and `bridge.json`.

- Files the bridge writes for the mod become XML, read with `XMLFile.loadIfExists`:
  - `commands.xml`: the bridge rewrites the whole file (temp file, then rename) with a ring of
    recent commands. The mod keeps its persisted watermark and processes ids above it in order,
    exactly as specified. VDTelemetry runs this design in production.
  - `bridge.xml`: bridge version and a heartbeat counter.
- Files the mod writes stay JSON and NDJSON.
- If P0 shows append mode is blocked too, the `events/` files become per-session segments written
  through a handle that stays open and is flushed per batch, and acks become `acks.json` (a ring of
  recent results). The bridge tails a glob either way, so only file names change.
- Liveness uses counters instead of comparing timestamps across processes. The mod treats the
  bridge as present when `bridge.xml`'s counter changed within the last 10 s of its own clock. TTL
  checks compare local wall-clock strings, which is safe because the bridge and the game always run
  on the same machine.

### F2. Branch detection can reuse sequence numbers after a crash (Adopted for P2)

The fork rule compares the savegame's seq high-water with `meta.json` `lastSeq`, and `meta.json`
is written every 60 s.

- **Scenario.** Save at seq 100. Keep playing; events 101 to 105 are appended; `meta.json` still says
  100. The game crashes, or the player quits without saving. On reload, savegame 100 equals meta 100,
  so no fork happens and the next events reuse seq 101 to 105 on the same branch. The Supabase
  upsert with `ignoreDuplicates` then keeps the orphaned events and silently drops the real ones.
- **Second case.** `lastSeq` is a single value per saveId. A player who copies savegame1 to savegame2
  has two saves sharing one saveId, and one number cannot describe both branches.

Fix:

- `meta.json` keeps `heads: { branchId: lastSeq }`, written before each event batch is appended
  (claim, then write). A crash can then leave a gap, which the gap check reports, but never a
  duplicate key.
- Fork when the savegame's seq is lower than `heads[savegame branch]`.
- Record lineage in the log itself: the `session` event on a new branch carries `parentBranchId`
  and `forkSeq`, and the bridge upserts `save_branches` from it. Today no event tells the bridge a
  branch exists.

### F3. Event volume at high time scales (Adopted for P2)

Several producers are specified per game-time unit, and players run up to 120x. At 120x a game
hour is 30 real seconds and a game day is 12 real minutes.

| Producer | As specified | At 120x | Recommendation |
| --- | --- | --- | --- |
| Hourly per-object money (e.g. `PlaceableIncomePerHour`, upkeep) | One `money` event per object per game hour | 10 objects = 20 events per real minute | Coalesce per (farm, moneyType, context key) per game hour; flush before `day_rollover` |
| AI wages | One `money` event per `addMoney` call | About one per worker per minute of `dt` | Coalesce per job; flush on stop, on day rollover and every 5 real minutes |
| Harvest and field work | Flush every 30 game-seconds | Every 0.25 real seconds per machine | Flush every 30 real seconds, on field change, on stop and on day rollover |
| Prices | One `price` event per station per fill type per day | About 600 per game day | One `prices` event per day carrying a compact table |
| `vehicle_hours` | One per vehicle per day | 50 per game day for 50 vehicles | Only vehicles whose hours changed |
| Snapshots | One per game hour, taken from `live_farm.json` | Not achievable: `live_farm.json` is written every 60 real seconds, which is 2 game hours | One snapshot per game day |

Discrete money (sales, shop, missions, loans) stays one event per transaction. Coalesced
entries carry a `count`. Reconciliation stays exact because every bucket flushes before the
`day_rollover` event and reconciliation is defined over seq intervals (C3).

Storage: an event row with indexes is roughly 400 to 600 bytes in Postgres, so about 1 million
events fill 0.5 GB, the whole Supabase free-plan database. Pick a retention rule before P4, for
example compacting raw events older than N seasons into daily aggregates.

### F4. Which money hook to trust (Decision, measured in P0)

The locked decision wraps `g_currentMission:addMoney`. `addMoney` books through
`Farm:changeBalance(amount, moneyType)`, and TransactionLog, the most thorough FS25 money logger
found, hooks `Farm.changeBalance` instead. No FS25 code seen here calls `changeBalance` directly,
so a bypass is unproven. Two smaller points:

- Wrapping the mission instance misses any caller that invokes `FSBaseMission.addMoney` through
  the class.
- `addMoney` with `farmId` 0 changes no balance and must not produce an event.

The P0 probe counts `changeBalance` calls that happen outside `addMoney` during a real session.
**Recommendation:** if the count is not zero, move the funnel to `Farm.changeBalance`. It is still
one hook, so the rationale of the locked decision holds. Pre-approving that switch now keeps P2
unblocked.

### F5. Web Push cannot work from the LAN page (Decision)

Service workers and the Push API only run in a secure context. `http://<lan-ip>:8790` is not one,
and iOS only delivers Web Push to web apps installed on the Home Screen, which also need HTTPS. The
P2 item "Web Push for background phone alerts" cannot ship from the bridge-served page. Options:

1. Subscribe from the web app's HTTPS origin, store the subscription in Supabase, and have the bridge
   send VAPID pushes itself (it has internet access). This needs the account tier.
2. For LAN-only players, post alerts to ntfy (free phone app, self-hostable) or the Discord webhook
   that is already planned for P5.
3. Self-signed TLS on the LAN. Poor phone experience; not recommended.

**Recommendation:** 1 for account holders and 2 (ntfy) for LAN-only players.

### F6. Magic-link sign-in does not fit a console executable (Adopted for P2)

Magic links open on whichever device reads the email, usually the phone, and then redirect to a
URL the bridge cannot catch. Supabase email OTP (a 6-digit code typed into the bridge console,
then `verifyOtp`) uses the same accounts and needs no redirect URL.

### F7. How hooks must be installed (Adopted)

- **Specialization functions.** `Combine.addCutterArea`, the work-area functions and the
  `Motorized` fuel path are copied into vehicle types when types are finalized. Reassigning them
  after load has no effect; they are hooked with `SpecializationUtil.registerOverwrittenFunction`
  from an appended `registerOverwrittenFunctions`, at file scope.
- **Specialization events are different.** `SpecializationUtil.raiseEvent` calls
  `spec[eventName]` on the specialization's class each time the event fires. A listener such as
  `SowingMachine.onEndWorkAreaProcessing` can therefore be wrapped on the class, at file scope, and
  the wrapper reaches every vehicle. The P2 probe confirms this in the game.
- **Reloads.** Mod Lua state survives a savegame reload. Class-method hooks are installed once per
  process behind a guard; per-mission state is reset in `loadMap` and `deleteMap`, and message-center
  subscriptions are removed in `deleteMap`. Otherwise the second save loaded in one game session
  inherits the first one's saveId and double-counts every hook.

### F8. The live vehicle channel in multiplayer (Decision)

"Every hook and collector runs only on the server" means a dedicated server has no local player, so
`live_vehicle.json` is empty, and a player-hosted game tracks only the host's vehicle.

**Recommendation:** let read-only live collectors run on any instance with a local player. They
change no game state, so server authority is intact. Ledger events and commands stay server-only.
A client player can then run their own bridge for their own phone. The code keeps the specified
server-only gate until you decide; it is one flag per module.

## Contract refinements (Adopted in `packages/schema`)

All additive or naming-level.

- **C1. Day numbering.** `day` is `environment.currentMonotonicDay`, because days per month can
  change mid-save (`PERIOD_LENGTH_CHANGED`). Every event also carries `year`
  (`environment.currentYear`), so seasons come straight from the log without assuming a calendar;
  `day_rollover` and `session` add `period`, `dayInPeriod` and `daysPerPeriod`.
- **C2. Wall-clock time.** FS25 exposes local time only (`getDate`). `realTs` is written as RFC 3339
  with the local offset when `%z` yields one, for example `2026-09-26T11:04:05-04:00`. The bridge
  normalizes to UTC before upserting.
- **C3. Reconciliation.** Defined over seq intervals between consecutive `day_rollover` events per
  farm, not by the `day` field, so money booked in the rollover frame is counted consistently.
- **C4. Identifiers.**
  - `vehicleId` is `vehicle:getUniqueId()`, which persists in the savegame.
  - `userId` is FS25's `uniqueUserId`, an opaque string. It is not a Steam id and is never
    rewritten into one.
  - `jobId` restarts every session (`AISystem.NEXT_JOB_ID`). It is valid for commands and for
    pairing a stop with its start within a session; cross-session joins use `vehicleId`, and the
    persisted worker registry is keyed by vehicle.
- **C5. Stop reasons.** Stop reasons are the names registered with `aiMessageManager`.
- **C6. Live channel payloads.** Each payload is nested under the channel name (`vehicle`, `fleet`,
  `farm`), so "on foot" is `"vehicle": null` rather than a frame with missing keys.
- **C7. Field changes.**
  - Events: `money.count` for coalesced entries (F3); `session.parentBranchId` and
    `session.forkSeq` (F2); `vehicleId` on `worker_stop` and `farmlandId` on `field_work`, matching
    `worker_start` and `harvest`; `price` becomes one `prices` event per day holding every entry (F3).
  - `meta.json`: `heads` (F2); `beat`, a counter for liveness (F1); `mode`, `saveName` and
    `savegameIndex` for the bridge; `stats` for write-timing diagnostics.
  - For the analytics views (P2, [LEDGER.md](LEDGER.md)):
    - `year` on every event (C1).
    - Two money contexts: `input`, for seed, fertilizer or spray a hired worker buys for a field,
      and `vehicle`, for repairs and leasing booked to a machine.
    - `workedHours` on `harvest` and `field_work`, which prices machine time per field.
    - `operatingHours` on `vehicle_added`, for a used machine, and `sellValue` on `vehicle_hours`.
    - The calendar on `session`.
    - A `fields` list in `live_farm.json`, which daily snapshots carry to the ledger.
- **C8. Whole frames on the WebSocket.** The handoff pushes "JSON diffs". The bridge sends each
  channel frame whole instead: a vehicle frame is about 1 KB a second and a 100-machine fleet frame
  about 10 KB every 5 s, which a LAN does not notice, and a whole frame cannot drift out of sync or
  leave a reconnecting page half-filled. The bridge repeats its status every 10 s, so a page can
  tell a quiet game from a dead connection.
- **C9. Command channel files.** `commands.xml` (the last 20 commands and the bridge's epoch) and
  `acks.json` (the last 50 acks and the mod's watermark) replace `commands.ndjson` and `acks.ndjson`
  (F1). The bridge resolves each command from the ring, or answers `expired` 2 s after its TTL. It
  also moves its counter past the mod's watermark when an older `bridge-state.json` comes back, so
  the mod never ignores new commands as old ones.
- **C10. Alerts name their farm.** `Alert.farmId`, so a multiplayer page shows only its own farm's
  alerts. Game-wide alerts (`game_offline`) carry `null`.

## Schema refinements (Adopted in `supabase/`)

- **S1. Derived tables are views.** The handoff upserts `fields`, `vehicles` and `prices` as tables.
  Here they are views over `events` and `snapshots`, like the analytics, so nothing can fall out of
  step with the log, and a reload never has to undo an upsert. The P4 speed target holds without
  materializing them: [LEDGER.md](LEDGER.md#performance).
- **S2. Field P&L per field and season.** The handoff asks for field, fill type and season. Inputs,
  machine time and wages belong to the field, not to one of its crops, so each row lists every fill
  type the field gave in `yields`.
- **S3. The active branch is derived.** `save_branches.is_active` would need an update on every
  switch between branches. The active branch is instead the one whose latest `session` started
  last, from `last_session_at`, which the event insert keeps current.
- **S4. Roles.** The owner is `saves.owner_id`; `save_members.role` is `member`, who can read and
  sync (a member hosting the game runs the bridge), or `viewer`, who can only read.
- **S5. Reconciliation is a view.** `money_reconciliation` holds the P2 exit check for every pair of
  consecutive day rollovers.

## Inconsistencies in the handoff

| # | Where | Issue | Suggested fix |
| --- | --- | --- | --- |
| I1 | Overview vs P4 | v1 scope names three web views; P4 builds four (market) and its exit criterion says "all four" | Keep market in P4 (its daily prices are captured from P2 anyway) and update the overview. **Decision** |
| I2 | Verify item 2 | `g_currentModSettingsDirectory` | FS25 uses `g_modSettingsDirectory` |
| I3 | AI workers | `ERROR_UNLOADING_STATION_FULL` | Registered name is `ERROR_UNLOADINGSTATION_FULL` |
| I4 | AI workers | `onAIJobStarted` / `onAIJobFinished(job)` | `MessageType.AI_JOB_STARTED` / `AI_JOB_STOPPED` |
| I5 | Exports | "bridge.json heartbeat under 10 s old" | `bridge.xml` with a counter (F1) |
| I6 | Envelope example | `"userId": "steam:7656..."` | Opaque `uniqueUserId` (C4) |
| I7 | Supabase sync | Hourly snapshots from a 60 s file | Daily snapshot (F3) |
| I8 | Commands example | `"jobId": "j9"` | FS25 job ids are numbers; the schema takes a string and the mod stringifies |
| I9 | Bridge readers | "No `meta.json` update for 15 s marks the game offline", but `meta.json` is written every 60 s | The bridge uses the 1 s `live_vehicle.json` as the liveness signal (adopted) |

## Risks to add

- **OneDrive Documents.** New Windows installs often redirect Documents to OneDrive. The bridge
  must resolve the real Documents folder (known-folder lookup), not assume
  `%USERPROFILE%\Documents`. On Linux and Steam Deck the game runs under Proton, inside
  `steamapps/compatdata/2300320/pfx`.
- **Windows file locking.** Replacing `commands.xml` fails with EPERM or EBUSY while the game has it
  open, so the P1 command writer has to retry with backoff. Node opens files with read, write and delete sharing, so
  the bridge never blocks the game's writes.
- **Two implementations of the same math.** The P3 exit requires the Lua aggregates to match the SQL
  views. Define each formula once, with shared golden fixtures (events in, expected aggregates out)
  run by busted, Vitest and a SQL test.
- **Supabase free plan.** Database size (F3), and free projects pause after a period of inactivity.
- **First-run friction.** The bridge binds `0.0.0.0:8790`, so Windows Firewall prompts on first run,
  and an unsigned executable triggers SmartScreen. Document both, or budget for code signing.
- **Pausing single-player.** If the game stops calling the mod's update while paused, the live
  files stop, and after 15 s the page shows "Game offline" and raises an alert. The P1 test
  records what happens; if it does, the vehicle frame can carry a paused flag set on the way in.
- **Global saveIds.** `saves.id` is shared across all users, so a colliding saveId makes the second
  user's sync fail under RLS. The mod builds the id from `getMD5` over several entropy sources.

## Decisions needed

1. **F4:** move the money hook to `Farm.changeBalance` if the P0 probe sees bypasses. Recommended:
   yes, and approving it now keeps P2 unblocked.
2. **F5:** Web Push through the web app's origin, plus ntfy for LAN-only players?
3. **F8:** allow read-only live collectors on multiplayer clients?
4. **I1:** three or four web views in v1?
5. **F3:** how long raw events live in Supabase before compaction (needed by P4).

## What this branch builds

**P0 and its foundations:**

- The monorepo layout from the handoff.
- `packages/schema`, holding every v1 file contract and its JSON Schema export.
- The P0 mod: bootstrap with per-module `pcall` isolation, `FileIO`, `Json`, `Clock`, saveId
  persistence, the 1 s vehicle channel, `meta.json`, and a probe that answers the runtime half of
  items 1 to 7.
- The P0 bridge: path auto-detect, torn-read-safe reader, Zod validation, printing frames, and
  `--doctor`.
- Lua specs under 5.1, Vitest suites, and an end-to-end test that runs the mod's Lua against
  stubbed engine calls and validates its files with the schema package.

**P1, ahead of the P0 game session.** On Sep 26 the P0 in-game run had to wait for the PC, and
P1 went ahead on the adopted defaults so the work could continue. Whatever that run turns up, F1
in particular, may change P1 before its own in-game test ([P1_TEST.md](P1_TEST.md)).

- Mod: `hooks/AIWorkers.lua` (running jobs and a ring of stops with their reasons), the fleet and
  farm channels, and `commands/CommandChannel.lua` with `ping` and `worker.stop`.
- Bridge: serves the phone page and WebSocket on port 8790 behind a pairing token, writes
  commands and a heartbeat, resolves acks, raises the four alerts, and logs to `bridge.log`.
  `--doctor` covers the channels and the command round trip.
- `packages/live-ui`: the phone page, bundled into the bridge as one 47 KB HTML file.
- Tests: the bridge's `worker.stop` run through the mod's Lua; the page in headless Chromium
  against the real bridge; a smoke test of the compiled executable in CI.

**P2 foundations that need no game session.** While the P0 and P1 runs wait for the PC:

- The probe asks the P2 questions in the same session (see VERIFY_FIRST.md).
- The mod's event log: seqs claimed before they are written, the fork on loading an older save
  (F2), and kept-open files where append mode is refused (F1). The bridge follows the log, checks
  every line and reports seq gaps, in `bridge.log` and `--doctor`.
- `supabase/`: the tables, row-level security, the branch rule and the analytics views
  ([LEDGER.md](LEDGER.md)).
- `packages/schema/fixtures/ledger/`: golden fixtures that pin every formula.
- Tests against a real Postgres: every role's access, reloads of older saves, the fixtures, and a
  100,000-event timing run.
