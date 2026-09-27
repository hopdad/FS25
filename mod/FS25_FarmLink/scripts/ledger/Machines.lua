-- Machines (docs/HANDOFF.md, "Fleet diff"): the farm's machines, for vehicle cost per hour.
--
--   vehicle_added    a machine bought or leased while FarmLink runs, with what was paid
--   vehicle_removed  a machine that left: sold, with what the sale brought; a leased one given back;
--                    or one gone without a sale
--   vehicle_hours    operating hours and what the shop would pay today: once for every machine the
--                    ledger first sees, then once a day for each machine whose hours changed
--
-- The fleet is compared with what the ledger knows every POLL_MS. VEHICLE_ADDED and VEHICLE_REMOVED
-- do not say which machine, and loading a savegame adds every machine too. The first poll, once the
-- mission has started and the savegame's machines have loaded, only takes stock: a machine the
-- ledger has never seen gets its baseline hours, not a purchase. What the ledger knows is kept in
-- the savegame's farmLink.xml, so it rolls back with the save.
--
-- Pairing with the money. The shop books a purchase once the machine has loaded, and a sale as the
-- machine goes; the money funnel keeps those bookings (MoneyFunnel.takeShopBooking). A farm's machine
-- that appears or leaves alone takes that farm's booking, waiting up to SETTLE_MS for it. Machines
-- that appear together (a pack) share one booking, so each keeps its store price. A machine reset to
-- the shop is deleted and loaded again under the same id: if it comes back while it waits, it never
-- left. A save settles whatever is still waiting, so those events come before the savegame's seq.
--
-- Only what the game lists in its vehicle overview counts (owned or leased, not contract equipment
-- or pallets), and only for a player farm.

FarmLink = FarmLink or {}

local Machines = {
    name = "machines",
    authority = "server",
    POLL_MS = 2000,
    SETTLE_MS = 10000,
}
FarmLink.Machines = Machines

local state = nil

local function isLeased(vehicle)
    local states = VehiclePropertyState
    return vehicle.propertyState == (type(states) == "table" and states.LEASED or 3)
end

local function isFarmMachine(vehicle)
    local Game = FarmLink.Game
    if Game.call(vehicle, "getShowInVehiclesOverview") ~= true then
        return false
    end
    local farmId = Game.call(vehicle, "getOwnerFarmId")
    local farm = type(farmId) == "number" and Game.call(g_farmManager, "getFarmById", farmId) or nil
    return farm ~= nil and FarmLink.FarmCollector.isPlayerFarm(farm)
end

---The savegame's machines load asynchronously; the fleet is complete once the mission has started
---and none is still loading.
local function fleetLoaded()
    local mission = g_currentMission
    if mission == nil or mission.isMissionStarted == false then
        return false
    end
    local system = mission.vehicleSystem
    local toLoad = type(system) == "table" and system.vehiclesToLoad or nil
    return type(toLoad) ~= "number" or toLoad <= 0
end

---The farm's machines now: { [vehicleId] = vehicle }.
function Machines.current()
    local Game = FarmLink.Game
    local system = g_currentMission ~= nil and g_currentMission.vehicleSystem or nil
    local out = {}
    for _, vehicle in ipairs(type(system) == "table" and system.vehicles or {}) do
        local id = Game.vehicleId(vehicle)
        if id ~= nil and isFarmMachine(vehicle) then
            out[id] = vehicle
        end
    end
    return out
end

local function sortedKeys(t)
    local keys = {}
    for key in pairs(t) do
        keys[#keys + 1] = key
    end
    table.sort(keys)
    return keys
end

local function hours(ms)
    return FarmLink.Game.round(math.max(0, ms or 0) / 3600000, 4)
end

-- What the ledger keeps up to date about a machine while it is there.
local function observe(entry, vehicle)
    local Game = FarmLink.Game
    entry.vehicle = vehicle
    entry.farmId = Game.call(vehicle, "getOwnerFarmId") or entry.farmId or 0
    entry.leased = isLeased(vehicle)
    entry.lastMs = Game.operatingMs(vehicle) or entry.lastMs
end

local function writeHours(id, entry)
    local Game = FarmLink.Game
    local data = { vehicleId = id, operatingHours = hours(entry.lastMs) }
    local sellValue = Game.num(Game.call(entry.vehicle, "getSellPrice"))
    if sellValue ~= nil and sellValue >= 0 then
        data.sellValue = Game.round(sellValue, 2)
    end
    FarmLink.EventLog.emit("vehicle_hours", entry.farmId, data)
    entry.writtenMs = entry.lastMs or 0
end

local function writeAdded(id, vehicle, booking)
    local Game = FarmLink.Game
    local entry = {}
    observe(entry, vehicle)
    local price
    if booking ~= nil then
        price = -booking.amount
    else
        -- No booking paired: the store price, which for a lease is the fee paid up front.
        price = Game.num(Game.call(vehicle, "getPrice")) or 0
        if entry.leased then
            local economy = g_currentMission.economyManager
            price = Game.num(Game.call(economy, "getInitialLeasingPrice", price)) or 0
        end
    end
    local storeItem = vehicle.configFileName
    local data = {
        vehicleId = id,
        storeItem = type(storeItem) == "string" and storeItem ~= "" and storeItem or "unknown",
        name = Game.vehicleName(vehicle) or "",
        price = Game.round(math.max(0, price), 2),
        leased = entry.leased,
    }
    if (entry.lastMs or 0) > 0 then
        data.operatingHours = hours(entry.lastMs)
    end
    FarmLink.EventLog.emit("vehicle_added", entry.farmId, data)
    entry.writtenMs = entry.lastMs or 0
    state.known[id] = entry
end

local function writeRemoved(id, entry, sale)
    local Game = FarmLink.Game
    local reason = "deleted"
    if sale ~= nil then
        reason = "sold"
    elseif entry.leased then
        reason = "returned"
    end
    local data = { vehicleId = id, reason = reason, operatingHours = hours(entry.lastMs or entry.writtenMs) }
    if sale ~= nil then
        data.salePrice = Game.round(sale.amount, 2)
    end
    FarmLink.EventLog.emit("vehicle_removed", entry.farmId or 0, data)
end

-- How many of the waiting machines belong to each farm: only a farm's single machine pairs.
local function perFarm(waiting, farmOf)
    local counts = {}
    for _, pending in pairs(waiting) do
        local farmId = farmOf(pending)
        counts[farmId] = (counts[farmId] or 0) + 1
    end
    return counts
end

local function arrivingFarm(pending)
    return FarmLink.Game.call(pending.vehicle, "getOwnerFarmId") or 0
end

local function leavingFarm(pending)
    return pending.entry.farmId or 0
end

-- Writes each machine that came or went once it has its booking or has waited SETTLE_MS; `force`
-- writes them all.
local function settle(force)
    local Money = FarmLink.MoneyFunnel
    local counts = perFarm(state.arriving, arrivingFarm)
    for _, id in ipairs(sortedKeys(state.arriving)) do
        local pending = state.arriving[id]
        local farmId = arrivingFarm(pending)
        local booking = nil
        if counts[farmId] == 1 then
            local moneyType = isLeased(pending.vehicle) and "LEASING" or "SHOP_VEHICLE_BUY"
            booking = Money.takeShopBooking(moneyType, false, farmId)
        end
        local waited = state.clockMs - pending.sinceMs >= Machines.SETTLE_MS
        if booking ~= nil or force or pending.gone or waited then
            state.arriving[id] = nil
            writeAdded(id, pending.vehicle, booking)
        end
    end
    counts = perFarm(state.leaving, leavingFarm)
    for _, id in ipairs(sortedKeys(state.leaving)) do
        local pending = state.leaving[id]
        local farmId = leavingFarm(pending)
        local sale = nil
        if counts[farmId] == 1 and not pending.entry.leased then
            sale = Money.takeShopBooking("SHOP_VEHICLE_SELL", true, farmId)
        end
        if sale ~= nil or force or state.clockMs - pending.sinceMs >= Machines.SETTLE_MS then
            state.leaving[id] = nil
            writeRemoved(id, pending.entry, sale)
        end
    end
end

---Compares the fleet with what the ledger knows. The first poll once the fleet has loaded only
---takes stock.
function Machines.poll()
    if state == nil or not fleetLoaded() then
        return
    end
    local current = Machines.current()
    local ids = sortedKeys(current)
    if not state.stocked then
        state.stocked = true
        for _, id in ipairs(ids) do
            if state.known[id] == nil then
                local entry = { writtenMs = 0 }
                state.known[id] = entry
                observe(entry, current[id])
                writeHours(id, entry)
            end
        end
    end

    -- Arrivals: a reset machine coming back, or a new one that waits for its booking.
    for _, id in ipairs(ids) do
        if state.known[id] == nil then
            local back = state.leaving[id]
            if back ~= nil then
                state.leaving[id] = nil
                state.known[id] = back.entry
            elseif state.arriving[id] == nil then
                state.arriving[id] = { vehicle = current[id], sinceMs = state.clockMs }
            end
        end
    end
    for id, pending in pairs(state.arriving) do
        pending.gone = current[id] == nil
    end
    -- Departures wait for their sale, or to come back.
    for _, id in ipairs(sortedKeys(state.known)) do
        if current[id] == nil then
            state.leaving[id] = { entry = state.known[id], sinceMs = state.clockMs }
            state.known[id] = nil
        end
    end
    for id, entry in pairs(state.known) do
        observe(entry, current[id])
    end
    settle(false)
end

---Once a day: the hours of every machine whose hours changed since they were last written. They
---are compared as written, so a save and reload that rounds the game's operating time is no change.
function Machines.beforeRollover(_ctx)
    Machines.poll()
    if state == nil then
        return
    end
    for _, id in ipairs(sortedKeys(state.known)) do
        local entry = state.known[id]
        if entry.vehicle ~= nil and entry.lastMs ~= nil and hours(entry.lastMs) ~= hours(entry.writtenMs) then
            writeHours(id, entry)
        end
    end
end

---Before a save: settles every machine still waiting, and gives the savegame the machines the
---ledger knows with the hours last written.
function Machines.beforeSave(ctx)
    Machines.poll()
    if state == nil then
        return
    end
    if state.stocked then
        settle(true)
    end
    local saved = {}
    for id, entry in pairs(state.known) do
        saved[id] = { writtenMs = entry.writtenMs or 0, farmId = entry.farmId or 0 }
    end
    ctx.ledger.machines = saved
end

function Machines.init(ctx)
    local known = {}
    for id, saved in pairs(ctx.ledger.machines or {}) do
        known[id] = { writtenMs = saved.writtenMs or 0, farmId = saved.farmId or 0 }
    end
    state = {
        known = known,
        arriving = {},
        leaving = {},
        stocked = false,
        clockMs = 0,
        throttle = FarmLink.Clock.newThrottle(Machines.POLL_MS, Machines.POLL_MS),
    }
end

function Machines.update(dt, _ctx)
    state.clockMs = state.clockMs + (FarmLink.Game.num(dt) or 0)
    if state.throttle:tick(dt) then
        Machines.poll()
    end
end

function Machines.shutdown(_ctx)
    state = nil
end
