-- Runs FarmLink's ledger (P2) against the engine stub and leaves its files on disk, for the
-- bridge's end-to-end test:
--
--   lua5.1 sim/ledger.lua <profileDir> [--block-append]
--
-- A day of play goes through the real producers:
-- - a hired worker with its wages, and the seed it buys;
-- - a sale, a refuel, a repair and a machine bought in the shop;
-- - two new days, each with a day rollover and the day's prices.
-- The event types that have no producer yet (machines, harvest, field work) are written directly.
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
Engine.loadMission({ savegameIndex = 1 })

local EventLog = FarmLink.EventLog
local PLAYER = "4f1e2d3c"

local tractor = Engine.addVehicle(Engine.newVehicle({
    uniqueId = "vehicle7f3a",
    name = "Fendt 942 Vario",
    x = 120.5,
    z = -40.2,
    operatingTimeMs = 90 * 3600000,
    fuel = { fillType = "DIESEL", level = 250, capacity = 400 },
}))

-- The producers, from the game's own calls.
local job = Engine.newJob(9, tractor, 1, { costScale = 1000, helper = "Sam" })
Engine.startJob(job)
Engine.run(0.3, 16)
Engine.workArea(tractor, SowingMachine, 5000, 12.5, 40)
Engine.workArea(tractor, SowingMachine, 5000, 12.5, 40)
Engine.stopJob(job, Engine.AIMessages.ERROR_OUT_OF_FUEL.new())
Engine.sell(1, "WHEAT", 12000)
Engine.refuel(tractor, 0.5)
Engine.repair(tractor, 1840)
Engine.buyVehicle(Engine.newVehicle({ uniqueId = "vehicle3c1d", name = "Kubota M7" }), 110000)
Engine.run(3.5)

-- The types without a producer yet.
EventLog.emit("vehicle_added", 1, {
    vehicleId = "vehicle3c1d",
    storeItem = "data/vehicles/kubota/m7/m7.xml",
    name = "Kubota M7",
    price = 110000,
    leased = false,
}, PLAYER)
EventLog.emit("field_work", 1, {
    fieldId = 12,
    farmlandId = 12,
    workType = "seeding",
    areaHa = 1,
    inputFillType = "SEEDS",
    inputLiters = 80,
    vehicleId = "vehicle7f3a",
    isAI = true,
    workedHours = 0.3,
})
EventLog.emit("harvest", 1, {
    fieldId = 12,
    farmlandId = 12,
    fillType = "WHEAT",
    liters = 12000,
    vehicleId = "vehicle55aa",
    isAI = false,
    workedHours = 0.4,
}, PLAYER)
EventLog.emit("vehicle_hours", 1, { vehicleId = "vehicle7f3a", operatingHours = 91, sellValue = 318000 })
EventLog.emit("vehicle_removed", 1, { vehicleId = "vehicle55aa", reason = "sold", operatingHours = 88.5 }, PLAYER)

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
