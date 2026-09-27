-- One tap on g_farmManager:updateFarmStats for the ledger's producers. Field-work tools report
-- their hectares and the seed or spray they used through it, from inside their own work-area
-- listeners (SowingMachine, Sprayer, Cultivator and Plow onEndWorkAreaProcessing), so a producer
-- that runs that listener can read what it reported. Listeners are added once, at file scope, and
-- called after the game's own update with (farmId, statName, delta).
--
-- The farm manager is per mission, so the tap is put on at mission start and taken off at the end.

FarmLink = FarmLink or {}

local FarmStatsTap = {
    name = "farmStatsTap",
    authority = "server",
    listeners = {},
}
FarmLink.FarmStatsTap = FarmStatsTap

local unpack = unpack or table.unpack
local wrap = nil

local function pack(...)
    return { n = select("#", ...), ... }
end

---Adds fn(farmId, statName, delta) to every future stat update. Call once per process.
function FarmStatsTap.listen(fn)
    FarmStatsTap.listeners[#FarmStatsTap.listeners + 1] = fn
end

local function notify(farmId, statName, delta)
    for _, fn in ipairs(FarmStatsTap.listeners) do
        pcall(fn, farmId, statName, delta)
    end
end

function FarmStatsTap.init(_ctx)
    local manager = g_farmManager
    local original = type(manager) == "table" and manager.updateFarmStats or nil
    if type(original) ~= "function" then
        wrap = nil
        return
    end
    local wrapper = function(self, farmId, statName, delta, ...)
        local r = pack(original(self, farmId, statName, delta, ...))
        notify(farmId, statName, delta)
        return unpack(r, 1, r.n)
    end
    wrap = {
        manager = manager,
        original = original,
        wrapper = wrapper,
        hadInstanceField = rawget(manager, "updateFarmStats") ~= nil,
    }
    manager.updateFarmStats = wrapper
end

function FarmStatsTap.shutdown(_ctx)
    if wrap == nil or rawget(wrap.manager, "updateFarmStats") ~= wrap.wrapper then
        wrap = nil
        return
    end
    if wrap.hadInstanceField then
        wrap.manager.updateFarmStats = wrap.original
    else
        rawset(wrap.manager, "updateFarmStats", nil)
    end
    wrap = nil
end
