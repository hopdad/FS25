local helper = require("helper")

describe("the ledger probe", function()
    local Engine

    before_each(function()
        Engine = helper.freshMod()
    end)

    local function ledger()
        return helper.readJson(FarmLink.ctx.baseDir .. "_probe/probe.json").sections.ledger
    end

    it("reports into probe.json from mission start", function()
        Engine.loadMission({})
        local section = ledger()
        assert.is_table(section)
        assert.is_nil(section.error)
        assert.are.equal("subscribed", section.messages.subscribed.DAY_CHANGED)
        assert.are.equal("function", section.prices.atStart.getUnloadingStations)
        assert.are.equal(1, section.prices.atStart.sellingPoints)
        assert.are.same({
            stationId = "placeable21",
            station = "Grain Elevator",
            fillType = "WHEAT",
            pricePerLiter = 0.42,
        }, section.prices.atStart.samples[1].fillType == "WHEAT" and section.prices.atStart.samples[1]
            or section.prices.atStart.samples[2])
    end)

    it("records a sale with its station, liters and price, and passes the price back", function()
        Engine.loadMission({})
        local price = Engine.sell(1, "WHEAT", 12000)
        assert.are.equal(5040, price)
        Engine.run(10.1, 100)
        local sales = ledger().sales
        assert.is_true(sales.hooked)
        assert.are.equal(1, sales.calls)
        assert.are.same({ calls = 1, total = 12000 }, sales.byFillType.WHEAT)
        assert.are.same({
            farmId = 1,
            liters = 12000,
            fillType = "WHEAT",
            returned = 5040,
            stationId = "placeable21",
            station = "Grain Elevator",
        }, sales.samples[1])
        assert.are.same({ calls = 1, total = 5040 }, ledger().money.byType.SOLD_PRODUCTS)
    end)

    it("sees fuel booked once a frame while a vehicle fills up", function()
        Engine.loadMission({})
        local tractor = Engine.addVehicle(helper.tractor())
        Engine.refuel(tractor, 0.5)
        Engine.run(10.1, 100)
        local section = ledger()
        assert.are.equal(31, section.fuel.calls)
        assert.are.equal("DIESEL", section.fuel.samples[1].fillType)
        assert.are.equal("vehicle7f3a", section.fuel.samples[1].vehicleId)
        local fuelMoney = section.money.byType["id:101 other/finance_purchaseFuel"]
        assert.are.equal(31, fuelMoney.calls)
        assert.are.equal(31, section.farmStats.byStat.expenses.calls)
    end)

    it("counts what field-work tools report through updateFarmStats", function()
        Engine.loadMission({})
        g_farmManager:updateFarmStats(1, "sownHectares", 1.25)
        g_farmManager:updateFarmStats(1, "sownHectares", 0.5)
        g_farmManager:updateFarmStats(1, "sprayedHectares", 2)
        Engine.run(10.1, 100)
        local stats = ledger().farmStats.byStat
        assert.are.same({ calls = 2, total = 1.75 }, stats.sownHectares)
        assert.are.same({ calls = 1, total = 2 }, stats.sprayedHectares)
        assert.are.equal(1.75, g_farmManager.stats[1].sownHectares)
    end)

    it("catches an update gap as long as a pause, and the calendar at each new day", function()
        Engine.loadMission({})
        Engine.run(1)
        Engine.pause(20)
        Engine.newDay()
        g_messageCenter:publish(MessageType.VEHICLE_REMOVED)
        Engine.run(10.1, 100)
        local section = ledger()
        assert.are.equal(1, #section.updates.gaps)
        assert.is_true(section.updates.gaps[1].gapMs >= 20000)
        assert.are.equal(false, section.updates.gaps[1].pausedNow)
        assert.are.equal(1, section.messages.counts.DAY_CHANGED.count)
        assert.are.equal(38, section.messages.days[1].monotonicDay)
        assert.are.same({ count = 1, lastArgs = 0 }, section.messages.counts.VEHICLE_REMOVED)
        assert.are.equal(1, section.prices.latest.sellingPoints)
    end)

    it("writes a kept-open file handle again frames later", function()
        Engine.loadMission({})
        Engine.run(10.1, 100)
        local handle = ledger().handle
        assert.is_true(handle.opened)
        assert.are.equal("function", handle.flush)
        assert.are.equal("ok", handle.secondWrite)
        assert.are.equal("one\ntwo\n", Engine.readFile(FarmLink.ctx.baseDir .. "_probe/handle_test.txt"))
    end)

    it("keeps its final snapshot for the P0 probe's last write at mission end", function()
        Engine.loadMission({})
        local baseDir = FarmLink.ctx.baseDir
        Engine.run(1)
        Engine.unloadMission()
        local final = helper.readJson(baseDir .. "_probe/probe.json").sections.ledger
        assert.are.equal("ok", final.handle.secondWrite)
        assert.are.equal("one\ntwo\n", Engine.readFile(baseDir .. "_probe/handle_test.txt"))
    end)

    it("tallies wages, repairs and a hired worker's seed and fertilizer against their context", function()
        Engine.loadMission({})
        local tractor = Engine.addVehicle(helper.tractor())
        local job = Engine.newJob(nil, tractor, 1, { costScale = 1000 })
        Engine.startJob(job)
        Engine.run(0.1, 16)
        Engine.stopJob(job, Engine.AIMessages.SUCCESS_FINISHED_JOB.new())
        Engine.repair(tractor, 1840)
        tractor.isAI = true
        Engine.workArea(tractor, SowingMachine, 5000, 12.5)
        Engine.workArea(tractor, Sprayer, 4000, 8)
        tractor.isAI = false
        Engine.workArea(tractor, SowingMachine, 1000, 3)
        Engine.sell(1, "WHEAT", 1000)
        g_currentMission:addMoney(-5, 1, MoneyType.OTHER)
        Engine.run(10.1, 100)

        local context = ledger().context
        assert.are.same({
            ["AIJob.updateCost"] = "wrapped",
            ["AIJob.stop"] = "wrapped",
            ["WearableRepairEvent.run"] = "wrapped",
            ["SowingMachine.onEndWorkAreaProcessing"] = "wrapped",
            ["Sprayer.onStartWorkAreaProcessing"] = "wrapped",
            ["Sprayer.onEndWorkAreaProcessing"] = "wrapped",
        }, context.hooks)
        local byType = context.byMoneyType
        assert.are.same({ "wage" }, (function()
            local kinds = {}
            for kind in pairs(byType.AI) do
                kinds[#kinds + 1] = kind
            end
            return kinds
        end)())
        assert.are.equal(-38.4, byType.AI.wage.total)
        assert.are.same({ repair = { calls = 1, total = -1840 } }, byType.VEHICLE_REPAIR)
        assert.are.same({ sowing = { calls = 1, total = -12.5 } }, byType.PURCHASE_SEEDS)
        assert.are.same({ spraying = { calls = 1, total = -8 } }, byType.PURCHASE_FERTILIZER)
        assert.are.same({ sale = { calls = 1, total = 420 } }, byType.SOLD_PRODUCTS)
        assert.are.same({ none = { calls = 1, total = -5 } }, byType.OTHER)
        assert.are.same({ sowing = 0.6, spraying = 0.4 }, context.workedHa)
        assert.are.equal(2, context.calls.sowing)
    end)

    it("snapshots each farm's finances at a new day and a new month, in the order they arrive", function()
        Engine.loadMission({})
        g_currentMission:addMoney(-100, 1, MoneyType.OTHER)
        Engine.newDay()
        Engine.newDay()
        Engine.newDay()
        Engine.run(10.1, 100)
        local finances = ledger().finances
        assert.are.same({ "DAY_CHANGED", "DAY_CHANGED", "DAY_CHANGED", "PERIOD_CHANGED" }, finances.order)
        assert.are.equal("newVehiclesCost", finances.statNames[1])
        local last = finances.snapshots[#finances.snapshots]
        local beforeArchive = finances.snapshots[#finances.snapshots - 1]
        assert.are.same({
            message = "DAY_CHANGED",
            day = 40,
            period = 4,
            dayInPeriod = 1,
            farmId = 1,
            balance = 99900,
            loan = 0,
            current = -100,
            historyLength = 0,
            lastArchived = helper.NULL,
        }, beforeArchive)
        assert.are.same({
            message = "PERIOD_CHANGED",
            day = 40,
            period = 5,
            dayInPeriod = 1,
            farmId = 1,
            balance = 99900,
            loan = 0,
            current = 0,
            historyLength = 1,
            lastArchived = -100,
        }, last)
    end)

    it("records shop bookings next to the VEHICLE_ADDED that follows", function()
        Engine.loadMission({})
        Engine.run(0.1, 16)
        Engine.buyVehicle(helper.tractor({ uniqueId = "vehicleNew", implements = {} }), 150000)
        Engine.run(10.1, 100)
        local shop = ledger().shop
        assert.are.same({ { moneyType = "SHOP_VEHICLE_BUY", amount = -150000, frame = 6, vehicles = 0 } }, shop.bookings)
        assert.are.same({ { frame = 6, vehicles = 1 } }, shop.vehicleAdded)
    end)

    it("stops listening and restores updateFarmStats when the mission ends", function()
        Engine.loadMission({})
        local manager = g_farmManager
        local hooked = manager.updateFarmStats
        Engine.unloadMission()
        assert.are_not.equal(hooked, manager.updateFarmStats)
        assert.is_nil(rawget(g_messageCenter.subscribers or {}, FarmLink.LedgerProbe))
    end)
end)
