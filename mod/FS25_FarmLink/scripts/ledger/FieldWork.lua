-- Field work (docs/HANDOFF.md, "Field work"): hectares sown, sprayed, fertilized and tilled, by
-- field, with the seed or spray used. Each tool reports its own hectares and usage through
-- updateFarmStats from inside its onEndWorkAreaProcessing listener, which the game dispatches by
-- name at call time (PLAN_REVIEW.md F7), so the listener is wrapped on the class and FarmStatsTap
-- hands this module what it reported during the call.
--
--   SowingMachine  sownHectares, seedUsage     seeding
--   Sprayer        sprayedHectares, sprayUsage spraying (herbicide) or fertilizing (everything else)
--   Cultivator     cultivatedHectares          tillage
--   Plow           plowedHectares              tillage
--
-- The work is credited to the machine pulling the tool (the root vehicle): that is the one with
-- operating hours, fuel and wages, so its time on the field prices the field's machine cost. Reports
-- are gathered per machine, field, kind of work and input, and written as one `field_work` event on
-- the same rules as harvests. On contract land the field is left out.

FarmLink = FarmLink or {}

local FieldWork = {
    name = "fieldWork",
    authority = "server",
    QUIET_MS = 10000,
    MAX_AGE_MS = 30000,
    TOOLS = {
        { class = "SowingMachine", hectares = "sownHectares", usage = "seedUsage" },
        { class = "Sprayer", hectares = "sprayedHectares", usage = "sprayUsage" },
        { class = "Cultivator", hectares = "cultivatedHectares" },
        { class = "Plow", hectares = "plowedHectares" },
    },
    -- Sprayed fill types that are plant protection rather than fertilizer.
    SPRAYING = { HERBICIDE = true },
}
FarmLink.FieldWork = FieldWork

local unpack = unpack or table.unpack
local gather = nil
-- The stats reported during the listener call being run, or nil.
local scope = nil

local function pack(...)
    return { n = select("#", ...), ... }
end

FarmLink.FarmStatsTap.listen(function(_farmId, statName, delta)
    if scope ~= nil and type(delta) == "number" then
        scope[statName] = (scope[statName] or 0) + delta
    end
end)

local function write(bucket)
    local Game = FarmLink.Game
    local Json = FarmLink.Json
    local worked = nil
    local now = Game.operatingMs(bucket.root)
    if bucket.startMs ~= nil and now ~= nil and now >= bucket.startMs then
        worked = Game.round((now - bucket.startMs) / 3600000, 4)
    end
    FarmLink.EventLog.emit("field_work", bucket.farmId, {
        fieldId = Json.orNull(bucket.fieldId),
        farmlandId = Json.orNull(bucket.farmlandId),
        workType = bucket.workType,
        areaHa = Game.round(bucket.areaHa, 4),
        inputFillType = Json.orNull(bucket.inputFillType),
        inputLiters = Json.orNull(bucket.inputLiters ~= nil and Game.round(bucket.inputLiters, 4) or nil),
        vehicleId = bucket.vehicleId,
        isAI = bucket.isAI,
        workedHours = Json.orNull(worked),
    })
end

-- What kind of work a tool did, and with what.
local function describe(tool, vehicle)
    local Game = FarmLink.Game
    if tool.class == "SowingMachine" then
        local spec = vehicle.spec_sowingMachine
        return "seeding", type(spec) == "table" and Game.fillTypeName(spec.seedFillType) or nil
    elseif tool.class == "Sprayer" then
        local spec = vehicle.spec_sprayer
        local params = type(spec) == "table" and spec.workAreaParameters or nil
        local fillType = type(params) == "table" and Game.fillTypeName(params.sprayFillType) or nil
        return FieldWork.SPRAYING[fillType or ""] and "spraying" or "fertilizing", fillType
    end
    return "tillage", nil
end

---A tool's listener reported stats; gather what it did on this field.
function FieldWork.record(tool, vehicle, stats)
    local Game = FarmLink.Game
    local ha = Game.num(stats[tool.hectares])
    if gather == nil or ha == nil or ha <= 0 then
        return
    end
    local root = Game.call(vehicle, "getRootVehicle") or vehicle
    local vehicleId = Game.vehicleId(root)
    if vehicleId == nil then
        return
    end
    local workType, inputFillType = describe(tool, vehicle)
    local farmlandId, fieldId = Game.workPlace(vehicle)
    local key = table.concat({ vehicleId, tostring(fieldId), tostring(farmlandId), workType, tostring(inputFillType) }, "|")
    gather:flush(function(bucket)
        return bucket.vehicleId == vehicleId and bucket.key ~= key
    end)
    local bucket = gather:bucket(key, function()
        local owner = Game.call(vehicle, "getOwnerFarmId")
        return {
            root = root,
            vehicleId = vehicleId,
            farmId = type(owner) == "number" and owner or 0,
            fieldId = fieldId,
            farmlandId = farmlandId,
            workType = workType,
            inputFillType = inputFillType,
            areaHa = 0,
            isAI = Game.call(root, "getIsAIActive") == true,
            startMs = Game.operatingMs(root),
        }
    end)
    bucket.areaHa = bucket.areaHa + ha
    local usage = tool.usage ~= nil and Game.num(stats[tool.usage]) or nil
    if usage ~= nil and inputFillType ~= nil then
        bucket.inputLiters = (bucket.inputLiters or 0) + usage
    end
end

local function wrapListener(tool)
    local class = _G[tool.class]
    if type(class) ~= "table" or type(class.onEndWorkAreaProcessing) ~= "function" then
        return false
    end
    local original = class.onEndWorkAreaProcessing
    class.onEndWorkAreaProcessing = function(self, ...)
        if gather == nil then
            return original(self, ...)
        end
        local previous = scope
        scope = {}
        local r = pack(pcall(original, self, ...))
        local stats = scope
        scope = previous
        if not r[1] then
            error(r[2], 0)
        end
        pcall(FieldWork.record, tool, self, stats)
        return unpack(r, 2, r.n)
    end
    return true
end

function FieldWork.installProcessHooks()
    if FieldWork.processHooksInstalled then
        return
    end
    FieldWork.processHooksInstalled = true
    FieldWork.hooked = {}
    for _, tool in ipairs(FieldWork.TOOLS) do
        FieldWork.hooked[tool.class] = wrapListener(tool)
    end
end

function FieldWork.init(_ctx)
    scope = nil
    gather = FarmLink.Gather.new(write, FieldWork.QUIET_MS, FieldWork.MAX_AGE_MS)
end

function FieldWork.update(dt, _ctx)
    gather:tick(dt)
end

function FieldWork.beforeRollover(_ctx)
    gather:flush()
end

function FieldWork.beforeSave(_ctx)
    gather:flush()
end

function FieldWork.shutdown(_ctx)
    if gather ~= nil then
        gather:flush()
    end
    gather = nil
    scope = nil
end
