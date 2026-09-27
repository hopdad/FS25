-- The money funnel (docs/HANDOFF.md, "Money funnel"): every balance change becomes a `money` event,
-- with the context that says what it was for.
--
-- Where money is caught. HOOK = "addMoney" wraps the mission's addMoney, as the locked decision
-- says; "changeBalance" appends to Farm.changeBalance instead, which also sees any balance change
-- that bypasses addMoney. The P0 probe counts those bypasses; if it finds any, switch (PLAN_REVIEW.md
-- F4). Farm 0 has no balance, so its bookings are dropped either way.
--
-- Context. Game functions that book money are run inside FarmLink.Context (core/Context.lua), and
-- the booking takes the innermost context:
--   sale     SellingStation.sellFillType   station, fill type, liters
--   fuel     FillTrigger.fillVehicle        vehicle, fill type, liters added
--   wage     AIJob.updateCost, AIJob.stop   job, vehicle
--   input    seed a hired worker buys (SowingMachine.onEndWorkAreaProcessing, with the liters from
--            the seedUsage stat reported in the same call) and fertilizer it buys
--            (Sprayer.onStartWorkAreaProcessing, through getExternalFill; the liters and fill type
--            are in the sprayer's work-area parameters once the call returns)
--   vehicle  WearableRepairEvent.run        the machine repaired
-- The probe's `context` section checks each of these in the game.
--
-- Coalescing (F3). Fuel is booked every frame while filling up, wages every ~25 of wage, and bought
-- seed every frame a hired worker sows, so those are gathered per farm, money type and context and
-- written as one event with a `count`: once their bookings stop for QUIET_MS, after MAX_AGE_MS, when
-- the job stops (wages), and always before a day rollover or a save. Everything else is written as
-- it happens, one event per booking.

FarmLink = FarmLink or {}

local MoneyFunnel = {
    name = "moneyFunnel",
    authority = "server",
    HOOK = "addMoney",
    QUIET_MS = 2000,
    MAX_AGE_MS = 300000,
    COALESCE = { fuel = true, wage = true, input = true },
}
FarmLink.MoneyFunnel = MoneyFunnel

local unpack = unpack or table.unpack
local state = nil

local function pack(...)
    return { n = select("#", ...), ... }
end

local function round(value)
    return FarmLink.Game.round(value, 6)
end

-- Context producers (installed once per process, at file scope) ------------------------------------

local function stationId(station)
    local Game = FarmLink.Game
    local placeable = type(station) == "table" and station.owningPlaceable or nil
    local id = Game.call(placeable, "getUniqueId")
    if type(id) ~= "string" or id == "" then
        id = Game.call(station, "getName") or Game.call(placeable, "getName")
    end
    if type(id) ~= "string" or id == "" then
        return "unknown"
    end
    return id
end

local function vehicleField(vehicle)
    local x, z = FarmLink.Game.vehiclePosition(vehicle)
    local _, fieldId = FarmLink.Game.fieldAt(x, z)
    return fieldId
end

---Wraps owner[method] so the game function runs inside the context makeEntry(self, ...) returns;
---after(entry, results) may complete the entry once the call has returned.
local function produce(owner, method, makeEntry, after)
    if type(owner) ~= "table" or type(owner[method]) ~= "function" then
        return false
    end
    local original = owner[method]
    owner[method] = function(self, ...)
        if state == nil then
            return original(self, ...)
        end
        local ok, entry = pcall(makeEntry, self, ...)
        if not ok or entry == nil then
            return original(self, ...)
        end
        entry.vehicle = entry.vehicle or (entry.kind == "input" and self or nil)
        local r = pack(FarmLink.Context.run(entry, original, self, ...))
        if after ~= nil then
            pcall(after, entry, r)
        end
        return unpack(r, 1, r.n)
    end
    return true
end

function MoneyFunnel.installProcessHooks()
    if MoneyFunnel.processHooksInstalled then
        return
    end
    MoneyFunnel.processHooksInstalled = true
    local Game = FarmLink.Game
    local hooks = {}

    hooks.sale = produce(SellingStation, "sellFillType", function(self, _farmId, fillDelta, fillTypeIndex)
        return {
            kind = "sale",
            stationId = stationId(self),
            fillType = Game.fillTypeName(fillTypeIndex),
            liters = Game.num(fillDelta) or 0,
        }
    end)

    hooks.fuel = produce(FillTrigger, "fillVehicle", function(self, vehicle)
        return {
            kind = "fuel",
            vehicleId = Game.vehicleId(vehicle),
            fillType = Game.fillTypeName(Game.call(self, "getCurrentFillType")),
            liters = 0,
        }
    end, function(entry, results)
        entry.liters = Game.num(results[1]) or 0
    end)

    local function wage(job)
        return { kind = "wage", jobId = tostring(job.jobId), vehicleId = Game.vehicleId(Game.jobVehicle(job)) }
    end
    hooks.wageTick = produce(AIJob, "updateCost", wage)
    hooks.wageStop = produce(AIJob, "stop", wage)

    hooks.repair = produce(WearableRepairEvent, "run", function(self)
        return { kind = "vehicle", vehicleId = Game.vehicleId(self.vehicle) }
    end)

    -- Credited to the machine pulling the tool, as field work is (ledger/FieldWork.lua).
    local function input(vehicle, fillTypeIndex)
        return {
            kind = "input",
            fillType = Game.fillTypeName(fillTypeIndex),
            liters = 0,
            fieldId = vehicleField(vehicle),
            vehicleId = Game.vehicleId(Game.call(vehicle, "getRootVehicle") or vehicle),
            -- The seedUsage stat reported inside this call adds the liters (FarmStatsTap listener).
            usageStat = "seedUsage",
        }
    end
    hooks.seed = produce(SowingMachine, "onEndWorkAreaProcessing", function(vehicle)
        local spec = vehicle.spec_sowingMachine
        return input(vehicle, type(spec) == "table" and spec.seedFillType or nil)
    end)
    hooks.spray = produce(Sprayer, "onStartWorkAreaProcessing", function(vehicle)
        local entry = input(vehicle, nil)
        entry.usageStat = nil
        return entry
    end, function(entry, _results)
        -- What was bought, and how much, is in the work-area parameters once the call is done.
        local spec = entry.vehicle ~= nil and entry.vehicle.spec_sprayer or nil
        local params = type(spec) == "table" and spec.workAreaParameters or nil
        if type(params) == "table" then
            entry.fillType = Game.fillTypeName(params.sprayFillType) or entry.fillType
            entry.liters = Game.num(params.usage) or 0
        end
    end)

    if MoneyFunnel.HOOK == "changeBalance" and type(Farm) == "table" and type(Farm.changeBalance) == "function" then
        local original = Farm.changeBalance
        Farm.changeBalance = function(farm, amount, moneyType, ...)
            local r = pack(original(farm, amount, moneyType, ...))
            pcall(MoneyFunnel.book, amount, type(farm) == "table" and farm.farmId or nil, moneyType)
            return unpack(r, 1, r.n)
        end
        hooks.changeBalance = true
    end
    MoneyFunnel.hooks = hooks
end

-- Booking -----------------------------------------------------------------------------------------

-- The event's context, from the producer's entry. Built when the event is written, because some
-- entries are completed only after their call returns (liters added, fertilizer bought). A context
-- missing something the contract requires falls back to "none" rather than writing an invalid line.
local function contextData(entry)
    local Json = FarmLink.Json
    local kind = type(entry) == "table" and entry.kind or nil
    if kind == "sale" and entry.fillType ~= nil then
        return { kind = "sale", stationId = entry.stationId, fillType = entry.fillType, liters = 0 }
    elseif kind == "fuel" and entry.vehicleId ~= nil and entry.fillType ~= nil then
        return { kind = "fuel", vehicleId = entry.vehicleId, fillType = entry.fillType, liters = 0 }
    elseif kind == "wage" and entry.jobId ~= nil then
        return { kind = "wage", jobId = entry.jobId, vehicleId = Json.orNull(entry.vehicleId) }
    elseif kind == "input" and entry.fillType ~= nil then
        return {
            kind = "input",
            fillType = entry.fillType,
            liters = 0,
            fieldId = Json.orNull(entry.fieldId),
            vehicleId = Json.orNull(entry.vehicleId),
        }
    elseif kind == "vehicle" and entry.vehicleId ~= nil then
        return { kind = "vehicle", vehicleId = entry.vehicleId }
    end
    return { kind = "none" }
end

-- What a booking is gathered under: farm, money type and the producer's identity. The fill type is
-- left out, since a sprayer's is only known after its booking.
local function bucketKey(farmId, moneyType, entry)
    local parts = { tostring(farmId), moneyType }
    if type(entry) == "table" then
        for _, field in ipairs({ "kind", "jobId", "vehicleId", "fieldId", "stationId" }) do
            if entry[field] ~= nil then
                parts[#parts + 1] = tostring(entry[field])
            end
        end
    end
    return table.concat(parts, "|")
end

local function emit(bucket)
    local context = contextData(bucket.lastEntry)
    if context.liters ~= nil then
        local liters = 0
        for entry in pairs(bucket.entries) do
            liters = liters + (FarmLink.Game.num(entry.liters) or 0)
        end
        context.liters = round(math.max(0, liters))
    end
    local data = { amount = round(bucket.amount), moneyType = bucket.moneyType, context = context }
    if bucket.count > 1 then
        data.count = bucket.count
    end
    FarmLink.EventLog.emit("money", bucket.farmId, data)
    state.stats.events = state.stats.events + 1
end

---Takes one balance change. Called by the hook after the game has booked it.
---@param amount number signed
---@param farmId integer
---@param moneyType table
function MoneyFunnel.book(amount, farmId, moneyType)
    local s = state
    if s == nil or type(farmId) ~= "number" or farmId == 0 then
        return
    end
    amount = FarmLink.Game.num(amount)
    if amount == nil or amount == 0 then
        return
    end
    local entry = FarmLink.Context.current()
    local kind = type(entry) == "table" and entry.kind or "none"
    local name = FarmLink.Game.moneyTypeName(moneyType)
    s.stats.bookings = s.stats.bookings + 1
    if kind == "wage" and entry.jobId ~= nil then
        s.wages[entry.jobId] = (s.wages[entry.jobId] or 0) - amount
    end

    local coalesce = MoneyFunnel.COALESCE[kind] == true
    local key = bucketKey(farmId, name, entry)
    local bucket = coalesce and s.buckets[key] or nil
    if bucket == nil then
        bucket = { farmId = farmId, moneyType = name, amount = 0, count = 0, entries = {}, firstMs = s.clockMs }
        if coalesce then
            s.buckets[key] = bucket
            s.order[#s.order + 1] = key
        end
    end
    bucket.amount = bucket.amount + amount
    bucket.count = bucket.count + 1
    bucket.lastMs = s.clockMs
    bucket.lastEntry = entry
    if type(entry) == "table" then
        bucket.entries[entry] = true
    end
    if not coalesce then
        emit(bucket)
    end
end

---Writes the gathered buckets that match (all of them without a filter), oldest first.
---@param match function|nil match(bucket) -> boolean
function MoneyFunnel.flush(match)
    local s = state
    if s == nil then
        return
    end
    local kept = {}
    for _, key in ipairs(s.order) do
        local bucket = s.buckets[key]
        if bucket ~= nil and (match == nil or match(bucket)) then
            s.buckets[key] = nil
            emit(bucket)
        elseif bucket ~= nil then
            kept[#kept + 1] = key
        end
    end
    s.order = kept
end

---Writes a job's gathered wages now: called when the job stops, before its worker_stop event.
function MoneyFunnel.flushJob(jobId)
    local id = tostring(jobId)
    MoneyFunnel.flush(function(bucket)
        local entry = bucket.lastEntry
        return type(entry) == "table" and entry.kind == "wage" and entry.jobId == id
    end)
end

---Wages paid for a job since it started, as a positive amount.
function MoneyFunnel.jobWages(jobId)
    local s = state
    if s == nil then
        return 0
    end
    return round(math.max(0, s.wages[tostring(jobId)] or 0))
end

---A job (re)started: its wages count from zero. Job ids restart every session (C4).
function MoneyFunnel.resetJob(jobId)
    if state ~= nil then
        state.wages[tostring(jobId)] = nil
    end
end

-- The seedUsage stat a sowing machine reports inside its input context is the liters it used.
FarmLink.FarmStatsTap.listen(function(_farmId, statName, delta)
    local entry = FarmLink.Context.current()
    if state ~= nil and type(entry) == "table" and entry.usageStat ~= nil and entry.usageStat == statName then
        entry.liters = (entry.liters or 0) + (FarmLink.Game.num(delta) or 0)
    end
end)

-- Module ------------------------------------------------------------------------------------------

local function wrapAddMoney(mission)
    local original = mission.addMoney
    if type(original) ~= "function" then
        return "addMoney missing"
    end
    local hadInstanceField = rawget(mission, "addMoney") ~= nil
    local wrapper = function(self, amount, farmId, moneyType, ...)
        local r = pack(original(self, amount, farmId, moneyType, ...))
        pcall(MoneyFunnel.book, amount, farmId, moneyType)
        return unpack(r, 1, r.n)
    end
    mission.addMoney = wrapper
    state.wrap = { mission = mission, original = original, wrapper = wrapper, hadInstanceField = hadInstanceField }
    return "wrapped"
end

local function unwrapAddMoney()
    local wrap = state ~= nil and state.wrap or nil
    if wrap == nil or rawget(wrap.mission, "addMoney") ~= wrap.wrapper then
        return
    end
    if wrap.hadInstanceField then
        wrap.mission.addMoney = wrap.original
    else
        rawset(wrap.mission, "addMoney", nil)
    end
end

function MoneyFunnel.init(_ctx)
    FarmLink.Context.reset()
    state = {
        clockMs = 0,
        buckets = {},
        order = {},
        wages = {},
        stats = { bookings = 0, events = 0 },
    }
    if MoneyFunnel.HOOK == "addMoney" then
        state.hook = wrapAddMoney(g_currentMission)
    else
        state.hook = MoneyFunnel.hooks ~= nil and MoneyFunnel.hooks.changeBalance and "changeBalance" or "missing"
    end
end

function MoneyFunnel.update(dt, _ctx)
    local s = state
    s.clockMs = s.clockMs + (FarmLink.Game.num(dt) or 0)
    MoneyFunnel.flush(function(bucket)
        return s.clockMs - bucket.lastMs >= MoneyFunnel.QUIET_MS or s.clockMs - bucket.firstMs >= MoneyFunnel.MAX_AGE_MS
    end)
end

function MoneyFunnel.beforeSave(_ctx)
    MoneyFunnel.flush()
end

function MoneyFunnel.beforeRollover(_ctx)
    MoneyFunnel.flush()
end

function MoneyFunnel.shutdown(_ctx)
    if state == nil then
        return
    end
    MoneyFunnel.flush()
    unwrapAddMoney()
    FarmLink.Context.reset()
    state = nil
end

---Counters for tests and the doctor.
function MoneyFunnel.stats()
    if state == nil then
        return nil
    end
    return { hook = state.hook, bookings = state.stats.bookings, events = state.stats.events, pending = #state.order }
end
