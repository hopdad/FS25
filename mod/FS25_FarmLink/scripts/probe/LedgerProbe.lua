-- The ledger's questions (P2), asked in the same game session as P0's so one session answers both.
-- Its findings go into probe.json as the `ledger` section:
--
--   updates     whether the mod's update runs while the game is paused (the page's "Game offline")
--   handle      whether a file handle opened once can be written again later (the event log's
--               fallback when append mode is blocked, PLAN_REVIEW.md F1)
--   money       which money types a session books, with totals (the money funnel's context kinds)
--   sales       SellingStation.sellFillType, which credits a sale: the sale context
--   fuel        FillTrigger.fillVehicle, which books fuel every frame while refueling (F3 coalescing)
--   farmStats   g_farmManager:updateFarmStats, the one call every field-work tool reports through
--   messages    DAY_CHANGED and friends, with the calendar at each new day
--   prices      selling points and a sample of their prices, the source of the daily price table
--   vehicles    VEHICLE_REMOVED, which the fleet diff pairs with vehicle sales
--
-- Observation only: every hook forwards the game's own results unchanged, and every step runs under
-- pcall. Disabled together with the P0 probe.

FarmLink = FarmLink or {}

local LedgerProbe = {
    name = "ledgerProbe",
    authority = "server",
    HANDLE_FILE = "handle_test.txt",
    -- The handle's second write waits this long, so it happens frames after the first.
    HANDLE_DELAY_MS = 5000,
    -- An update gap at least this long is recorded.
    GAP_MS = 2000,
    MAX_SAMPLES = 12,
    MAX_PRICES = 24,
    MESSAGES = { "DAY_CHANGED", "HOUR_CHANGED", "PERIOD_CHANGED", "YEAR_CHANGED", "VEHICLE_REMOVED" },
}
FarmLink.LedgerProbe = LedgerProbe

local unpack = unpack or table.unpack
local state = nil

local function pack(...)
    return { n = select("#", ...), ... }
end

local function null()
    return FarmLink.Json.null
end

local function describe(value)
    local kind = type(value)
    if value == nil then
        return null()
    elseif kind == "number" then
        if value ~= value or value == math.huge or value == -math.huge then
            return tostring(value)
        end
        return value
    elseif kind == "string" or kind == "boolean" then
        return value
    end
    return kind
end

local function call(object, method, ...)
    if type(object) ~= "table" or type(object[method]) ~= "function" then
        return nil
    end
    local ok, result = pcall(object[method], object, ...)
    return ok and result or nil
end

local function push(list, item, max)
    list[#list + 1] = item
    while #list > (max or LedgerProbe.MAX_SAMPLES) do
        table.remove(list, 1)
    end
end

local function round(value, decimals)
    if type(value) ~= "number" then
        return value
    end
    return FarmLink.Game.round(value, decimals or 2)
end

local function add(totals, key, amount)
    local entry = totals[key] or { calls = 0, total = 0 }
    entry.calls = entry.calls + 1
    if type(amount) == "number" and amount == amount then
        entry.total = entry.total + amount
    end
    totals[key] = entry
end

local function rounded(totals)
    local out = {}
    for key, entry in pairs(totals) do
        out[key] = { calls = entry.calls, total = round(entry.total) }
    end
    return FarmLink.Json.object(out)
end

-- Where a selling station is, as a stable id and a display name.
local function stationInfo(station)
    local placeable = type(station) == "table" and station.owningPlaceable or nil
    local id = call(placeable, "getUniqueId")
    local name = call(station, "getName")
    if type(name) ~= "string" or name == "" then
        name = call(placeable, "getName")
    end
    return describe(id), describe(name)
end

local function calendar()
    local env = g_currentMission ~= nil and g_currentMission.environment or nil
    if type(env) ~= "table" then
        return null()
    end
    return {
        monotonicDay = describe(env.currentMonotonicDay),
        day = describe(env.currentDay),
        year = describe(env.currentYear),
        period = describe(env.currentPeriod),
        dayInPeriod = describe(env.currentDayInPeriod),
        daysPerPeriod = describe(env.daysPerPeriod),
        realTs = FarmLink.Clock.realTimestamp(),
    }
end

---Selling points and a sample of their prices per liter, from the storage system's unloading stations.
function LedgerProbe.samplePrices()
    local system = g_currentMission ~= nil and g_currentMission.storageSystem or nil
    local stations = call(system, "getUnloadingStations")
    local result = {
        getUnloadingStations = type(system ~= nil and system.getUnloadingStations or nil),
        unloadingStations = 0,
        sellingPoints = 0,
        samples = {},
    }
    if type(stations) ~= "table" then
        result.samples = FarmLink.Json.array(result.samples)
        return result
    end
    for _, station in pairs(stations) do
        result.unloadingStations = result.unloadingStations + 1
        if type(station) == "table" and station.isSellingPoint == true then
            result.sellingPoints = result.sellingPoints + 1
            local id, name = stationInfo(station)
            for fillTypeIndex in pairs(station.acceptedFillTypes or {}) do
                if #result.samples >= LedgerProbe.MAX_PRICES then
                    break
                end
                local price = call(station, "getEffectiveFillTypePrice", fillTypeIndex)
                result.samples[#result.samples + 1] = {
                    stationId = id,
                    station = name,
                    fillType = describe(FarmLink.Game.fillTypeName(fillTypeIndex) or fillTypeIndex),
                    pricePerLiter = describe(type(price) == "number" and round(price, 4) or price),
                }
            end
        end
    end
    result.samples = FarmLink.Json.array(result.samples)
    return result
end

-- Hooks ---------------------------------------------------------------------------------------------

---Called by the P0 probe for every addMoney, with the money type's name.
function LedgerProbe.recordMoney(moneyTypeName, amount, farmId)
    local s = state
    if s == nil then
        return
    end
    pcall(add, s.moneyByType, tostring(moneyTypeName), amount)
    if type(farmId) == "number" and farmId == 0 then
        s.moneyFarmZero = s.moneyFarmZero + 1
    end
end

local function recordSale(s, station, farmId, fillDelta, fillTypeIndex, price)
    local sales = s.sales
    sales.calls = sales.calls + 1
    local name = FarmLink.Game.fillTypeName(fillTypeIndex) or tostring(fillTypeIndex)
    add(sales.byFillType, name, fillDelta)
    local id, stationName = stationInfo(station)
    push(sales.samples, {
        farmId = describe(farmId),
        liters = describe(round(fillDelta)),
        fillType = name,
        returned = describe(type(price) == "number" and round(price) or price),
        stationId = id,
        station = stationName,
    })
end

---Registered over SellingStation.sellFillType. It returns the sale price; that is passed back
---untouched, as TransactionLog found it must be (a wrapper that drops it breaks Precision Farming).
function LedgerProbe.sellFillType(self, superFunc, farmId, fillDelta, fillTypeIndex, ...)
    local r = pack(superFunc(self, farmId, fillDelta, fillTypeIndex, ...))
    local s = state
    if s ~= nil then
        pcall(recordSale, s, self, farmId, fillDelta, fillTypeIndex, r[1])
    end
    return unpack(r, 1, r.n)
end

local function recordFuel(s, trigger, vehicle, delta)
    local fuel = s.fuel
    fuel.calls = fuel.calls + 1
    fuel.liters = fuel.liters + delta
    if fuel.calls <= LedgerProbe.MAX_SAMPLES then
        push(fuel.samples, {
            liters = describe(round(delta, 4)),
            fillType = describe(FarmLink.Game.fillTypeName(call(trigger, "getCurrentFillType"))),
            vehicleId = describe(FarmLink.Game.vehicleId(vehicle)),
        })
    end
end

---Registered over FillTrigger.fillVehicle, which the game calls every frame while a vehicle fills up
---at a fuel station. Returns the liters actually added, passed back untouched.
function LedgerProbe.fillVehicle(self, superFunc, vehicle, delta, dt)
    local r = pack(superFunc(self, vehicle, delta, dt))
    local s = state
    if s ~= nil and type(r[1]) == "number" and r[1] > 0 then
        pcall(recordFuel, s, self, vehicle, r[1])
    end
    return unpack(r, 1, r.n)
end

local function wrapFarmStats()
    local manager = g_farmManager
    local original = type(manager) == "table" and manager.updateFarmStats or nil
    if type(original) ~= "function" then
        return "updateFarmStats missing"
    end
    local hadInstanceField = rawget(manager, "updateFarmStats") ~= nil
    local wrapper = function(self, farmId, statName, delta, ...)
        local r = pack(original(self, farmId, statName, delta, ...))
        local s = state
        if s ~= nil then
            pcall(add, s.farmStats, tostring(statName), delta)
        end
        return unpack(r, 1, r.n)
    end
    manager.updateFarmStats = wrapper
    state.farmStatsWrap = { manager = manager, original = original, wrapper = wrapper, hadInstanceField = hadInstanceField }
    return hadInstanceField and "wrapped (instance already had its own updateFarmStats)" or "wrapped"
end

local function unwrapFarmStats()
    local wrap = state ~= nil and state.farmStatsWrap or nil
    if wrap == nil or rawget(wrap.manager, "updateFarmStats") ~= wrap.wrapper then
        return
    end
    if wrap.hadInstanceField then
        wrap.manager.updateFarmStats = wrap.original
    else
        rawset(wrap.manager, "updateFarmStats", nil)
    end
end

---A message the ledger will listen to.
function LedgerProbe.onMessage(name, ...)
    local s = state
    if s == nil then
        return
    end
    pcall(function(...)
        local entry = s.messages[name]
        entry.count = entry.count + 1
        entry.lastArgs = select("#", ...)
        if name == "DAY_CHANGED" then
            push(s.days, calendar())
            s.prices.latest = LedgerProbe.samplePrices()
        end
    end, ...)
end

local function subscribe()
    local out = {}
    if type(g_messageCenter) ~= "table" or type(MessageType) ~= "table" then
        return "g_messageCenter or MessageType missing"
    end
    for _, name in ipairs(LedgerProbe.MESSAGES) do
        state.messages[name] = { count = 0 }
        local id = MessageType[name]
        if id == nil then
            out[name] = "missing"
        else
            local ok = pcall(g_messageCenter.subscribe, g_messageCenter, id, function(_target, ...)
                LedgerProbe.onMessage(name, ...)
            end, LedgerProbe)
            out[name] = ok and "subscribed" or "failed"
        end
    end
    return FarmLink.Json.object(out)
end

---Process-wide hooks on classes, installed once at file scope (PLAN_REVIEW.md F7).
function LedgerProbe.installProcessHooks()
    if LedgerProbe.processHooksInstalled then
        return
    end
    LedgerProbe.processHooksInstalled = true
    if type(Utils) ~= "table" or type(Utils.overwrittenFunction) ~= "function" then
        return
    end
    if type(SellingStation) == "table" and type(SellingStation.sellFillType) == "function" then
        SellingStation.sellFillType = Utils.overwrittenFunction(SellingStation.sellFillType, LedgerProbe.sellFillType)
        LedgerProbe.saleHookInstalled = true
    end
    if type(FillTrigger) == "table" and type(FillTrigger.fillVehicle) == "function" then
        FillTrigger.fillVehicle = Utils.overwrittenFunction(FillTrigger.fillVehicle, LedgerProbe.fillVehicle)
        LedgerProbe.fuelHookInstalled = true
    end
end

-- Pause and file handle -----------------------------------------------------------------------------

local function isPaused()
    local mission = g_currentMission
    if type(mission) ~= "table" then
        return false
    end
    return mission.paused == true or call(mission, "getIsPaused") == true
end

local function trackUpdate(s, dt)
    local updates = s.updates
    updates.calls = updates.calls + 1
    local paused = isPaused()
    if paused then
        updates.whilePaused = updates.whilePaused + 1
    end
    local now = FarmLink.Clock.preciseMs()
    if now ~= nil and updates.lastMs ~= nil then
        local gap = now - updates.lastMs
        if gap > updates.maxGapMs then
            updates.maxGapMs = gap
        end
        if gap >= LedgerProbe.GAP_MS then
            push(updates.gaps, {
                gapMs = round(gap, 0),
                dt = describe(dt),
                pausedNow = paused,
                realTs = FarmLink.Clock.realTimestamp(),
            })
        end
    end
    updates.lastMs = now
end

local function openHandle(dir)
    local path = dir .. LedgerProbe.HANDLE_FILE
    local file, err = io.open(path, "w")
    if file == nil then
        return { opened = false, error = describe(err) }, nil
    end
    local result = { opened = true, flush = type(file.flush), setvbuf = type(file.setvbuf) }
    local ok, writeErr = pcall(file.write, file, "one\n")
    result.firstWrite = ok and "ok" or tostring(writeErr)
    if type(file.flush) == "function" then
        local flushed, flushErr = pcall(file.flush, file)
        result.firstFlush = flushed and "ok" or tostring(flushErr)
    end
    return result, file
end

local function finishHandle(s)
    local file = s.handleFile
    s.handleFile = nil
    if file == nil then
        return
    end
    local ok, err = pcall(file.write, file, "two\n")
    s.handle.secondWrite = ok and "ok" or tostring(err)
    if type(file.flush) == "function" then
        pcall(file.flush, file)
    end
    local closed, closeErr = pcall(file.close, file)
    s.handle.closed = closed and "ok" or tostring(closeErr)
end

-- Module ---------------------------------------------------------------------------------------------

---The `ledger` section of probe.json. After the mission ends it is the final snapshot, because the
---P0 probe writes probe.json one last time after this module has shut down.
function LedgerProbe.report()
    local s = state
    if s == nil then
        return LedgerProbe.finalReport
    end
    local Json = FarmLink.Json
    local counts = {}
    for name, entry in pairs(s.messages) do
        counts[name] = { count = entry.count, lastArgs = describe(entry.lastArgs) }
    end
    return {
        updates = {
            calls = s.updates.calls,
            timer = describe(select(2, FarmLink.Clock.preciseMs())),
            maxGapMs = round(s.updates.maxGapMs, 0),
            whilePaused = s.updates.whilePaused,
            gaps = Json.array(s.updates.gaps),
        },
        handle = s.handle,
        money = {
            byType = rounded(s.moneyByType),
            farmZeroCalls = s.moneyFarmZero,
        },
        sales = {
            hooked = LedgerProbe.saleHookInstalled == true,
            calls = s.sales.calls,
            byFillType = rounded(s.sales.byFillType),
            samples = Json.array(s.sales.samples),
        },
        fuel = {
            hooked = LedgerProbe.fuelHookInstalled == true,
            calls = s.fuel.calls,
            liters = round(s.fuel.liters),
            samples = Json.array(s.fuel.samples),
        },
        farmStats = {
            wrap = s.farmStatsWrapStatus,
            byStat = rounded(s.farmStats),
        },
        messages = {
            subscribed = s.subscribed,
            counts = Json.object(counts),
            days = Json.array(s.days),
        },
        prices = {
            atStart = s.prices.atStart,
            latest = s.prices.latest or null(),
        },
    }
end

local function section(name, fn, ...)
    local ok, result = pcall(fn, ...)
    if ok then
        return result
    end
    return { error = name .. ": " .. tostring(result) }
end

function LedgerProbe.init(ctx)
    LedgerProbe.finalReport = nil
    local dirOk, dirErr = FarmLink.FileIO.ensureDir(ctx.baseDir, FarmLink.Probe.DIR)
    if not dirOk then
        error("creating the _probe folder: " .. tostring(dirErr), 0)
    end
    local dir = ctx.baseDir .. FarmLink.Probe.DIR .. "/"
    state = {
        updates = { calls = 0, maxGapMs = 0, whilePaused = 0, gaps = {} },
        moneyByType = {},
        moneyFarmZero = 0,
        sales = { calls = 0, byFillType = {}, samples = {} },
        fuel = { calls = 0, liters = 0, samples = {} },
        farmStats = {},
        messages = {},
        days = {},
        prices = {},
        handleElapsedMs = 0,
    }
    local handle, file = openHandle(dir)
    state.handle = handle
    state.handleFile = file
    state.farmStatsWrapStatus = section("wrapFarmStats", wrapFarmStats)
    state.subscribed = section("subscribe", subscribe)
    state.prices.atStart = section("prices", LedgerProbe.samplePrices)
end

function LedgerProbe.update(dt, _ctx)
    local s = state
    trackUpdate(s, dt)
    if s.handleFile ~= nil then
        s.handleElapsedMs = s.handleElapsedMs + (dt or 0)
        if s.handleElapsedMs >= LedgerProbe.HANDLE_DELAY_MS then
            finishHandle(s)
        end
    end
end

function LedgerProbe.shutdown(_ctx)
    if state == nil then
        return
    end
    pcall(finishHandle, state)
    local ok, final = pcall(LedgerProbe.report)
    LedgerProbe.finalReport = ok and final or nil
    unwrapFarmStats()
    if type(g_messageCenter) == "table" and type(g_messageCenter.unsubscribeAll) == "function" then
        pcall(g_messageCenter.unsubscribeAll, g_messageCenter, LedgerProbe)
    end
    state = nil
end
