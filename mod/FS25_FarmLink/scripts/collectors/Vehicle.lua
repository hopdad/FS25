-- live_vehicle.json: the local player's vehicle, once a second. Contract: packages/schema/src/live.ts.
-- Every engine read goes through call(), so a getter that a patch renames or another mod breaks costs
-- one field instead of the frame.

FarmLink = FarmLink or {}

local VehicleCollector = {
    name = "vehicle",
    authority = "server",
    FILE_NAME = "live_vehicle.json",
    INTERVAL_MS = 1000,
    MAX_IMPLEMENT_DEPTH = 4,
}
FarmLink.VehicleCollector = VehicleCollector

-- Fill types a motor burns; the first one a vehicle consumes is its fuel.
local FUEL_TYPES = { DIESEL = true, ELECTRICCHARGE = true, METHANE = true }
-- MotorState values (vehicles/specializations/enums/MotorState.lua), used when the enum is missing.
local MOTOR_STARTING = 3
local MOTOR_ON = 4

local state = nil

local function call(object, method, ...)
    if type(object) ~= "table" then
        return nil
    end
    local fn = object[method]
    if type(fn) ~= "function" then
        return nil
    end
    local ok, result = pcall(fn, object, ...)
    if not ok then
        return nil
    end
    return result
end

---A finite number, or nil.
local function num(value)
    if type(value) == "number" and value == value and value ~= math.huge and value ~= -math.huge then
        return value
    end
    return nil
end

local function round(value, decimals)
    local mult = 10 ^ decimals
    return math.floor(value * mult + 0.5) / mult
end

local function clamp(value, low, high)
    return math.max(low, math.min(high, value))
end

local function fillTypeName(index)
    if type(index) ~= "number" or g_fillTypeManager == nil then
        return nil
    end
    local name = call(g_fillTypeManager, "getFillTypeNameByIndex", index)
    if type(name) ~= "string" then
        local desc = call(g_fillTypeManager, "getFillTypeByIndex", index)
        name = type(desc) == "table" and desc.name or nil
    end
    if type(name) ~= "string" or name == "" or name == "UNKNOWN" then
        return nil
    end
    return name
end

local function displayName(vehicle)
    local name = call(vehicle, "getFullName")
    if type(name) == "string" and name ~= "" then
        return name
    end
    if type(vehicle.typeName) == "string" then
        return vehicle.typeName
    end
    return "Vehicle"
end

---World position, and heading in degrees with 0 = north (-z in the GIANTS world), clockwise.
local function position(vehicle)
    if vehicle.rootNode == nil or type(getWorldTranslation) ~= "function" then
        return { x = 0, z = 0 }
    end
    local ok, x, y, z = pcall(getWorldTranslation, vehicle.rootNode)
    if not ok or num(x) == nil or num(z) == nil then
        return { x = 0, z = 0 }
    end
    local pos = { x = round(x, 2), z = round(z, 2) }
    if num(y) ~= nil then
        pos.y = round(y, 2)
    end
    if type(localDirectionToWorld) == "function" then
        local dirOk, dx, _, dz = pcall(localDirectionToWorld, vehicle.rootNode, 0, 0, 1)
        if dirOk and num(dx) ~= nil and num(dz) ~= nil and (dx ~= 0 or dz ~= 0) then
            pos.heading = round(math.deg(math.atan2(dx, -dz)) % 360, 1) % 360
        end
    end
    return pos
end

---Indices of the fill units that feed the motor (fuel, DEF, air), which fillUnits() leaves out.
local function propellantIndices(vehicle)
    local skip = {}
    local spec = vehicle.spec_motorized
    if type(spec) ~= "table" then
        return skip
    end
    if type(spec.propellantFillUnitIndices) == "table" then
        for _, index in ipairs(spec.propellantFillUnitIndices) do
            skip[index] = true
        end
    end
    if type(spec.consumersByFillType) == "table" then
        for _, consumer in pairs(spec.consumersByFillType) do
            if type(consumer) == "table" and consumer.fillUnitIndex ~= nil then
                skip[consumer.fillUnitIndex] = true
            end
        end
    end
    return skip
end

local function fillUnits(object, skip)
    local Json = FarmLink.Json
    local out = {}
    local spec = object.spec_fillUnit
    local units = type(spec) == "table" and spec.fillUnits or nil
    if type(units) == "table" then
        for index, unit in ipairs(units) do
            if not skip[index] and type(unit) == "table" and unit.showOnInfoHud ~= false then
                local name = fillTypeName(unit.fillType)
                if name ~= "AIR" then
                    local capacity = num(unit.capacity)
                    out[#out + 1] = {
                        fillType = Json.orNull(name),
                        level = round(math.max(0, num(unit.fillLevel) or 0), 1),
                        capacity = capacity ~= nil and round(math.max(0, capacity), 1) or Json.null,
                    }
                end
            end
        end
    end
    return Json.array(out)
end

local function fuel(vehicle)
    local spec = vehicle.spec_motorized
    if type(spec) ~= "table" or type(spec.consumersByFillType) ~= "table" then
        return nil, nil
    end
    for fillTypeIndex, consumer in pairs(spec.consumersByFillType) do
        local name = fillTypeName(fillTypeIndex)
        if name ~= nil and FUEL_TYPES[name] and type(consumer) == "table" and consumer.fillUnitIndex ~= nil then
            local index = consumer.fillUnitIndex
            local share = num(call(vehicle, "getFillUnitFillLevelPercentage", index))
            if share == nil then
                local level = num(call(vehicle, "getFillUnitFillLevel", index))
                local capacity = num(call(vehicle, "getFillUnitCapacity", index))
                if level ~= nil and capacity ~= nil and capacity > 0 then
                    share = level / capacity
                end
            end
            if share == nil then
                return name, nil
            end
            return name, round(clamp(share * 100, 0, 100), 1)
        end
    end
    return nil, nil
end

---RPM and gear. RPM reads 0 unless the engine is on or cranking: the engine stops updating the value
---when the motor stops, so the last reading would otherwise linger.
local function motor(vehicle)
    if vehicle.spec_motorized == nil then
        return nil, nil
    end
    local engine = call(vehicle, "getMotor")
    local running
    local motorState = call(vehicle, "getMotorState")
    if type(motorState) == "number" then
        local states = type(MotorState) == "table" and MotorState or {}
        running = motorState == (states.ON or MOTOR_ON) or motorState == (states.STARTING or MOTOR_STARTING)
    else
        running = call(vehicle, "getIsMotorStarted") == true
    end
    local rpm = 0
    if running then
        rpm = num(call(engine, "getLastMotorRpm")) or 0
    end
    local gear = call(engine, "getGearToDisplay")
    if gear ~= nil then
        gear = tostring(gear)
    end
    return round(math.max(0, rpm), 0), gear
end

local function collectImplements(object, out, depth)
    if depth > VehicleCollector.MAX_IMPLEMENT_DEPTH then
        return
    end
    local attached = call(object, "getAttachedImplements")
    if type(attached) ~= "table" then
        return
    end
    for _, entry in ipairs(attached) do
        local implement = type(entry) == "table" and entry.object or nil
        if type(implement) == "table" then
            local id = call(implement, "getUniqueId")
            out[#out + 1] = {
                vehicleId = FarmLink.Json.orNull(type(id) == "string" and id or nil),
                name = displayName(implement),
                fillUnits = fillUnits(implement, {}),
            }
            collectImplements(implement, out, depth + 1)
        end
    end
end

---The live state of one vehicle, shaped like VehicleState in the contract.
---@param vehicle table
---@return table
function VehicleCollector.snapshot(vehicle)
    local Json = FarmLink.Json
    local fuelType, fuelPct = fuel(vehicle)
    local rpm, gear = motor(vehicle)
    local damage = num(call(vehicle, "getDamageAmount"))
    local operatingMs = num(vehicle.operatingTime)
    local id = call(vehicle, "getUniqueId")
    local implements = {}
    collectImplements(vehicle, implements, 1)

    return {
        vehicleId = Json.orNull(type(id) == "string" and id or nil),
        name = displayName(vehicle),
        speedKmh = round(math.abs(num(call(vehicle, "getLastSpeed")) or 0), 1),
        rpm = Json.orNull(rpm),
        gear = Json.orNull(gear),
        fuelType = Json.orNull(fuelType),
        fuelPct = Json.orNull(fuelPct),
        damagePct = damage ~= nil and round(clamp(damage * 100, 0, 100), 1) or Json.null,
        operatingHours = operatingMs ~= nil and round(math.max(0, operatingMs) / 3600000, 2) or Json.null,
        position = position(vehicle),
        isAI = call(vehicle, "getIsAIActive") == true,
        fillUnits = fillUnits(vehicle, propellantIndices(vehicle)),
        implements = Json.array(implements),
    }
end

---One live_vehicle.json document. vehicle is null while the player is on foot.
---@param ctx table
---@return table
function VehicleCollector.frame(ctx)
    local Clock = FarmLink.Clock
    local vehicle = call(g_localPlayer, "getCurrentVehicle")
    local snapshot = FarmLink.Json.null
    if type(vehicle) == "table" then
        snapshot = VehicleCollector.snapshot(vehicle)
    end
    return {
        v = 1,
        saveId = ctx.ledger.saveId,
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

function VehicleCollector.init(_ctx)
    local interval = VehicleCollector.INTERVAL_MS
    state = { throttle = FarmLink.Clock.newThrottle(interval, interval) }
end

function VehicleCollector.update(dt, ctx)
    if not state.throttle:tick(dt) then
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

function VehicleCollector.shutdown(_ctx)
    state = nil
end
