local helper = require("helper")

describe("Registry", function()
    local registry
    local lines

    before_each(function()
        helper.freshMod()
        lines = {}
        local log = {
            error = function(fmt, ...)
                lines[#lines + 1] = string.format(fmt, ...)
            end,
        }
        registry = FarmLink.Registry.new(log)
    end)

    local function failing(name, authority)
        local module = { name = name, authority = authority, calls = 0 }
        function module.update()
            module.calls = module.calls + 1
            error("boom")
        end
        return module
    end

    local function counting(name, authority)
        local module = { name = name, authority = authority, calls = 0 }
        function module.update()
            module.calls = module.calls + 1
        end
        return module
    end

    it("keeps calling other modules when one fails", function()
        local bad, good = failing("bad"), counting("good")
        registry:add(bad)
        registry:add(good)
        registry:call("update", true, 16)
        assert.are.equal(1, good.calls)
        assert.are.equal(1, registry:errorTotals().bad)
    end)

    it("disables a module after three consecutive failures and says so once", function()
        local bad = failing("bad")
        registry:add(bad)
        for _ = 1, 5 do
            registry:call("update", true, 16)
        end
        assert.are.equal(3, bad.calls)
        assert.are.same({ "bad" }, registry:disabledNames())
        local disabledLines = 0
        for _, line in ipairs(lines) do
            if line:find("disabled", 1, true) then
                disabledLines = disabledLines + 1
            end
        end
        assert.are.equal(1, disabledLines)
    end)

    it("resets the streak after a success", function()
        local flaky = { name = "flaky", calls = 0 }
        function flaky.update()
            flaky.calls = flaky.calls + 1
            if flaky.calls % 3 ~= 0 then
                error("intermittent")
            end
        end
        registry:add(flaky)
        for _ = 1, 9 do
            registry:call("update", true, 16)
        end
        assert.are.equal(9, flaky.calls)
        assert.are.same({}, registry:disabledNames())
    end)

    it("stops logging a module's errors after MAX_LOGGED_ERRORS", function()
        local flaky = { name = "flaky", calls = 0 }
        function flaky.update()
            flaky.calls = flaky.calls + 1
            if flaky.calls % 2 == 1 then
                error("odd")
            end
        end
        registry:add(flaky)
        for _ = 1, 60 do
            registry:call("update", true, 16)
        end
        assert.are.equal(30, registry:errorTotals().flaky)
        assert.are.equal(FarmLink.Registry.MAX_LOGGED_ERRORS + 1, #lines)
    end)

    it("runs server modules only on the authority and 'any' modules everywhere", function()
        local server, anywhere = counting("server"), counting("anywhere", "any")
        registry:add(server)
        registry:add(anywhere)
        registry:call("update", false, 16)
        assert.are.equal(0, server.calls)
        assert.are.equal(1, anywhere.calls)
    end)

    it("ignores a second module with the same name", function()
        local first, second = counting("same"), counting("same")
        registry:add(first)
        registry:add(second)
        registry:call("update", true, 16)
        assert.are.equal(1, first.calls)
        assert.are.equal(0, second.calls)
    end)

    it("re-enables everything on reset", function()
        local bad = failing("bad")
        registry:add(bad)
        for _ = 1, 3 do
            registry:call("update", true, 16)
        end
        registry:reset()
        assert.are.same({}, registry:disabledNames())
        registry:call("update", true, 16)
        assert.are.equal(4, bad.calls)
    end)
end)
