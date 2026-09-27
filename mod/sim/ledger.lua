-- Runs FarmLink's ledger (P2) against the engine stub and leaves its files on disk, for the
-- bridge's end-to-end test:
--
--   lua5.1 sim/ledger.lua <profileDir> [--block-append]
--
-- A day of play goes through the real producers:
-- - the machines' first hours, when the session takes stock of the fleet;
-- - a hired worker sowing a field, with its wages and the seed it buys;
-- - a combine threshing wheat on that field;
-- - a grain sale, a refuel and a repair;
-- - a machine bought in the shop, and the combine sold;
-- - two new days, each with the hours of the machines that worked, a day rollover and the prices.
-- The career is then saved, a little more money moves, and the session ends without saving.
-- Loading that savegame again forks a new branch.
--
-- --block-append refuses io.open's append mode, as the FS25 sandbox might (PLAN_REVIEW.md F1).
-- Prints a JSON summary.

package.path = (arg[0]:match("^(.*/)") or "./") .. "?.lua;" .. package.path

local Engine = require("engine")

local profileDir = arg[1]
if profileDir == nil then
    io.stderr:write("usage: lua5.1 sim/ledger.lua <profileDir> [--block-append]\n")
    os.exit(2)
end
if profileDir:sub(-1) ~= "/" then
    profileDir = profileDir .. "/"
end

Engine.install({ profileDir = profileDir, blockAppend = arg[2] == "--block-append" })
Engine.loadMod()
local combineType = Engine.finalizeCombineType()
Engine.loadMission({ savegameIndex = 1 })

local EventLog = FarmLink.EventLog

local seeder = Engine.newVehicle({ uniqueId = "vehicle91c0", name = "Amazone Cirrus 6003", x = 120.5, z = -40.2 })
local tractor = Engine.addVehicle(Engine.newVehicle({
    uniqueId = "vehicle7f3a",
    name = "Fendt 942 Vario",
    x = 120.5,
    z = -40.2,
    operatingTimeMs = 90 * 3600000,
    fuel = { fillType = "DIESEL", level = 250, capacity = 400 },
    implements = { seeder },
}))
local combine = Engine.addVehicle(Engine.newVehicle({
    uniqueId = "vehicle55aa",
    name = "CLAAS LEXION 8900",
    x = 60,
    z = 12,
    operatingTimeMs = 400 * 3600000,
}))

-- The producers, from the game's own calls.
local job = Engine.newJob(9, tractor, 1, { costScale = 1000, helper = "Sam" })
Engine.startJob(job)
Engine.run(0.3, 16)
-- The seeder buys its seed as the tractor's hired worker sows (implements share the root's AI).
seeder.isAI = true
Engine.workArea(seeder, SowingMachine, 5000, 12.5, 40)
Engine.workArea(seeder, SowingMachine, 5000, 12.5, 40)
tractor.operatingTime = tractor.operatingTime + 0.3 * 3600000
Engine.stopJob(job, Engine.AIMessages.ERROR_OUT_OF_FUEL.new())
seeder.isAI = false
for _ = 1, 3 do
    Engine.thresh(combineType, combine, 4000, "WHEAT")
end
combine.operatingTime = combine.operatingTime + 0.4 * 3600000
Engine.sell(1, "WHEAT", 12000)
Engine.refuel(tractor, 0.5)
Engine.repair(tractor, 1840)
Engine.buyVehicle(Engine.newVehicle({
    uniqueId = "vehicle3c1d",
    name = "Kubota M7",
    configFileName = "data/vehicles/kubota/m7/m7.xml",
    operatingTimeMs = 0,
}), 110000)
Engine.run(11.2, 100)
Engine.sellVehicle(combine, 238000)
Engine.run(3.1, 100)

Engine.newDay()
g_currentMission:addMoney(-40, 1, MoneyType.OTHER)
Engine.newDay()
Engine.run(1.1)
Engine.saveCareer()

-- Played on after the save, then left without saving.
g_currentMission:addMoney(-13.2, 1, MoneyType.OTHER)
g_currentMission:addMoney(-6.6, 1, MoneyType.OTHER)
local ctx = FarmLink.ctx
local summary = {
    saveId = ctx.ledger.saveId,
    saveDir = ctx.saveDir,
    parentBranchId = ctx.ledger.branchId,
    savedSeq = FarmLink.Persistence.load(g_currentMission.missionInfo.savegameDirectory).seq,
}
local savegameDirectory = g_currentMission.missionInfo.savegameDirectory
Engine.unloadMission()

-- The older save again: a new branch.
Engine.loadMission({ savegameIndex = 1, savegameDirectory = savegameDirectory })
g_currentMission:addMoney(-9.9, 1, MoneyType.OTHER)
summary.branchId = FarmLink.ctx.ledger.branchId
summary.lastSeq = EventLog.status()
summary.mode = EventLog.stats().mode
Engine.unloadMission()

print(FarmLink.Json.encode(summary))
