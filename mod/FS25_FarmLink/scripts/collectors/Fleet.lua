-- live_fleet.json: every farm machine, the running AI jobs and the recent worker stops. Written every
-- 5 s, and on the next frame after a worker starts or stops. Contract: packages/schema/src/live.ts.

FarmLink = FarmLink or {}

local Fleet = {
    name = "fleet",
    authority = "server",
    FILE_NAME = "live_fleet.json",
    INTERVAL_MS = 5000,
}
FarmLink.Fleet = Fleet

-- vehicles/VehiclePropertyState.lua: equipment lent by a contract.
local PROPERTY_MISSION = 4

local function isFarmMachine(vehicle)
    local Game = FarmLink.Game
    if Game.call(vehicle, "getShowInVehiclesOverview") == true then
        return true
    end
    -- Contract equipment is left off the game's own overview but is a machine the farm is using.
    return vehicle.propertyState == PROPERTY_MISSION and vehicle.spec_pallet == nil and vehicle.spec_rideable == nil
end

local function rootOf(vehicle)
    local root = vehicle.rootVehicle
    if type(root) ~= "table" then
        root = FarmLink.Game.call(vehicle, "getRootVehicle")
    end
    if type(root) == "table" then
        return root
    end
    return vehicle
end

---Who is driving: Courseplay and AutoDrive by their own state (read-only), then the base AI, then a
---player in the seat.
function Fleet.controller(vehicle)
    local Game = FarmLink.Game
    local root = rootOf(vehicle)
    local ad = root.ad
    if type(ad) == "table" and type(ad.stateModule) == "table" and Game.call(ad.stateModule, "isActive") == true then
        return "autodrive"
    end
    if Game.call(root, "getIsCpActive") == true then
        return "courseplay"
    end
    if Game.call(root, "getIsAIActive") == true then
        return "ai"
    end
    local enterable = root.spec_enterable
    if type(enterable) == "table" and (enterable.isControlled == true or enterable.isEntered == true) then
        return "player"
    end
    return "idle"
end

local function heading(vehicle)
    if vehicle.rootNode == nil or type(localDirectionToWorld) ~= "function" then
        return nil
    end
    local ok, dx, _, dz = pcall(localDirectionToWorld, vehicle.rootNode, 0, 0, 1)
    if not ok or FarmLink.Game.num(dx) == nil or FarmLink.Game.num(dz) == nil or (dx == 0 and dz == 0) then
        return nil
    end
    return FarmLink.Game.round(math.deg(math.atan2(dx, -dz)) % 360, 1) % 360
end

function Fleet.vehicleRow(vehicle)
    local Game = FarmLink.Game
    local Json = FarmLink.Json
    local vehicleId = Game.vehicleId(vehicle)
    if vehicleId == nil then
        return nil
    end
    local farmId = Game.call(vehicle, "getOwnerFarmId")
    if type(farmId) ~= "number" or farmId <= 0 then
        return nil
    end
    local x, z = Game.vehiclePosition(vehicle)
    local position = { x = 0, z = 0 }
    if x ~= nil then
        position = { x = Game.round(x, 1), z = Game.round(z, 1), heading = heading(vehicle) }
    end
    local _, fuelPct = Game.fuel(vehicle)
    local root = rootOf(vehicle)
    local attachedTo = nil
    if root ~= vehicle then
        attachedTo = Game.vehicleId(root)
    end
    return {
        vehicleId = vehicleId,
        name = Game.vehicleName(vehicle),
        farmId = farmId,
        position = position,
        fuelPct = Json.orNull(fuelPct),
        damagePct = Json.orNull(Game.damagePct(vehicle)),
        controller = Fleet.controller(vehicle),
        attachedTo = Json.orNull(attachedTo),
    }
end

local function jobRow(job)
    local Json = FarmLink.Json
    if job.vehicleId == nil then
        return nil
    end
    return {
        jobId = job.jobId,
        vehicleId = job.vehicleId,
        farmId = job.farmId,
        jobType = job.jobType,
        helper = Json.orNull(job.helper),
        fieldId = Json.orNull(job.fieldId),
        progressPct = Json.null,
        tankFillPct = Json.orNull(FarmLink.Game.rigTankPct(job.vehicle)),
        startedAt = job.startedAt,
    }
end

local function stopRow(stop)
    local Json = FarmLink.Json
    return {
        stopId = stop.stopId,
        jobId = stop.jobId,
        vehicleId = Json.orNull(stop.vehicleId),
        farmId = stop.farmId,
        jobType = stop.jobType,
        helper = Json.orNull(stop.helper),
        reason = stop.reason,
        durationMin = Json.orNull(stop.durationMin),
        realTs = stop.realTs,
        day = stop.day,
        minute = stop.minute,
    }
end

---One live_fleet.json document.
function Fleet.frame(ctx)
    local Clock = FarmLink.Clock
    local Json = FarmLink.Json

    local vehicles = {}
    local system = g_currentMission ~= nil and g_currentMission.vehicleSystem or nil
    if system ~= nil and type(system.vehicles) == "table" then
        for _, vehicle in ipairs(system.vehicles) do
            if type(vehicle) == "table" and isFarmMachine(vehicle) then
                local ok, row = pcall(Fleet.vehicleRow, vehicle)
                if ok and row ~= nil then
                    vehicles[#vehicles + 1] = row
                end
            end
        end
    end

    local jobs = {}
    for _, job in ipairs(FarmLink.AIWorkers.activeJobs(ctx)) do
        local row = jobRow(job)
        if row ~= nil then
            jobs[#jobs + 1] = row
        end
    end

    local stops = {}
    for _, stop in ipairs(ctx.workers.stops) do
        stops[#stops + 1] = stopRow(stop)
    end

    return {
        v = 1,
        saveId = ctx.ledger.saveId,
        sessionId = ctx.sessionId,
        realTs = Clock.realTimestamp(),
        day = Clock.gameDay(),
        minute = Clock.minuteOfDay(),
        fleet = {
            vehicles = Json.array(vehicles),
            jobs = Json.array(jobs),
            stops = Json.array(stops),
        },
    }
end

function Fleet.write(ctx)
    local text = FarmLink.Json.encode(Fleet.frame(ctx))
    local ok, err = FarmLink.FileIO.writeText(ctx.saveDir .. Fleet.FILE_NAME, text)
    if not ok then
        error("writing live_fleet.json: " .. tostring(err), 0)
    end
end

function Fleet.init(ctx)
    ctx.fleetThrottle = FarmLink.Clock.newThrottle(Fleet.INTERVAL_MS, Fleet.INTERVAL_MS)
end

function Fleet.update(dt, ctx)
    local due = ctx.fleetThrottle:tick(dt)
    if due or ctx.fleetDirty then
        ctx.fleetDirty = false
        Fleet.write(ctx)
    end
end
