local helper = require("helper")

describe("P0 probe", function()
    local Engine
    local NULL = helper.NULL

    before_each(function()
        Engine = helper.freshMod()
    end)

    local function report()
        return helper.readJson(FarmLink.ctx.baseDir .. "_probe/probe.json")
    end

    it("writes every section at mission start", function()
        Engine.loadMission({})
        local sections = report().sections
        for _, name in ipairs({ "runtime", "files", "paths", "rename", "clock", "liveWrites", "money", "field", "ai", "save", "world" }) do
            assert.is_table(sections[name], name)
            assert.is_nil(sections[name].error, name)
        end
        assert.are.equal("Lua 5.1", sections.runtime.version)
        assert.are.equal(false, sections.runtime.gotoStatement)
        assert.are.equal("ok", sections.files.ioModes.w)
        assert.are.equal("first\nsecond\n", sections.files.append.readBack)
        assert.are.equal("g_modSettingsDirectory", sections.paths.resolvedFrom)
    end)

    it("confirms the doubled-slash delete rule the engine stub imitates", function()
        Engine.loadMission({})
        local delete = report().sections.files.delete
        assert.is_false(delete.plain.existsAfter)
        assert.is_true(delete.doubledSlash.existsAfter)
    end)

    it("counts money through addMoney and balance changes that bypass it", function()
        Engine.loadMission({})
        g_currentMission:addMoney(-120, 1, MoneyType.AI, true)
        g_currentMission.farms[1]:changeBalance(50, MoneyType.OTHER)
        Engine.run(10.1, 100)
        local money = report().sections.money
        assert.are.equal(1, money.addMoneyCalls)
        assert.are.equal(2, money.changeBalanceCalls)
        assert.are.equal(1, money.changeBalanceOutsideAddMoney)
        assert.are.equal("AI", money.samples[1].moneyType)
        assert.are.equal("OTHER", money.outsideSamples[1].moneyType)
        assert.are.equal(100000 - 120 + 50, g_currentMission.farms[1].money)
    end)

    it("passes addMoney errors and return values through unchanged", function()
        Engine.loadMission({})
        local farm = g_currentMission.farms[1]
        farm.changeBalance = function()
            error("farm is gone")
        end
        assert.has_error(function()
            g_currentMission:addMoney(-1, 1, MoneyType.OTHER)
        end, "farm is gone")
        farm.changeBalance = nil
        g_currentMission:addMoney(-1, 1, MoneyType.OTHER)
        assert.are.equal(100000 - 1, farm.money)
    end)

    it("puts addMoney back when the mission ends", function()
        Engine.loadMission({})
        local mission = g_currentMission
        assert.is_function(rawget(mission, "addMoney"))
        Engine.unloadMission()
        assert.is_nil(rawget(mission, "addMoney"))
        assert.are.equal(0, #g_messageCenter.subscribers)
    end)

    it("hooks Farm.changeBalance once per process, not once per mission", function()
        Engine.loadMission({})
        Engine.unloadMission()
        Engine.loadMission({})
        g_currentMission.farms[1]:changeBalance(10, MoneyType.OTHER)
        Engine.run(10.1, 100)
        assert.are.equal(1, report().sections.money.changeBalanceCalls)
    end)

    it("records AI starts and stops with the registered stop reason", function()
        Engine.loadMission({})
        local combine = helper.tractor({ uniqueId = "vehicle14" })
        local job = Engine.newJob(9, combine, 1)
        Engine.startJob(job)
        Engine.stopJob(job, Engine.AIMessages.ERROR_OUT_OF_FUEL.new())
        Engine.stopJob(job, nil)
        Engine.run(10.1, 100)
        local events = report().sections.ai.events
        assert.are.equal(3, #events)
        assert.are.equal("started", events[1].kind)
        assert.are.equal(9, events[1].jobId)
        assert.are.equal("FIELDWORK", events[1].jobType)
        assert.are.equal("vehicle14", events[1].vehicleId)
        assert.are.equal("ERROR_OUT_OF_FUEL", events[2].reason)
        assert.are.equal("<nil>", events[3].reason)
    end)

    it("registers over Combine.addCutterArea and totals liters by farmland and fill type", function()
        local vehicleType = Engine.finalizeCombineType()
        local overwrite = vehicleType.overwritten.addCutterArea
        assert.is_function(overwrite)

        Engine.loadMission({})
        local combine = helper.tractor({ uniqueId = "combine1", x = 10 })
        local superFunc = function(_self, _area, liters)
            return liters * 0.9
        end
        local added = overwrite(combine, superFunc, 5, 1000, 1, FillType.WHEAT, 1, 1, 1)
        assert.are.equal(900, added)
        overwrite(combine, superFunc, 5, 0, 1, FillType.WHEAT, 1, 1, 1)
        Engine.run(10.1, 100)

        local field = report().sections.field
        assert.is_true(field.harvestHookRegistered)
        assert.are.equal(1, field.harvestHookVehicleTypes)
        assert.are.equal(1, field.harvestCalls)
        assert.are.same({ ["12:WHEAT"] = 900 }, field.litersByFarmlandAndFillType)
    end)

    it("samples the farmland and field under the player's vehicle", function()
        Engine.loadMission({})
        g_localPlayer.vehicle = helper.tractor({ x = 25, z = 40 })
        Engine.run(10.1, 100)
        local here = report().sections.field.here
        assert.are.equal(12, here.farmlandId)
        assert.are.equal(12, here.fieldId)
        assert.are.equal("WHEAT", here.fruitName)
        assert.is_true(here.inVehicle)
    end)

    it("records each career save and whether farmLink.xml landed", function()
        Engine.loadMission({})
        Engine.saveCareer()
        local saves = report().sections.save.saves
        assert.are.equal(1, #saves)
        assert.is_true(saves[1].persisted)
        assert.is_true(saves[1].farmLinkXmlExists)
        assert.are.equal(NULL, saves[1].persistError)
    end)

    it("reports the live write cost for the frame-time criterion", function()
        Engine.loadMission({})
        g_localPlayer.vehicle = helper.tractor()
        Engine.run(10.1, 100)
        local live = report().sections.liveWrites
        assert.are.equal(11, live.writes)
        assert.are.equal(11, live.timedWrites)
        assert.is_number(live.avgMs)
        assert.are.equal("getTimeSec", live.timer)
    end)
end)
