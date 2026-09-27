-- Shared spec setup: a fresh engine stub and a freshly sourced mod for every test.

local Engine = require("engine")
local dkjson = require("dkjson")

local helper = {}

---Installs the engine stub and sources FarmLink as the game would. Returns the engine.
function helper.freshMod(opts)
    Engine.install(opts)
    Engine.loadMod()
    return Engine
end

---Keeps only the named modules in FarmLink's registry, for specs about one part of the mod.
function helper.onlyModules(names)
    local keep = {}
    for _, name in ipairs(names) do
        keep[name] = true
    end
    local modules = {}
    for _, module in ipairs(FarmLink.registry.modules) do
        if keep[module.name] then
            modules[#modules + 1] = module
        end
    end
    FarmLink.registry.modules = modules
end

---Reads and decodes a JSON file; JSON null decodes to helper.NULL.
helper.NULL = dkjson.null
function helper.readJson(path)
    local text = Engine.readFile(path)
    assert(text ~= nil, "missing file " .. tostring(path))
    local value, _, err = dkjson.decode(text, 1, dkjson.null)
    assert(err == nil, "invalid JSON in " .. path .. ": " .. tostring(err))
    return value, text
end

function helper.decode(text)
    local value, _, err = dkjson.decode(text, 1, dkjson.null)
    assert(err == nil, tostring(err))
    return value
end

---A tractor with fuel, a seeder with seed, and a heading of due east.
function helper.tractor(overrides)
    local opts = {
        uniqueId = "vehicle7f3a",
        name = "Fendt 942 Vario",
        speedKmh = 14.26,
        rpm = 1450.4,
        gear = "D",
        damage = 0.031,
        operatingTimeMs = 412.7 * 3600000,
        x = 120.456,
        y = 88.1,
        z = -40.2,
        dirX = 1,
        dirZ = 0,
        fuel = { fillType = "DIESEL", level = 250, capacity = 400 },
        implements = {
            Engine.newVehicle({
                uniqueId = "vehicle91c0",
                name = "Amazone Cirrus 6003",
                fillUnits = { { fillType = "SEEDS", level = 2100, capacity = 3600 } },
            }),
        },
    }
    for key, value in pairs(overrides or {}) do
        opts[key] = value
    end
    return Engine.newVehicle(opts)
end

return helper
