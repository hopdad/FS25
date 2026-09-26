local helper = require("helper")

describe("FarmLink bootstrap", function()
    local Engine

    before_each(function()
        Engine = helper.freshMod()
    end)

    local function saveDir()
        return FarmLink.ctx.saveDir
    end

    it("writes meta.json at start and live_vehicle.json from the first update on, in single-player", function()
        Engine.loadMission({})
        local meta = helper.readJson(saveDir() .. "meta.json")
        assert.are.equal(1, meta.beat)
        assert.are.equal("singleplayer", meta.mode)
        assert.are.equal(FarmLink.ctx.ledger.saveId, meta.saveId)
        assert.are.same({}, meta.heads)
        assert.is_nil(Engine.readFile(saveDir() .. "live_vehicle.json"))

        g_localPlayer.vehicle = helper.tractor()
        Engine.run(1.2)
        local frame = helper.readJson(saveDir() .. "live_vehicle.json")
        assert.are.equal("Fendt 942 Vario", frame.vehicle.name)
        -- one frame on the first update, then one per second
        assert.are.equal(2, FarmLink.ctx.stats.live.writes)
    end)

    it("puts each save's files under modSettings/FS25_FarmLink/<saveId>/", function()
        Engine.loadMission({})
        local expected = Engine.profileDir .. "modSettings/FS25_FarmLink/" .. FarmLink.ctx.ledger.saveId .. "/"
        assert.are.equal(expected, saveDir())
    end)

    it("rewrites meta.json every 60 s", function()
        Engine.loadMission({})
        Engine.run(61, 100)
        assert.are.equal(2, helper.readJson(saveDir() .. "meta.json").beat)
    end)

    it("refreshes meta.json when the career is saved", function()
        Engine.loadMission({})
        Engine.saveCareer()
        assert.are.equal(2, helper.readJson(saveDir() .. "meta.json").beat)
    end)

    it("does nothing on a multiplayer client", function()
        Engine.loadMission({ isServer = false, isMultiplayer = true })
        assert.is_false(FarmLink.ctx.isAuthority)
        Engine.run(2)
        assert.is_nil(require("lfs").attributes(Engine.profileDir .. "modSettings/FS25_FarmLink"))
    end)

    it("reports host mode on a multiplayer server", function()
        Engine.loadMission({ isMultiplayer = true })
        assert.are.equal("host", helper.readJson(saveDir() .. "meta.json").mode)
    end)

    it("keeps the saveId across save and reload", function()
        Engine.loadMission({})
        local saveId = FarmLink.ctx.ledger.saveId
        assert.is_true(FarmLink.ctx.ledger.isNew)
        Engine.saveCareer()
        local directory = g_currentMission.missionInfo.savegameDirectory
        assert.is_not_nil(Engine.readFile(directory .. "/farmLink.xml"))
        Engine.unloadMission()

        Engine.loadMission({ savegameDirectory = directory })
        assert.are.equal(saveId, FarmLink.ctx.ledger.saveId)
        assert.is_false(FarmLink.ctx.ledger.isNew)
    end)

    it("starts every mission clean and installs its hooks only once", function()
        Engine.loadMission({ savegameDirectory = Engine.tempDir("a") })
        local first = FarmLink.ctx.ledger.saveId
        Engine.unloadMission()
        assert.is_nil(FarmLink.ctx)

        -- The game re-uses the Lua state for the next savegame, and FarmLink.lua is not sourced again.
        Engine.loadMission({ savegameDirectory = Engine.tempDir("b") })
        assert.are_not.equal(first, FarmLink.ctx.ledger.saveId)

        Engine.saveCareer()
        assert.are.equal(1, Engine.saveCalls)
    end)

    it("keeps writing when one module keeps failing, and disables that module", function()
        local broken = { name = "broken" }
        function broken.update()
            error("boom")
        end
        FarmLink.registry:add(broken)
        Engine.loadMission({})
        g_localPlayer.vehicle = helper.tractor()
        Engine.run(3.1)
        assert.are.same({ "broken" }, FarmLink.registry:disabledNames())
        assert.are.equal(4, FarmLink.ctx.stats.live.writes)
        Engine.run(60)
        local meta = helper.readJson(saveDir() .. "meta.json")
        assert.are.same({ "broken" }, meta.stats.disabledModules)
        assert.are.equal(3, meta.stats.moduleErrors.broken)
    end)

    it("ignores updates between missions", function()
        Engine.loadMission({})
        Engine.unloadMission()
        assert.has_no.errors(function()
            FarmLink:update(16)
        end)
    end)

    it("stays inactive when the settings folder cannot be found", function()
        _G.g_modSettingsDirectory = nil
        _G.getUserProfileAppPath = nil
        Engine.loadMission({})
        assert.is_nil(FarmLink.ctx)
        assert.is_truthy(table.concat(Engine.logLines, "\n"):find("inactive this session", 1, true))
    end)
end)
