local helper = require("helper")

describe("Ids", function()
    local Ids

    before_each(function()
        helper.freshMod()
        Ids = FarmLink.Ids
    end)

    it("makes version 4 UUIDs with the RFC 9562 variant", function()
        for _ = 1, 50 do
            local id = Ids.uuid4()
            assert.is_truthy(id:match("^%x%x%x%x%x%x%x%x%-%x%x%x%x%-4%x%x%x%-[89ab]%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x$"), id)
            assert.is_true(Ids.isUuid(id))
        end
    end)

    it("does not repeat", function()
        local seen = {}
        for _ = 1, 1000 do
            local id = Ids.uuid4()
            assert.is_nil(seen[id])
            seen[id] = true
        end
    end)

    it("still works without the engine's getMD5", function()
        _G.getMD5 = nil
        assert.is_true(Ids.isUuid(Ids.uuid4()))
    end)

    it("rejects strings that are not UUIDs", function()
        assert.is_false(Ids.isUuid(nil))
        assert.is_false(Ids.isUuid("main"))
        assert.is_false(Ids.isUuid("6f1c2d3e-4a5b-4c6d-0e7f-0123456789ab")) -- variant 0
        assert.is_false(Ids.isUuid("6f1c2d3e4a5b4c6d8e7f0123456789ab"))
    end)
end)
