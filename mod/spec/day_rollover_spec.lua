local helper = require("helper")
local lfs = require("lfs")

describe("the day rollover and daily prices", function()
    local Engine

    before_each(function()
        Engine = helper.freshMod()
    end)

    local function events()
        local dir = FarmLink.ctx.saveDir .. "events/"
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

    local function ofType(eventType)
        local out = {}
        for _, event in ipairs(events()) do
            if event.type == eventType then
                out[#out + 1] = event
            end
        end
        return out
    end

    local function finances(rollover)
        return rollover.data.financeByCategory
    end

    it("writes each player farm's balance, loan and new calendar, after the day's gathered money", function()
        Engine.loadMission({})
        local tractor = Engine.addVehicle(helper.tractor())
        Engine.refuel(tractor, 0.5)
        Engine.newDay()
        Engine.run(1.1)

        -- The machines' first hours come before the rollover too: the tractor's and its seeder's.
        local log = events()
        local types = {}
        for i, event in ipairs(log) do
            types[i] = event.type
        end
        assert.are.same({ "session", "prices", "money", "vehicle_hours", "vehicle_hours", "day_rollover", "prices" }, types)
        local rollover = log[6]
        assert.are.equal(1, rollover.farmId)
        assert.are.equal(38, rollover.day)
        assert.are.same({
            balance = 99930.56,
            loan = 0,
            financeByCategory = { other = -69.44 },
            period = 4,
            dayInPeriod = 2,
            daysPerPeriod = 3,
        }, rollover.data)
    end)

    it("counts a month archived since the last rollover, whichever message comes first", function()
        Engine.loadMission({})
        local mission = g_currentMission
        mission:addMoney(-100, 1, MoneyType.OTHER)
        Engine.newDay()
        mission:addMoney(-50, 1, MoneyType.OTHER)
        Engine.newDay()
        -- The month's last day ends: DAY_CHANGED, then PERIOD_CHANGED archives the month.
        mission:addMoney(-25, 1, MoneyType.OTHER)
        Engine.newDay()
        mission:addMoney(-10, 1, MoneyType.AI)
        Engine.newDay()
        -- The other order: the month archived first, then the new day.
        mission:addMoney(-5, 1, MoneyType.OTHER)
        g_messageCenter:publish(MessageType.PERIOD_CHANGED)
        g_messageCenter:publish(MessageType.DAY_CHANGED)
        Engine.run(1.1)

        local rollovers = ofType("day_rollover")
        assert.are.same({
            { other = -100 },
            { other = -50 },
            { other = -25 },
            { wagePayment = -10 },
            { other = -5 },
        }, {
            finances(rollovers[1]),
            finances(rollovers[2]),
            finances(rollovers[3]),
            finances(rollovers[4]),
            finances(rollovers[5]),
        })
    end)

    it("leaves money that the balance does not see out of the books, so every day reconciles", function()
        Engine.loadMission({})
        local tractor = Engine.addVehicle(helper.tractor())
        local mission = g_currentMission
        Engine.newDay()
        Engine.sell(1, "WHEAT", 1000)
        Engine.refuel(tractor, 0.3)
        mission:addMoney(-5, 0, MoneyType.OTHER)
        Engine.newDay()
        Engine.repair(tractor, 900)
        local job = Engine.newJob(nil, tractor, 1, { costScale = 1000 })
        Engine.startJob(job)
        Engine.run(0.2, 16)
        Engine.newDay()
        Engine.stopJob(job, Engine.AIMessages.SUCCESS_FINISHED_JOB.new())
        Engine.newDay()
        Engine.run(3.5)

        -- Between consecutive rollovers of farm 1, the money events add up to the balance change.
        local previous = nil
        local total = 0
        local days = 0
        for _, event in ipairs(events()) do
            if event.farmId == 1 and event.type == "money" then
                total = total + event.data.amount
            elseif event.farmId == 1 and event.type == "day_rollover" then
                if previous ~= nil then
                    assert.is_true(
                        math.abs(event.data.balance - previous - total) < 1e-6,
                        string.format("day %d: balance moved %.4f, money %.4f", event.day, event.data.balance - previous, total)
                    )
                    days = days + 1
                end
                previous = event.data.balance
                total = 0
            end
        end
        assert.are.equal(3, days)
    end)

    it("writes the selling points' prices per 1000 liters when the session starts and every day", function()
        Engine.loadMission({})
        Engine.newDay()
        Engine.run(1.1)
        local prices = ofType("prices")
        assert.are.equal(2, #prices)
        assert.are.equal(0, prices[1].farmId)
        assert.are.same({
            entries = {
                { stationId = "placeable21", fillType = "BARLEY", pricePer1000L = 380 },
                { stationId = "placeable21", fillType = "WHEAT", pricePer1000L = 420 },
            },
        }, prices[2].data)
        assert.are.equal(38, prices[2].day)
    end)

    it("stops listening when the mission ends", function()
        Engine.loadMission({})
        Engine.unloadMission()
        for _, entry in ipairs(g_messageCenter.subscribers) do
            assert.are.equal(g_farmManager, entry.target)
        end
    end)
end)
