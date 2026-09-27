local helper = require("helper")
local lfs = require("lfs")

describe("harvest and field work", function()
    local Engine
    local combineType

    before_each(function()
        Engine = helper.freshMod()
        combineType = Engine.finalizeCombineType()
    end)

    local function ofType(eventType)
        local dir = FarmLink.ctx.saveDir .. "events/"
        local out = {}
        for name in lfs.dir(dir) do
            if name:match("%.ndjson$") then
                for line in Engine.readFile(dir .. name):gmatch("[^\n]+") do
                    local event = helper.decode(line)
                    if eventType == nil or event.type == eventType then
                        out[#out + 1] = event
                    end
                end
            end
        end
        table.sort(out, function(a, b)
            return a.seq < b.seq
        end)
        return out
    end

    local function combine(opts)
        local vehicle = Engine.newVehicle({
            uniqueId = "combine1",
            name = "CLAAS LEXION 8900",
            x = 60,
            z = 12,
            operatingTimeMs = 400 * 3600000,
            fuel = { fillType = "DIESEL", level = 800, capacity = 1150 },
        })
        for key, value in pairs(opts or {}) do
            vehicle[key] = value
        end
        return Engine.addVehicle(vehicle)
    end

    it("gathers a combine's liters on a field into one harvest event once it stops threshing", function()
        Engine.loadMission({})
        local lexion = combine()
        for _ = 1, 3 do
            Engine.thresh(combineType, lexion, 1200, "WHEAT")
        end
        lexion.operatingTime = lexion.operatingTime + 0.5 * 3600000
        Engine.run(9, 100)
        assert.are.equal(0, #ofType("harvest"))
        Engine.run(2.2, 100)
        local harvests = ofType("harvest")
        assert.are.equal(1, #harvests)
        assert.are.equal(1, harvests[1].farmId)
        assert.are.same({
            fieldId = 12,
            farmlandId = 12,
            fillType = "WHEAT",
            liters = 3600,
            vehicleId = "combine1",
            isAI = false,
            workedHours = 0.5,
        }, harvests[1].data)
    end)

    it("starts a new harvest event when the combine moves to other land, and leaves contract fields out", function()
        Engine.loadMission({})
        local lexion = combine()
        Engine.thresh(combineType, lexion, 1000, "WHEAT")
        lexion.rootNode.x = -10
        Engine.thresh(combineType, lexion, 500, "WHEAT")
        lexion.rootNode.x = 60
        Engine.onContractLand = true
        Engine.thresh(combineType, lexion, 700, "WHEAT")
        Engine.run(11.2, 100)
        local places = {}
        for i, event in ipairs(ofType("harvest")) do
            places[i] = { event.data.fieldId, event.data.farmlandId, event.data.liters }
        end
        assert.are.same({
            { 12, 12, 1000 },
            { helper.NULL, helper.NULL, 500 },
            { helper.NULL, 12, 700 },
        }, places)
    end)

    it("writes a long stretch every 30 s, and what is gathered before the day rollover", function()
        Engine.loadMission({})
        local lexion = combine()
        for _ = 1, 32 do
            Engine.thresh(combineType, lexion, 100, "WHEAT")
            Engine.run(1, 100)
        end
        assert.are.equal(1, #ofType("harvest"))
        Engine.newDay()
        Engine.run(1.1)
        local log = ofType()
        local harvests = ofType("harvest")
        assert.are.equal(2, #harvests)
        assert.are.equal(3200, harvests[1].data.liters + harvests[2].data.liters)
        local rollover = nil
        for _, event in ipairs(log) do
            if event.type == "day_rollover" then
                rollover = event
            end
        end
        assert.is_true(harvests[2].seq < rollover.seq)
    end)

    it("credits sowing to the tractor pulling the seeder, with the seed it used", function()
        Engine.loadMission({})
        local tractor = Engine.addVehicle(helper.tractor())
        local seeder = tractor.implements[1]
        tractor.isAI = true
        Engine.workArea(seeder, SowingMachine, 5000, 0, 40)
        Engine.workArea(seeder, SowingMachine, 5000, 0, 40)
        tractor.operatingTime = tractor.operatingTime + 0.25 * 3600000
        Engine.run(11.2, 100)
        local work = ofType("field_work")
        assert.are.equal(1, #work)
        assert.are.equal(1, work[1].farmId)
        assert.are.same({
            fieldId = 12,
            farmlandId = 12,
            workType = "seeding",
            areaHa = 1,
            inputFillType = "SEEDS",
            inputLiters = 80,
            vehicleId = "vehicle7f3a",
            isAI = true,
            workedHours = 0.25,
        }, work[1].data)
    end)

    it("tells fertilizing from spraying, and records tillage without an input", function()
        Engine.loadMission({})
        local tractor = Engine.addVehicle(helper.tractor())
        local tool = tractor.implements[1]
        Engine.workArea(tool, Sprayer, 4000, 0, 30, "LIQUIDFERTILIZER")
        Engine.run(11.2, 100)
        Engine.workArea(tool, Sprayer, 2000, 0, 10, "HERBICIDE")
        Engine.run(11.2, 100)
        Engine.workArea(tool, Cultivator, 6000)
        Engine.workArea(tool, Plow, 3000)
        Engine.run(11.2, 100)
        local kinds = {}
        for i, event in ipairs(ofType("field_work")) do
            local data = event.data
            kinds[i] = { data.workType, data.areaHa, data.inputFillType, data.inputLiters }
        end
        assert.are.same({
            { "fertilizing", 0.4, "LIQUIDFERTILIZER", 30 },
            { "spraying", 0.2, "HERBICIDE", 10 },
            { "tillage", 0.9, helper.NULL, helper.NULL },
        }, kinds)
    end)

    it("writes what is gathered when the mission ends", function()
        Engine.loadMission({})
        local dir = FarmLink.ctx.saveDir .. "events/"
        local lexion = combine()
        Engine.thresh(combineType, lexion, 1000, "WHEAT")
        Engine.unloadMission()
        local found = false
        for name in lfs.dir(dir) do
            if name:match("%.ndjson$") and Engine.readFile(dir .. name):find('"type":"harvest"', 1, true) then
                found = true
            end
        end
        assert.is_true(found)
    end)
end)
