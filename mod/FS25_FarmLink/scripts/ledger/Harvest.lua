-- Harvest attribution (docs/HANDOFF.md, "Harvest attribution"): the liters a combine threshes, by
-- field and fill type. Combine.addCutterArea returns the liters the combine actually added
-- (VERIFY_FIRST.md, 5); it is a specialization function, so it is hooked with
-- SpecializationUtil.registerOverwrittenFunction when vehicle types are set up (PLAN_REVIEW.md F7).
--
-- The combine's position gives the farmland and field; on contract land the field is left out, since
-- that crop is the contract's. Liters are gathered per machine, field and fill type and written as
-- one `harvest` event: 10 s after the combine stops threshing, every 30 s while it goes on, when it
-- moves to another field, and before a day rollover or a save (PLAN_REVIEW.md F3). workedHours is
-- the combine's operating time over the gathered stretch.

FarmLink = FarmLink or {}

local Harvest = {
    name = "harvest",
    authority = "server",
    QUIET_MS = 10000,
    MAX_AGE_MS = 30000,
}
FarmLink.Harvest = Harvest

local unpack = unpack or table.unpack
local gather = nil

local function pack(...)
    return { n = select("#", ...), ... }
end

local function write(bucket)
    local Game = FarmLink.Game
    local Json = FarmLink.Json
    local worked = nil
    local now = Game.operatingMs(bucket.vehicle)
    if bucket.startMs ~= nil and now ~= nil and now >= bucket.startMs then
        worked = Game.round((now - bucket.startMs) / 3600000, 4)
    end
    FarmLink.EventLog.emit("harvest", bucket.farmId, {
        fieldId = Json.orNull(bucket.fieldId),
        farmlandId = Json.orNull(bucket.farmlandId),
        fillType = bucket.fillType,
        liters = Game.round(bucket.liters, 4),
        vehicleId = bucket.vehicleId,
        isAI = bucket.isAI,
        workedHours = Json.orNull(worked),
    })
end

---A combine added liters of a fill type to its tank.
function Harvest.record(vehicle, liters, fillTypeIndex, farmId)
    local Game = FarmLink.Game
    local vehicleId = Game.vehicleId(vehicle)
    local fillType = Game.fillTypeName(fillTypeIndex)
    if gather == nil or vehicleId == nil or fillType == nil or Game.num(liters) == nil or liters <= 0 then
        return
    end
    local farmlandId, fieldId = Game.workPlace(vehicle)
    local key = table.concat({ vehicleId, tostring(fieldId), tostring(farmlandId), fillType }, "|")
    -- Another field: what was gathered on the last one is done.
    gather:flush(function(bucket)
        return bucket.vehicleId == vehicleId and bucket.key ~= key
    end)
    local bucket = gather:bucket(key, function()
        local owner = Game.call(vehicle, "getOwnerFarmId")
        return {
            vehicle = vehicle,
            vehicleId = vehicleId,
            farmId = (type(farmId) == "number" and farmId > 0 and farmId) or (type(owner) == "number" and owner) or 0,
            fieldId = fieldId,
            farmlandId = farmlandId,
            fillType = fillType,
            liters = 0,
            isAI = Game.call(vehicle, "getIsAIActive") == true,
            startMs = Game.operatingMs(vehicle),
        }
    end)
    bucket.liters = bucket.liters + liters
end

---Registered over Combine.addCutterArea; returns the game's result untouched.
function Harvest.addCutterArea(self, superFunc, area, liters, inputFruitType, outputFillType, strawRatio, farmId, cutterLoad)
    local r = pack(superFunc(self, area, liters, inputFruitType, outputFillType, strawRatio, farmId, cutterLoad))
    if gather ~= nil then
        pcall(Harvest.record, self, r[1], outputFillType, farmId)
    end
    return unpack(r, 1, r.n)
end

function Harvest.installProcessHooks()
    if Harvest.processHooksInstalled then
        return
    end
    Harvest.processHooksInstalled = true
    if
        type(Utils) == "table"
        and type(Utils.appendedFunction) == "function"
        and type(Combine) == "table"
        and type(Combine.registerOverwrittenFunctions) == "function"
        and type(SpecializationUtil) == "table"
        and type(SpecializationUtil.registerOverwrittenFunction) == "function"
    then
        Combine.registerOverwrittenFunctions = Utils.appendedFunction(Combine.registerOverwrittenFunctions, function(vehicleType)
            -- Runs inside the game's vehicle-type setup: a failure here must not reach it.
            pcall(SpecializationUtil.registerOverwrittenFunction, vehicleType, "addCutterArea", Harvest.addCutterArea)
        end)
        Harvest.hooked = true
    end
end

function Harvest.init(_ctx)
    gather = FarmLink.Gather.new(write, Harvest.QUIET_MS, Harvest.MAX_AGE_MS)
end

function Harvest.update(dt, _ctx)
    gather:tick(dt)
end

function Harvest.beforeRollover(_ctx)
    gather:flush()
end

function Harvest.beforeSave(_ctx)
    gather:flush()
end

function Harvest.shutdown(_ctx)
    if gather ~= nil then
        gather:flush()
    end
    gather = nil
end
