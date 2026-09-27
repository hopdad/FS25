-- Runs FarmLink's event log (P2) against the engine stub and leaves its files on disk, for the
-- bridge's end-to-end test:
--
--   lua5.1 sim/ledger.lua <profileDir> [--block-append]
--
-- One event of every type goes into the log, then the career is saved, two more events follow, and
-- the session ends without saving. Loading that savegame again forks a new branch, which gets one
-- event. --block-append refuses io.open's append mode, as the FS25 sandbox might (PLAN_REVIEW.md
-- F1). Prints a JSON summary.

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

local Json = FarmLink.Json
local EventLog = FarmLink.EventLog
local PLAYER = "4f1e2d3c"

local function wage(amount)
    return {
        amount = amount,
        moneyType = "AI",
        count = 12,
        context = { kind = "wage", jobId = "9", vehicleId = "vehicle7f3a" },
    }
end

EventLog.emit("vehicle_added", 1, {
    vehicleId = "vehicle7f3a",
    storeItem = "data/vehicles/fendt/vario900/vario900.xml",
    name = "Fendt 942 Vario",
    price = 412000,
    leased = false,
}, PLAYER)
EventLog.emit("money", 1, {
    amount = -412000,
    moneyType = "SHOP_VEHICLE_BUY",
    context = { kind = "shop", storeItem = "data/vehicles/fendt/vario900/vario900.xml", vehicleId = "vehicle7f3a" },
}, PLAYER)
EventLog.emit("worker_start", 1, { jobId = "9", vehicleId = "vehicle7f3a", jobType = "FIELDWORK", fieldId = 12 })
EventLog.emit("money", 1, {
    amount = -310.2,
    moneyType = "PURCHASE_SEEDS",
    context = { kind = "input", fillType = "SEEDS", liters = 450, fieldId = 12, vehicleId = "vehicle7f3a" },
})
EventLog.emit("field_work", 1, {
    fieldId = 12,
    farmlandId = 12,
    workType = "seeding",
    areaHa = 4.2,
    inputFillType = "SEEDS",
    inputLiters = 450,
    vehicleId = "vehicle7f3a",
    isAI = true,
    workedHours = 1.5,
})
EventLog.emit("money", 1, wage(-26.4))
EventLog.emit("worker_stop", 1, {
    jobId = "9",
    vehicleId = "vehicle7f3a",
    reason = "ERROR_OUT_OF_FUEL",
    durationMin = 94.5,
    wagesTotal = 26.4,
})
EventLog.emit("money", 1, {
    amount = -61.6,
    moneyType = "PURCHASE_FUEL",
    count = 31,
    context = { kind = "fuel", vehicleId = "vehicle7f3a", fillType = "DIESEL", liters = 44 },
}, PLAYER)
EventLog.emit("harvest", 1, {
    fieldId = 12,
    farmlandId = 12,
    fillType = "WHEAT",
    liters = 12000,
    vehicleId = "vehicle55aa",
    isAI = false,
    workedHours = 0.4,
}, PLAYER)
EventLog.emit("money", 1, {
    amount = 5040,
    moneyType = "SOLD_PRODUCTS",
    context = { kind = "sale", stationId = "placeable21", fillType = "WHEAT", liters = 12000 },
}, PLAYER)
EventLog.emit("money", 1, {
    amount = -1840,
    moneyType = "VEHICLE_REPAIR",
    context = { kind = "vehicle", vehicleId = "vehicle7f3a" },
}, PLAYER)
EventLog.emit("money", 0, { amount = -12, moneyType = "OTHER", context = { kind = "none" } })
EventLog.emit("vehicle_hours", 1, { vehicleId = "vehicle7f3a", operatingHours = 91, sellValue = 318000 })
EventLog.emit("vehicle_removed", 1, { vehicleId = "vehicle55aa", reason = "sold", operatingHours = 88.5 }, PLAYER)
EventLog.emit("prices", 0, {
    entries = {
        { stationId = "placeable21", fillType = "WHEAT", pricePer1000L = 420 },
        { stationId = "placeable21", fillType = "BARLEY", pricePer1000L = 385.5 },
    },
})
Engine.newDay()
EventLog.emit("day_rollover", 1, {
    balance = 1250000,
    loan = 0,
    financeByCategory = Json.object({ soldProducts = 5040, wagePayment = -26.4 }),
    period = 4,
    dayInPeriod = 2,
    daysPerPeriod = 3,
})
Engine.run(1.1)
Engine.saveCareer()

-- Played on after the save, then left without saving.
EventLog.emit("money", 1, wage(-13.2))
EventLog.emit("money", 1, wage(-6.6))
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
EventLog.emit("money", 1, wage(-9.9))
summary.branchId = FarmLink.ctx.ledger.branchId
summary.lastSeq = EventLog.status()
summary.mode = EventLog.stats().mode
Engine.unloadMission()

print(Json.encode(summary))
