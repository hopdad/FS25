-- live_vehicle.json: the local player's vehicle, once a second. Contract: packages/schema/src/live.ts.
-- Every engine read goes through FarmLink.Game, so a getter that a patch renames or another mod breaks
-- costs one field instead of the frame.

FarmLink = FarmLink or {}

local VehicleCollector = {
    name = "vehicle",
    authority = "server",
    FILE_NAME = "live_vehicle.json",
    INTERVAL_MS = 1000,
    MAX_IMPLEMENT_DEPTH = 4,
}
FarmLink.VehicleCollector = VehicleCollector

-- MotorState values (vehicles/specializations/enums/MotorState.lua), used when the enum is missing.
local MOTOR_STARTING = 3
local MOTOR_ON = 4

---World position, and heading in degrees with 0 = north (-z in the GIANTS world), clockwise.
local function position(vehicle)
    local Game = FarmLink.Game
    if vehicle.rootNode == nil or type(getWorldTranslation) ~= "function" then
        return { x = 0, z = 0 }
    end
    local ok, x, y, z = pcall(getWorldTranslation, vehicle.rootNode)
    if not ok or Game.num(x) == nil or Game.num(z) == nil then
        return { x = 0, z = 0 }
    end
    local pos = { x = Game.round(x, 2), z = Game.round(z, 2) }
    if Game.num(y) ~= nil then
        pos.y = Game.round(y, 2)
    end
    if type(localDirectionToWorld) == "function" then
        local dirOk, dx, _, dz = pcall(localDirectionToWorld, vehicle.rootNode, 0, 0, 1)
        if dirOk and Game.num(dx) ~= nil and Game.num(dz) ~= nil and (dx ~= 0 or dz ~= 0) then
            pos.heading = Game.round(math.deg(math.atan2(dx, -dz)) % 360, 1) % 360
        end
    end
    return pos
end

local function fillUnits(object, skip)
    local Game = FarmLink.Game
    local Json = FarmLink.Json
    local out = {}
    local spec = object.spec_fillUnit
    local units = type(spec) == "table" and spec.fillUnits or nil
    if type(units) == "table" then
        for index, unit in ipairs(units) do
            if not skip[index] and type(unit) == "table" and unit.showOnInfoHud ~= false then
                local name = Game.fillTypeName(unit.fillType)
                if name ~= "AIR" then
                    local capacity = Game.num(unit.capacity)
                    out[#out + 1] = {
                        fillType = Json.orNull(name),
                        level = Game.round(math.max(0, Game.num(unit.fillLevel) or 0), 1),
                        capacity = capacity ~= nil and Game.round(math.max(0, capacity), 1) or Json.null,
                    }
                end
            end
        end
    end
    return Json.array(out)
end

---RPM and gear. RPM reads 0 unless the engine is on or cranking: the engine stops updating the value
---when the motor stops, so the last reading would otherwise linger.
local function motor(vehicle)
    local Game = FarmLink.Game
    if vehicle.spec_motorized == nil then
        return nil, nil
    end
    local engine = Game.call(vehicle, "getMotor")
    local running
    local motorState = Game.call(vehicle, "getMotorState")
    if type(motorState) == "number" then
        local states = type(MotorState) == "table" and MotorState or {}
        running = motorState == (states.ON or MOTOR_ON) or motorState == (states.STARTING or MOTOR_STARTING)
    else
        running = Game.call(vehicle, "getIsMotorStarted") == true
    end
    local rpm = 0
    if running then
        rpm = Game.num(Game.call(engine, "getLastMotorRpm")) or 0
    end
    local gear = Game.call(engine, "getGearToDisplay")
    if gear ~= nil then
        gear = tostring(gear)
    end
    return Game.round(math.max(0, rpm), 0), gear
end

---The live state of one vehicle, shaped like VehicleState in the contract.
---@param vehicle table
---@return table
function VehicleCollector.snapshot(vehicle)
    local Game = FarmLink.Game
    local Json = FarmLink.Json
    local fuelType, fuelPct = Game.fuel(vehicle)
    local rpm, gear = motor(vehicle)
    local operatingMs = Game.num(vehicle.operatingTime)

    local implements = {}
    for _, implement in ipairs(Game.implements(vehicle, VehicleCollector.MAX_IMPLEMENT_DEPTH)) do
        implements[#implements + 1] = {
            vehicleId = Json.orNull(Game.vehicleId(implement)),
            name = Game.vehicleName(implement),
            fillUnits = fillUnits(implement, {}),
        }
    end

    return {
        vehicleId = Json.orNull(Game.vehicleId(vehicle)),
        name = Game.vehicleName(vehicle),
        speedKmh = Game.round(math.abs(Game.num(Game.call(vehicle, "getLastSpeed")) or 0), 1),
        rpm = Json.orNull(rpm),
        gear = Json.orNull(gear),
        fuelType = Json.orNull(fuelType),
        fuelPct = Json.orNull(fuelPct),
        damagePct = Json.orNull(Game.damagePct(vehicle)),
        operatingHours = operatingMs ~= nil and Game.round(math.max(0, operatingMs) / 3600000, 2) or Json.null,
        position = position(vehicle),
        isAI = Game.call(vehicle, "getIsAIActive") == true,
        fillUnits = fillUnits(vehicle, Game.propellantIndices(vehicle)),
        implements = Json.array(implements),
    }
end

---One live_vehicle.json document. vehicle is null while the player is on foot.
---@param ctx table
---@return table
function VehicleCollector.frame(ctx)
    local Clock = FarmLink.Clock
    local vehicle = FarmLink.Game.call(g_localPlayer, "getCurrentVehicle")
    local snapshot = FarmLink.Json.null
    if type(vehicle) == "table" then
        snapshot = VehicleCollector.snapshot(vehicle)
    end
    return {
        v = 1,
        saveId = ctx.ledger.saveId,
        sessionId = ctx.sessionId,
        realTs = Clock.realTimestamp(),
        day = Clock.gameDay(),
        minute = Clock.minuteOfDay(),
        vehicle = snapshot,
    }
end

local function recordCost(live, ms)
    live.timed = live.timed + 1
    live.totalMs = live.totalMs + ms
    if ms > live.maxMs then
        live.maxMs = ms
    end
end

function VehicleCollector.init(ctx)
    local interval = VehicleCollector.INTERVAL_MS
    ctx.vehicleThrottle = FarmLink.Clock.newThrottle(interval, interval)
end

function VehicleCollector.update(dt, ctx)
    if not ctx.vehicleThrottle:tick(dt) then
        return
    end
    local Clock = FarmLink.Clock
    local startedMs = Clock.preciseMs()
    local text = FarmLink.Json.encode(VehicleCollector.frame(ctx))
    local ok, err = FarmLink.FileIO.writeText(ctx.saveDir .. VehicleCollector.FILE_NAME, text)
    local finishedMs = Clock.preciseMs()

    local live = ctx.stats.live
    live.writes = live.writes + 1
    if startedMs ~= nil and finishedMs ~= nil then
        recordCost(live, math.max(0, finishedMs - startedMs))
    end
    if not ok then
        error("writing live_vehicle.json: " .. tostring(err), 0)
    end
end
