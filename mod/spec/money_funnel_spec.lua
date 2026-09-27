local helper = require("helper")
local lfs = require("lfs")

describe("the money funnel", function()
    local Engine

    before_each(function()
        Engine = helper.freshMod()
    end)

    ---Every line in the save's event log, decoded, in seq order.
    local function events(dir)
        dir = dir or (FarmLink.ctx.saveDir .. "events/")
        local out = {}
        for name in lfs.dir(dir) do
            if name:match("%.ndjson$") then
                for line in Engine.readFile(dir .. name):gmatch("[^\n]+") do
                    out[#out + 1] = helper.decode(line)
                end
            end
        end
        table.sort(out, function(a, b)
            return a.seq < b.seq
        end)
        return out
    end

    local function ofType(eventType, dir)
        local out = {}
        for _, event in ipairs(events(dir)) do
            if event.type == eventType then
                out[#out + 1] = event
            end
        end
        return out
    end

    local function money(dir)
        return ofType("money", dir)
    end

    it("writes a sale as it happens, with its station, fill type and liters", function()
        Engine.loadMission({})
        Engine.sell(1, "WHEAT", 12000)
        Engine.run(1.1)
        local sale = money()[1]
        assert.are.equal(1, sale.farmId)
        assert.are.same({
            amount = 5040,
            moneyType = "SOLD_PRODUCTS",
            context = { kind = "sale", stationId = "placeable21", fillType = "WHEAT", liters = 12000 },
        }, sale.data)
    end)

    it("gathers a refuel into one event with the liters added, once the pumping stops", function()
        Engine.loadMission({})
        local tractor = Engine.addVehicle(helper.tractor())
        Engine.refuel(tractor, 0.5)
        Engine.run(1.1)
        assert.are.equal(0, #money())
        Engine.run(2.5)
        local fuel = money()
        assert.are.equal(1, #fuel)
        assert.are.same({
            amount = -69.44,
            moneyType = "id:101 other/finance_purchaseFuel",
            count = 31,
            context = { kind = "fuel", vehicleId = "vehicle7f3a", fillType = "DIESEL", liters = 49.6 },
        }, fuel[1].data)
    end)

    it("gathers a job's wages until it stops, and writes them just before its worker_stop", function()
        Engine.loadMission({})
        local tractor = Engine.addVehicle(helper.tractor())
        local job = Engine.newJob(nil, tractor, 1, { costScale = 1000, helper = "Kim" })
        Engine.startJob(job)
        Engine.run(0.1, 16)
        Engine.stopJob(job, Engine.AIMessages.SUCCESS_FINISHED_JOB.new())
        Engine.run(1.1)

        local log = events()
        local wage = log[#log - 1]
        local stop = log[#log]
        assert.are.same({
            amount = -38.4,
            moneyType = "AI",
            count = 2,
            context = { kind = "wage", jobId = "1", vehicleId = "vehicle7f3a" },
        }, wage.data)
        assert.are.equal("worker_stop", stop.type)
        assert.are.same({
            jobId = "1",
            vehicleId = "vehicle7f3a",
            reason = "SUCCESS_FINISHED_JOB",
            durationMin = 0,
            wagesTotal = 38.4,
        }, stop.data)
        local start = ofType("worker_start")[1]
        assert.are.same({ jobId = "1", vehicleId = "vehicle7f3a", jobType = "FIELDWORK", fieldId = 12 }, start.data)
    end)

    it("books a repair against the machine", function()
        Engine.loadMission({})
        local tractor = Engine.addVehicle(helper.tractor())
        Engine.repair(tractor, 1840)
        Engine.run(1.1)
        assert.are.same({
            amount = -1840,
            moneyType = "VEHICLE_REPAIR",
            context = { kind = "vehicle", vehicleId = "vehicle7f3a" },
        }, money()[1].data)
    end)

    it("books seed and fertilizer a hired worker buys as inputs for the field it works", function()
        Engine.loadMission({})
        local tractor = Engine.addVehicle(helper.tractor())
        tractor.isAI = true
        for _ = 1, 3 do
            Engine.workArea(tractor, SowingMachine, 5000, 12.5, 40)
        end
        Engine.workArea(tractor, Sprayer, 4000, 8, 30)
        -- The player's own sowing buys nothing.
        tractor.isAI = false
        Engine.workArea(tractor, SowingMachine, 5000, 12.5, 40)
        Engine.run(3.5)

        local inputs = money()
        assert.are.equal(2, #inputs)
        assert.are.same({
            amount = -37.5,
            moneyType = "PURCHASE_SEEDS",
            count = 3,
            context = { kind = "input", fillType = "SEEDS", liters = 120, fieldId = 12, vehicleId = "vehicle7f3a" },
        }, inputs[1].data)
        assert.are.same({
            amount = -8,
            moneyType = "PURCHASE_FERTILIZER",
            context = {
                kind = "input",
                fillType = "LIQUIDFERTILIZER",
                liters = 30,
                fieldId = 12,
                vehicleId = "vehicle7f3a",
            },
        }, inputs[2].data)
    end)

    it("leaves farm 0 and zero amounts out, and books the rest as it happens with no context", function()
        Engine.loadMission({})
        g_currentMission:addMoney(-5, 0, MoneyType.OTHER)
        g_currentMission:addMoney(0, 1, MoneyType.OTHER)
        g_currentMission:addMoney(-7.25, 1, MoneyType.OTHER)
        Engine.run(1.1)
        local booked = money()
        assert.are.equal(1, #booked)
        assert.are.same({ amount = -7.25, moneyType = "OTHER", context = { kind = "none" } }, booked[1].data)
    end)

    it("writes what it gathered before the savegame records its seq", function()
        local directory = Engine.tempDir("savegame1")
        Engine.loadMission({ savegameDirectory = directory })
        local tractor = Engine.addVehicle(helper.tractor())
        Engine.refuel(tractor, 0.5)
        Engine.saveCareer()
        local fuel = money()
        assert.are.equal(1, #fuel)
        assert.are.equal(fuel[1].seq, FarmLink.Persistence.load(directory).seq)
    end)

    it("writes what it gathered when the mission ends", function()
        Engine.loadMission({})
        local dir = FarmLink.ctx.saveDir .. "events/"
        local tractor = Engine.addVehicle(helper.tractor())
        Engine.refuel(tractor, 0.5)
        Engine.unloadMission()
        assert.are.equal(1, #money(dir))
        assert.is_nil(rawget(g_currentMission or {}, "addMoney"))
    end)

    it("catches balance changes that bypass addMoney when it hooks Farm.changeBalance (F4)", function()
        FarmLink.MoneyFunnel.HOOK = "changeBalance"
        FarmLink.MoneyFunnel.processHooksInstalled = false
        FarmLink.MoneyFunnel.installProcessHooks()
        Engine.loadMission({})
        g_currentMission:addMoney(-7, 1, MoneyType.OTHER)
        g_farmManager:getFarmById(1):changeBalance(-3, MoneyType.OTHER)
        Engine.run(1.1)
        local amounts = {}
        for i, event in ipairs(money()) do
            amounts[i] = event.data.amount
        end
        assert.are.same({ -7, -3 }, amounts)
        assert.are.equal("changeBalance", FarmLink.MoneyFunnel.stats().hook)
    end)
end)
