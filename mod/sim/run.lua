-- Runs FarmLink against the engine stub and leaves its files on disk, for tests outside Lua:
--
--   lua5.1 sim/run.lua <profileDir> [seconds]
--   lua5.1 sim/run.lua <profileDir> [seconds] --resume <savegameDirectory>
--
-- The first form simulates a fresh single-player session: a tractor with a seeder, a worker that runs
-- out of fuel, a combine worker still harvesting, a wage payment, a harvest tick, a grain sale, a
-- refuel, a pause, a new day and a career save.
-- --resume loads that savegame again (same saveId), hires a worker that gets job id 1 and runs, so a
-- test can drop a commands.xml into the save folder beforehand. Both print a JSON summary.

package.path = (arg[0]:match("^(.*/)") or "./") .. "?.lua;" .. package.path

local Engine = require("engine")

local profileDir = arg[1]
if profileDir == nil then
    io.stderr:write("usage: lua5.1 sim/run.lua <profileDir> [seconds] [--resume <savegameDirectory>]\n")
    os.exit(2)
end
if profileDir:sub(-1) ~= "/" then
    profileDir = profileDir .. "/"
end
local seconds = tonumber(arg[2]) or 3
local resumeDirectory = nil
if arg[3] == "--resume" then
    resumeDirectory = arg[4]
end

Engine.install({ profileDir = profileDir })
Engine.loadMod()
local combineType = Engine.finalizeCombineType()

Engine.loadMission({ savegameIndex = 3, savegameDirectory = resumeDirectory })

local seeder = Engine.newVehicle({
    uniqueId = "vehicle91c0",
    name = "Amazone Cirrus 6003",
    fillUnits = { { fillType = "SEEDS", level = 2100, capacity = 3600 } },
})
local tractor = Engine.addVehicle(Engine.newVehicle({
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
    entered = true,
}))
local combine = Engine.addVehicle(Engine.newVehicle({
    uniqueId = "vehicle55aa",
    name = "Claas Lexion 8900",
    x = 60,
    z = 12,
    fuel = { fillType = "DIESEL", level = 30, capacity = 1150 },
    fillUnits = { { fillType = "WHEAT", level = 7200, capacity = 12000 } },
}))
g_localPlayer.vehicle = tractor

if resumeDirectory == nil then
    Engine.run(seconds / 2)

    local job = Engine.newJob(9, tractor, 1, { helper = "Sam" })
    Engine.startJob(job)
    g_currentMission:addMoney(-26.4, 1, MoneyType.AI, true)
    combineType.overwritten.addCutterArea(tractor, Combine.addCutterArea, 5, 1200, 1, FillType.WHEAT, 1, 1, 1)
    Engine.stopJob(job, Engine.AIMessages.ERROR_OUT_OF_FUEL.new())
    Engine.startJob(Engine.newJob(nil, combine, 1, { helper = "Alex" }))

    -- What the ledger (P2) will book, for the probe's ledger section: a sale, a refuel, a sowing stat,
    -- a pause, a new day and a sold vehicle.
    Engine.sell(1, "WHEAT", 12000)
    Engine.refuel(tractor, 0.5)
    g_farmManager:updateFarmStats(1, "sownHectares", 1.25)
    Engine.pause(20)
    Engine.newDay()
    g_messageCenter:publish(MessageType.VEHICLE_REMOVED)

    Engine.run(seconds / 2)
else
    Engine.startJob(Engine.newJob(1, combine, 1, { helper = "Alex" }))
    Engine.run(seconds)
end
Engine.saveCareer()

local ctx = FarmLink.ctx
local summary = FarmLink.Json.encode({
    saveId = ctx.ledger.saveId,
    baseDir = ctx.baseDir,
    saveDir = ctx.saveDir,
    savegameDirectory = g_currentMission.missionInfo.savegameDirectory,
    activeJobs = #g_currentMission.aiSystem:getActiveJobs(),
    commandWatermark = ctx.commands ~= nil and ctx.commands.watermark or 0,
})
Engine.unloadMission()
print(summary)
