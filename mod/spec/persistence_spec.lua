local helper = require("helper")

describe("Persistence", function()
    local Persistence
    local Engine
    local saveDir

    before_each(function()
        Engine = helper.freshMod()
        Persistence = FarmLink.Persistence
        saveDir = Engine.tempDir("savegame1")
    end)

    it("creates a new identity for a career that was never saved", function()
        local ledger = Persistence.load(nil)
        assert.is_true(ledger.isNew)
        assert.is_true(FarmLink.Ids.isUuid(ledger.saveId))
        assert.is_true(FarmLink.Ids.isUuid(ledger.branchId))
        assert.are_not.equal(ledger.saveId, ledger.branchId)
    end)

    it("reads back what it saved", function()
        local ledger = Persistence.load(saveDir)
        assert.is_true(ledger.isNew)
        assert.is_true(Persistence.save(saveDir, ledger))
        assert.is_false(ledger.isNew)

        local again = Persistence.load(saveDir)
        assert.is_false(again.isNew)
        assert.are.equal(ledger.saveId, again.saveId)
        assert.are.equal(ledger.branchId, again.branchId)
        assert.are.equal(saveDir .. "farmLink.xml", again.loadedFrom)
    end)

    it("starts a new ledger when the file holds no valid ids", function()
        local xml = XMLFile.create("x", saveDir .. "farmLink.xml", "farmLink")
        xml:setString("farmLink.save#id", "not-a-uuid")
        xml:save()
        local ledger = Persistence.load(saveDir)
        assert.is_true(ledger.isNew)
        assert.is_true(FarmLink.Ids.isUuid(ledger.saveId))
        assert.is_truthy(table.concat(Engine.logLines, "\n"):find("no valid ids", 1, true))
    end)

    it("refuses to save without a savegame folder", function()
        local ok, err = Persistence.save(nil, Persistence.load(nil))
        assert.is_false(ok)
        assert.are.equal("no savegame directory", err)
    end)
end)
