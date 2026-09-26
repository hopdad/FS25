# Verify-first findings

Answers to the handoff's "Verify first" table, researched before any hook code was written.
Items 1 to 6 block P0 exit; the P0 probe (`mod/FS25_FarmLink/scripts/probe/Probe.lua`) confirms
whatever is still marked **runtime** below, and its output is recorded here after the in-game run.

**Status key**

- **Source**: read in FS25 game scripts or in a working FS25 mod (commits listed at the bottom).
- **Runtime**: the P0 probe must confirm it in the game.
- **Open**: needs the game, the SDK, or a site this environment cannot reach.

## Summary

| # | Unknown | Answer | Status |
| --- | --- | --- | --- |
| 1 | Engine file API; whether `io` exists | `io.open(path, "w")` writes files. The FS25 sandbox reportedly allows **write mode only**: a mod cannot read a text file, and `XMLFile` is the only reader. `deleteFile` works only inside `modSettings/<modName>/` | Source; append and read modes are runtime |
| 2 | `g_currentModSettingsDirectory` | Does not appear in any FS25 code. The global is `g_modSettingsDirectory` (ends in `/`, can be nil early). `getUserProfileAppPath() .. "modSettings/"` also works | Source; probe prints both |
| 3 | Atomic rename | No rename binding in any FS25 script or mod. Live files are written in place | Runtime (probe tries `os.rename` and `renameFile`) |
| 4 | `addMoney` signature, `MoneyType` layout | `addMoney(amount, farmId, moneyType, addChange, forceShowChange)`. `MoneyType.NAME = {id, title, statistic}`. `addMoney` books through `Farm:changeBalance(amount, moneyType)`, the lower-level sink TransactionLog hooks | Source; probe counts balance changes that do not come through `addMoney` |
| 5 | Combine fill gain, field from position | `Combine:addCutterArea(...)` returns liters added. Farmland from `g_farmlandManager:getFarmlandIdAtWorldPosition(x, z)`; FS25 links each field to exactly one farmland | Source; probe samples the lookup and counts hooked liters |
| 6 | AI stop path and message names | `MessageType.AI_JOB_STARTED(job, farmId)` and `MessageType.AI_JOB_STOPPED(job, aiMessage)`; name via `aiMessageManager:getMessageIndex(msg)`. No polling fallback needed | Source; probe logs real starts and stops |
| 7 | Career save hook | `FSCareerMissionInfo.saveToXMLFile` (appended), writing to `missionInfo.savegameDirectory` | Source; P0 already persists the saveId this way |
| 8 | `AIJobStartRequestEvent` | Exists in FS25, with `AIJobStartEvent` and `AIJobStopEvent` | Source (existence only; P5) |
| 9 | Lua dialect | Lua 5.1. VDTelemetry runs its specs on 5.1 in CI as "the version the GIANTS engine uses" | Source; probe records `_VERSION` |
| 10 | Precision Farming accessors | Not researched (P5) | Open |
| 11 | Current ModHub guideline text | GIANTS sites are not reachable from this environment | Open |

## Details

### 1. File API

- **Write.** `io.open(path, "w")` then `file:write(s)` and `file:close()` is how VDTelemetry,
  FarmDashboard and TransactionLog write JSON and CSV. `io.open` does not create missing folders;
  call `createFolder(path)` for each level first.
- **Read.** VDTelemetry (`src/command/CommandChannel.lua`) states: "the FS25 Lua sandbox restricts
  io.open to WRITE mode ('w') only, so the mod cannot read a file itself. The engine's XMLFile.load
  is the only file reader available." Its command channel is XML for that reason. TransactionLog
  does try `io.open(path, "rb")` for a one-off migration, but inside `pcall` and with a fallback, so
  the claim is not contradicted. **Runtime:** probe modes `r`, `rb`, `a`, `ab`, `w+`.
- **XML read.** `XMLFile.loadIfExists(name, path)` returns nil for a missing or half-written file.
  Legacy handle API: `loadXMLFile(name, path)` returns 0 on failure.
- **Engine file handles.** `createFile(path, FileAccess.WRITE)`, `fileWrite(file, s)`,
  `delete(file)` (used by `BitmapUtil`). The members of `FileAccess` are undocumented; the probe
  dumps them.
- **Other bindings.** `createFolder`, `fileExists`, `copyFile(src, dst, overwrite)`, `deleteFile`,
  `Files.getFilesRecursive(dir)`, `getAppBasePath()`.
- **Delete rule.** `deleteFile` only succeeds inside `modSettings/<modName>/`, and the check
  compares the raw path: a path containing `//` is refused (TransactionLog `toDeletablePath`).

**Consequence for the file protocol:** every file the bridge writes for the mod to read
(`commands.ndjson`, `bridge.json`) must be XML instead. See PLAN_REVIEW.md, finding F1.

### 2. modSettings directory

- `g_modSettingsDirectory` is used by TransactionLog and InvestorFarm. It ends in `/` and can be nil
  "on a headless / early-load edge".
- `g_currentModSettingsDirectory` appears nowhere in the FS25 script dump, the GDN excerpts, or the
  five reference mods. It is probably an FS22-era name.
- `getUserProfileAppPath() .. "modSettings/" .. modName .. "/"` is what VDTelemetry and FarmDashboard
  use. FarmLink resolves `g_modSettingsDirectory` first, then this.

### 3. Atomic rename

Nothing in the FS25 scripts or the reference mods renames a file. VDTelemetry writes its 100 ms
channel in place with `io.open(path, "w")` and lets the reader retry. FarmLink does the same; the
bridge's 50 ms retry on a torn read (already in the spec) covers it. The probe tries `os.rename`
and `renameFile` anyway.

### 4. Money

- **Signature.** `g_currentMission:addMoney(amount, farmId, moneyType, addChange, forceShowChange)`.
  InvestorFarm wraps the mission instance rather than `FSBaseMission`, because `FSBaseMission` is
  not in `gameSource.zip`. Base-game call example:
  `g_currentMission:addMoney(-self.pendingCost, self.startedFarmId, MoneyType.AI, true)` (`AIJob.lua`).
- **`MoneyType` layout.** A table of constants whose values are tables carrying `id`, `title` and
  `statistic`. Two names can share one id; TransactionLog builds `id -> name` by iterating `pairs`
  and keeping the lexicographically smallest name so the mapping is stable across sessions.
- **The lower-level sink.** `addMoney` books through `Farm:changeBalance(amount, moneyType)` and
  skips it when `farmId` is 0. TransactionLog, the most thorough FS25 money logger found, hooks
  `Farm.changeBalance` with `Utils.appendedFunction` at file scope rather than `addMoney`. No FS25
  code seen here calls `changeBalance` directly, so whether anything bypasses `addMoney` is
  unproven either way; the probe counts it. This matters for the P2 reconciliation test; see
  PLAN_REVIEW.md, finding F4.
- **Wage cadence.** `AIJob:updateCost(dt)` accrues `0.0004 x dt x EconomyManager.getCostMultiplier()`
  (dt in ms, as passed to `AISystem:update`) and books it with `addMoney` every time the pending
  amount passes 25, plus the remainder when the job stops. At a multiplier of 1 that is one money
  call per ~62 s of `dt` per worker.
- **Hourly per-object money.** Some objects book money every game hour, one call each, for example
  `PlaceableIncomePerHour:onHourChanged` (solar panels, wind turbines) with
  `MoneyType.PROPERTY_INCOME`. At high time scales these dominate the event count (PLAN_REVIEW.md, F3).

### 5. Harvest attribution

- **Hook.** `Combine:addCutterArea(area, liters, inputFruitType, outputFillType, strawRatio, farmId, cutterLoad)`
  returns the liters actually added to the tank after threshing scale, rain and damage reductions and
  additives. That return value is the number to attribute.
- **How to hook a specialization function.** Vehicle types copy specialization functions when types
  are finalized, so reassigning `Combine.addCutterArea` after load does nothing. Append to
  `Combine.registerOverwrittenFunctions` at file scope and call
  `SpecializationUtil.registerOverwrittenFunction(vehicleType, "addCutterArea", fn)` from it. This is
  the pattern TransactionLog uses for `PlaceableHusbandryWater.updateFeeding`.
- **Farmland.** `g_farmlandManager:getFarmlandIdAtWorldPosition(x, z)` returns 0 when the position is
  not on a farmland. YieldTracker samples the cutter's `rootNode` position.
- **Field.** In FS25 each field is linked to exactly one farmland at map load
  (`FieldManager.farmlandIdFieldMapping[farmland.id] = field`, `farmland:setField(field)`), so
  `farmlandId -> field` is a table lookup. `g_fieldManager.fields[id]` and
  `field.fieldState.fruitTypeIndex` are also used by YieldTracker.

### 6. AI workers

- **Start.** `AISystem:startJobInternal(job, startFarmId)` publishes
  `MessageType.AI_JOB_STARTED` with `(job, startFarmId)`.
- **Stop.** `AISystem:stopJobInternal(job, aiMessage)` publishes `MessageType.AI_JOB_STOPPED` with
  `(job, aiMessage)`. `MessageType.AI_JOB_REMOVED` follows with the job id. All three fire on the
  server and on clients.
- **Stop reason name.** `local i = g_currentMission.aiMessageManager:getMessageIndex(aiMessage)`, then
  `aiMessageManager.messages[i].name`. Registered names include `ERROR_OUT_OF_FUEL`,
  `ERROR_OUT_OF_MONEY`, `ERROR_GRAINTANK_IS_FULL`, `ERROR_UNLOADINGSTATION_FULL` (the handoff's
  `ERROR_UNLOADING_STATION_FULL` is misspelled), `SUCCESS_FINISHED_JOB` and `SUCCESS_STOPPED_BY_USER`.
  `aiMessage` can be nil.
- **Stopping a job from code.** `g_currentMission.aiSystem:stopJobById(jobId, AIMessageSuccessStoppedByUser.new())`.
  On the server it stops the job and broadcasts `AIJobStopEvent`; on a client it sends a request.
- **Job ids are per process.** `AISystem.NEXT_JOB_ID` is a counter, so a job id is not stable
  across sessions. The worker registry needs its own key (see PLAN_REVIEW.md, C4).

### 7. Savegame persistence

- **Save.** `FSCareerMissionInfo.saveToXMLFile = Utils.appendedFunction(...)`, writing to
  `missionInfo.savegameDirectory .. "/farmLink.xml"` (InvestorFarm, "verified against FS25 1.23";
  YieldTracker).
- **Load.** `missionInfo.savegameDirectory` is nil for a new career that has never been saved.
- **Install hooks once per process.** Mod Lua state survives a savegame reload, so a class-method
  hook installed in `loadMap` stacks a second copy on every reload (TransactionLog and VDTelemetry
  both call this out). FarmLink installs hooks at file scope behind a guard and resets all
  per-mission state in `loadMap` and `deleteMap`.

### Other facts found along the way

| Need | FS25 API |
| --- | --- |
| Local player's vehicle | `g_localPlayer:getCurrentVehicle()` |
| Stable vehicle id | `vehicle:getUniqueId()`, persisted in the savegame (`vehicle.id` changes per session) |
| Vehicle basics | `getFullName()`, `getLastSpeed()` (km/h), `operatingTime` (ms), `getOwnerFarmId()`, `getIsAIActive()`, `getSellPrice()`, `getPrice()` |
| Motor | `spec_motorized`, `getMotor()`, `motor:getLastMotorRpm()`, `motor:getGearToDisplay()`, `consumersByFillType[fillType].fillUnitIndex` |
| Fill units | `getFillUnits()`, `getFillUnitFillLevel(i)`, `getFillUnitCapacity(i)`, `getFillUnitFillType(i)` |
| Implements | `spec_attacherJoints.attachedImplements[i].object`, `getChildVehicles()` |
| Vehicles | `g_currentMission.vehicleSystem.vehicles`, `vehicleSystem:getVehicleByUniqueId(id)` |
| Calendar | `environment.currentMonotonicDay`, `currentDay`, `currentYear`, `currentPeriod`, `currentDayInPeriod`, `daysPerPeriod`, `dayTime` (ms) |
| Time messages | `MessageType.HOUR_CHANGED`, `DAY_CHANGED`, `PERIOD_CHANGED`, `PERIOD_LENGTH_CHANGED` (days per month can change mid-save) |
| Wall clock | `getDate(fmt)` (strftime, local time; TransactionLog uses `%z` for the offset), `getTime()` |
| Hashing | `getMD5(s)` (used by `Utils.getUniqueId`) |
| Players | `user.uniqueUserId` (persisted string), `userManager:getUserIdByConnection(connection)` (session id) |
| Load and start hooks | `Mission00.loadItemsFinished`, `Mission00.onStartMission` (InvestorFarm) |

## Sources

| Source | Commit |
| --- | --- |
| [Dukefarming/FS25-lua-scripting](https://github.com/Dukefarming/FS25-lua-scripting) (partial dataS dump) | `a8c512f` |
| [umbraprior/FS25-Community-LUADOC](https://github.com/umbraprior/FS25-Community-LUADOC) (GDN pages with code) | `24afb18` |
| [VertexDezign/VDTelemetry](https://github.com/VertexDezign/VDTelemetry) | `7cd8295` |
| [rittermod/FS25_TransactionLog](https://github.com/rittermod/FS25_TransactionLog) | `0efc617` |
| [iNotrez/FS25_InvestorFarm](https://github.com/iNotrez/FS25_InvestorFarm) | `855e978` |
| [BitBarn-Mods/FS25_YieldTracker](https://github.com/BitBarn-Mods/FS25_YieldTracker) | `b1aa3ee` |

The dump does not include `FSBaseMission`, `Farm`, `MoneyType` or the vehicle specializations;
those answers come from the GDN code excerpts and the mods. Nothing from these repositories is
copied into FarmLink.

## Runtime results

Filled in from `modSettings/FS25_FarmLink/_probe/probe.json` after the P0 game session.

| # | Probe result |
| --- | --- |
| 1 | pending |
| 2 | pending |
| 3 | pending |
| 4 | pending |
| 5 | pending |
| 6 | pending |
| 7 | pending |
