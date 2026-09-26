-- Small, fail-soft readers for game state that several modules share: safe method calls, fill type
-- names, the farmland and field under a world position, AI job details and vehicle fuel. Every read
-- is pcall'd, because a patch or another mod can rename or break any of them.

FarmLink = FarmLink or {}

local Game = {}
FarmLink.Game = Game

---Calls object:method(...) and returns its first result, or nil when the method is missing or throws.
function Game.call(object, method, ...)
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
function Game.num(value)
    if type(value) == "number" and value == value and value ~= math.huge and value ~= -math.huge then
        return value
    end
    return nil
end

function Game.round(value, decimals)
    local mult = 10 ^ decimals
    return math.floor(value * mult + 0.5) / mult
end

function Game.clamp(value, low, high)
    return math.max(low, math.min(high, value))
end

---A fill type's name (WHEAT, DIESEL), or nil for an unknown or empty one.
function Game.fillTypeName(index)
    if type(index) ~= "number" or g_fillTypeManager == nil then
        return nil
    end
    local name = Game.call(g_fillTypeManager, "getFillTypeNameByIndex", index)
    if type(name) ~= "string" then
        local desc = Game.call(g_fillTypeManager, "getFillTypeByIndex", index)
        name = type(desc) == "table" and desc.name or nil
    end
    if type(name) ~= "string" or name == "" or name == "UNKNOWN" then
        return nil
    end
    return name
end

---The vehicle's persistent id (set on the server; nil on a multiplayer client).
function Game.vehicleId(vehicle)
    local id = Game.call(vehicle, "getUniqueId")
    if type(id) == "string" and id ~= "" then
        return id
    end
    return nil
end

function Game.vehicleName(vehicle)
    local name = Game.call(vehicle, "getFullName")
    if type(name) == "string" and name ~= "" then
        return name
    end
    if type(vehicle) == "table" and type(vehicle.typeName) == "string" then
        return vehicle.typeName
    end
    return "Vehicle"
end

---World x, z of a vehicle's root node, or nil.
function Game.vehiclePosition(vehicle)
    if type(vehicle) ~= "table" or vehicle.rootNode == nil or type(getWorldTranslation) ~= "function" then
        return nil
    end
    local ok, x, _, z = pcall(getWorldTranslation, vehicle.rootNode)
    if not ok or Game.num(x) == nil or Game.num(z) == nil then
        return nil
    end
    return x, z
end

---Farmland id and field id at a world position. FS25 links each field to exactly one farmland
---(VERIFY_FIRST.md, 5). Either can be nil: a road has neither, a pasture has only a farmland.
function Game.fieldAt(x, z)
    if Game.num(x) == nil or Game.num(z) == nil then
        return nil, nil
    end
    local farmlandId = Game.call(g_farmlandManager, "getFarmlandIdAtWorldPosition", x, z)
    if type(farmlandId) ~= "number" or farmlandId <= 0 then
        return nil, nil
    end
    local fieldId = nil
    local mapping = g_fieldManager ~= nil and g_fieldManager.farmlandIdFieldMapping or nil
    local field = type(mapping) == "table" and mapping[farmlandId] or nil
    if type(field) == "table" then
        local id = Game.call(field, "getId") or field.fieldId or field.id
        if type(id) == "number" and id > 0 then
            fieldId = id
        end
    end
    return farmlandId, fieldId
end

---The vehicle an AI job drives.
function Game.jobVehicle(job)
    if type(job) ~= "table" then
        return nil
    end
    local vehicle = Game.call(job.vehicleParameter, "getVehicle")
    if type(vehicle) == "table" then
        return vehicle
    end
    return nil
end

---The job type's registered name, for example FIELDWORK.
function Game.jobTypeName(job)
    local manager = g_currentMission ~= nil and g_currentMission.aiJobTypeManager or nil
    if type(job) ~= "table" or manager == nil then
        return "UNKNOWN"
    end
    local index = job.jobTypeIndex
    if index == nil then
        index = Game.call(manager, "getJobTypeIndex", job)
    end
    local entry = Game.call(manager, "getJobTypeByIndex", index)
    if type(entry) == "table" and type(entry.name) == "string" then
        return entry.name
    end
    return "UNKNOWN"
end

---The field a job works: its target position for field work, else where its vehicle is.
function Game.jobField(job)
    local x, z = nil, nil
    if type(job) == "table" and type(job.positionAngleParameter) == "table" then
        local ok, px, pz = pcall(job.positionAngleParameter.getPosition, job.positionAngleParameter)
        if ok then
            x, z = px, pz
        end
    end
    if Game.num(x) == nil then
        x, z = Game.vehiclePosition(Game.jobVehicle(job))
    end
    local _, fieldId = Game.fieldAt(x, z)
    return fieldId
end

---The registered name of an AI stop message (ERROR_OUT_OF_FUEL, ...), UNKNOWN when there is none.
function Game.aiMessageName(aiMessage)
    if aiMessage == nil then
        return "UNKNOWN"
    end
    local manager = g_currentMission ~= nil and g_currentMission.aiMessageManager or nil
    local index = Game.call(manager, "getMessageIndex", aiMessage)
    local entry = (index ~= nil and type(manager.messages) == "table") and manager.messages[index] or nil
    if type(entry) == "table" and type(entry.name) == "string" then
        return entry.name
    end
    return "UNKNOWN"
end

-- Fill types a motor burns; the first one a vehicle consumes is its fuel.
local FUEL_TYPES = { DIESEL = true, ELECTRICCHARGE = true, METHANE = true }

---Fuel type name and fill percentage (0 to 100), or nils for a vehicle without a motor.
function Game.fuel(vehicle)
    local spec = type(vehicle) == "table" and vehicle.spec_motorized or nil
    if type(spec) ~= "table" or type(spec.consumersByFillType) ~= "table" then
        return nil, nil
    end
    for fillTypeIndex, consumer in pairs(spec.consumersByFillType) do
        local name = Game.fillTypeName(fillTypeIndex)
        if name ~= nil and FUEL_TYPES[name] and type(consumer) == "table" and consumer.fillUnitIndex ~= nil then
            local index = consumer.fillUnitIndex
            local share = Game.num(Game.call(vehicle, "getFillUnitFillLevelPercentage", index))
            if share == nil then
                local level = Game.num(Game.call(vehicle, "getFillUnitFillLevel", index))
                local capacity = Game.num(Game.call(vehicle, "getFillUnitCapacity", index))
                if level ~= nil and capacity ~= nil and capacity > 0 then
                    share = level / capacity
                end
            end
            if share == nil then
                return name, nil
            end
            return name, Game.round(Game.clamp(share * 100, 0, 100), 1)
        end
    end
    return nil, nil
end

---Damage as a percentage, or nil when the vehicle does not wear.
function Game.damagePct(vehicle)
    local damage = Game.num(Game.call(vehicle, "getDamageAmount"))
    if damage == nil then
        return nil
    end
    return Game.round(Game.clamp(damage * 100, 0, 100), 1)
end

---Indices of the fill units that feed the motor (fuel, DEF, air).
function Game.propellantIndices(vehicle)
    local skip = {}
    local spec = type(vehicle) == "table" and vehicle.spec_motorized or nil
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

---The attached implements' vehicles, depth first, up to maxDepth levels down.
function Game.implements(vehicle, maxDepth, out, depth)
    out = out or {}
    depth = depth or 1
    if depth > (maxDepth or 4) then
        return out
    end
    local attached = Game.call(vehicle, "getAttachedImplements")
    if type(attached) ~= "table" then
        return out
    end
    for _, entry in ipairs(attached) do
        local implement = type(entry) == "table" and entry.object or nil
        if type(implement) == "table" then
            out[#out + 1] = implement
            Game.implements(implement, maxDepth, out, depth + 1)
        end
    end
    return out
end

---The fullest cargo tank on a rig (the vehicle and its implements), as a percentage: a combine's
---grain tank, a trailer. Fuel, air and hidden or unlimited units do not count.
function Game.rigTankPct(vehicle)
    local best = nil
    local objects = { vehicle }
    for _, implement in ipairs(Game.implements(vehicle, 4)) do
        objects[#objects + 1] = implement
    end
    for _, object in ipairs(objects) do
        local spec = type(object) == "table" and object.spec_fillUnit or nil
        local units = type(spec) == "table" and spec.fillUnits or nil
        if type(units) == "table" then
            local skip = Game.propellantIndices(object)
            for index, unit in ipairs(units) do
                local capacity = Game.num(unit.capacity)
                if
                    not skip[index]
                    and unit.showOnInfoHud ~= false
                    and capacity ~= nil
                    and capacity > 0
                    and Game.fillTypeName(unit.fillType) ~= "AIR"
                then
                    local pct = Game.clamp((Game.num(unit.fillLevel) or 0) / capacity * 100, 0, 100)
                    if best == nil or pct > best then
                        best = pct
                    end
                end
            end
        end
    end
    if best == nil then
        return nil
    end
    return Game.round(best, 1)
end
