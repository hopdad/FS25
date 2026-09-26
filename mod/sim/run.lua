-- Runs FarmLink against the engine stub and leaves its files on disk, for tests outside Lua:
--
--   lua5.1 sim/run.lua <profileDir> [seconds]
--
-- Simulates a single-player session: a tractor with a seeder, a hired worker that runs out of fuel,
-- a wage payment, a harvest tick and a career save. Prints a JSON summary with the saveId and the
-- folders it wrote.

package.path = (arg[0]:match("^(.*/)") or "./") .. "?.lua;" .. package.path

local Engine = require("engine")

local profileDir = arg[1]
if profileDir == nil then
    io.stderr:write("usage: lua5.1 sim/run.lua <profileDir> [seconds]\n")
    os.exit(2)
end
if profileDir:sub(-1) ~= "/" then
    profileDir = profileDir .. "/"
end
local seconds = tonumber(arg[2]) or 3

Engine.install({ profileDir = profileDir })
Engine.loadMod()
local combineType = Engine.finalizeCombineType()

Engine.loadMission({ savegameIndex = 3 })

local seeder = Engine.newVehicle({
    uniqueId = "vehicle91c0",
    name = "Amazone Cirrus 6003",
    fillUnits = { { fillType = "SEEDS", level = 2100, capacity = 3600 } },
})
local tractor = Engine.newVehicle({
    uniqueId = "vehicle7f3a",
    name = "Fendt 942 Vario",
    speedKmh = 14.2,
    rpm = 1450,
    gear = "D",
    damage = 0.031,
    operatingTimeMs = 412.7 * 3600000,
    x = 120.5,
    z = -40.2,
    dirX = 1,
    dirZ = 0,
    fuel = { fillType = "DIESEL", level = 250, capacity = 400 },
    implements = { seeder },
})
g_localPlayer.vehicle = tractor

Engine.run(seconds / 2)

local job = Engine.newJob(9, tractor, 1)
Engine.startJob(job)
g_currentMission:addMoney(-26.4, 1, MoneyType.AI, true)
combineType.overwritten.addCutterArea(tractor, Combine.addCutterArea, 5, 1200, 1, FillType.WHEAT, 1, 1, 1)
Engine.stopJob(job, Engine.AIMessages.ERROR_OUT_OF_FUEL.new())

Engine.run(seconds / 2)
Engine.saveCareer()

local ctx = FarmLink.ctx
local summary = FarmLink.Json.encode({
    saveId = ctx.ledger.saveId,
    baseDir = ctx.baseDir,
    saveDir = ctx.saveDir,
    savegameDirectory = g_currentMission.missionInfo.savegameDirectory,
})
Engine.unloadMission()
print(summary)
