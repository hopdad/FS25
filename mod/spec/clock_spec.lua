local helper = require("helper")

describe("Clock", function()
    local Clock
    local Engine

    before_each(function()
        Engine = helper.freshMod()
        Clock = FarmLink.Clock
    end)

    describe("throttle", function()
        it("fires once per interval and keeps its phase", function()
            local throttle = Clock.newThrottle(1000)
            assert.is_false(throttle:tick(400))
            assert.is_false(throttle:tick(400))
            assert.is_true(throttle:tick(400)) -- 1200: fires, 200 carried over
            assert.is_false(throttle:tick(700))
            assert.is_true(throttle:tick(100))
        end)

        it("fires once after a long stall instead of catching up", function()
            local throttle = Clock.newThrottle(1000)
            assert.is_true(throttle:tick(10500))
            assert.is_false(throttle:tick(16))
        end)

        it("fires on the first tick when started at a full interval", function()
            assert.is_true(Clock.newThrottle(1000, 1000):tick(16))
        end)

        it("ignores a missing or negative dt", function()
            local throttle = Clock.newThrottle(1000, 999)
            assert.is_false(throttle:tick(nil))
            assert.is_false(throttle:tick(-50))
            assert.is_true(throttle:tick(1))
        end)
    end)

    describe("game calendar", function()
        it("reads the monotonic day and the minute of the day", function()
            Engine.loadMission({ day = 37, dayTimeMs = 14 * 3600000 + 5 * 60000 + 59000 })
            assert.are.equal(37, Clock.gameDay())
            assert.are.equal(845, Clock.minuteOfDay())
        end)

        it("falls back to currentDay, then to 0", function()
            Engine.loadMission({})
            g_currentMission.environment.currentMonotonicDay = nil
            g_currentMission.environment.currentDay = 12
            assert.are.equal(12, Clock.gameDay())
            _G.g_currentMission = nil
            assert.are.equal(0, Clock.gameDay())
            assert.are.equal(0, Clock.minuteOfDay())
        end)
    end)

    describe("realTimestamp", function()
        local function fakeDate(base, zone)
            _G.getDate = function(format)
                if format == "%z" then
                    return zone
                end
                return base
            end
        end

        it("adds the colon to a numeric offset", function()
            fakeDate("2026-09-26T11:04:05", "-0400")
            assert.are.equal("2026-09-26T11:04:05-04:00", Clock.realTimestamp())
            fakeDate("2026-09-26T20:34:05", "+0530")
            assert.are.equal("2026-09-26T20:34:05+05:30", Clock.realTimestamp())
        end)

        it("leaves the offset off when %z gives a zone name", function()
            fakeDate("2026-09-26T11:04:05", "Eastern Daylight Time")
            assert.are.equal("2026-09-26T11:04:05", Clock.realTimestamp())
        end)

        it("falls back to a fixed valid timestamp when the clock fails", function()
            _G.getDate = function()
                error("no clock")
            end
            assert.are.equal(Clock.FALLBACK_TIMESTAMP, Clock.realTimestamp())
            fakeDate("26.09.2026 11:04", "-0400")
            assert.are.equal(Clock.FALLBACK_TIMESTAMP, Clock.realTimestamp())
        end)

        it("produces RFC 3339 from the real clock", function()
            local ts = Clock.realTimestamp()
            assert.is_truthy(ts:match("^%d%d%d%d%-%d%d%-%d%dT%d%d:%d%d:%d%d[+-]%d%d:%d%d$"))
        end)
    end)

    describe("epoch seconds", function()
        it("converts RFC 3339 with or without an offset", function()
            assert.are.equal(0, Clock.toEpochSeconds("1970-01-01T00:00:00Z"))
            assert.are.equal(
                Clock.toEpochSeconds("2026-09-26T15:04:05Z"),
                Clock.toEpochSeconds("2026-09-26T11:04:05-04:00")
            )
            assert.are.equal(Clock.toEpochSeconds("2026-09-26T15:04:05Z"), Clock.toEpochSeconds("2026-09-26T15:04:05.123Z"))
            local seconds, hasOffset = Clock.toEpochSeconds("2026-09-26T11:04:05")
            assert.is_number(seconds)
            assert.is_false(hasOffset)
        end)

        it("reads only the wall clock when asked to ignore the offset", function()
            assert.are.equal(
                Clock.toEpochSeconds("2026-09-26T11:04:05"),
                Clock.toEpochSeconds("2026-09-26T11:04:05-04:00", true)
            )
        end)

        it("follows the Gregorian leap-year rules", function()
            local day = 86400
            assert.are.equal(day, Clock.toEpochSeconds("2024-03-01T00:00:00Z") - Clock.toEpochSeconds("2024-02-29T00:00:00Z"))
            assert.are.equal(day, Clock.toEpochSeconds("2100-03-01T00:00:00Z") - Clock.toEpochSeconds("2100-02-28T00:00:00Z"))
            assert.are.equal(2 * day, Clock.toEpochSeconds("2000-03-01T00:00:00Z") - Clock.toEpochSeconds("2000-02-28T00:00:00Z"))
        end)

        it("rejects anything that is not a timestamp", function()
            assert.is_nil(Clock.toEpochSeconds("yesterday"))
            assert.is_nil(Clock.toEpochSeconds("2026-09-26T11:04:05+0400"))
            assert.is_nil(Clock.toEpochSeconds(nil))
        end)

        it("measures a bridge timestamp's age against the game clock, offset or not", function()
            _G.getDate = function(format)
                if format == "%z" then
                    return "-0400"
                end
                return "2026-09-26T11:05:00"
            end
            assert.are.equal(55, Clock.secondsSince("2026-09-26T11:04:05-04:00"))
            assert.are.equal(55, Clock.secondsSince("2026-09-26T15:04:05Z"))
            _G.getDate = function(format)
                if format == "%z" then
                    return "Eastern Daylight Time"
                end
                return "2026-09-26T11:05:00"
            end
            assert.are.equal(55, Clock.secondsSince("2026-09-26T11:04:05-04:00"))
        end)
    end)

    it("reports a precise timer and its name", function()
        local ms, name = Clock.preciseMs()
        assert.is_number(ms)
        assert.are.equal("getTimeSec", name)
        _G.getTimeSec = nil
        _G.netGetTime = function()
            return 5
        end
        ms, name = Clock.preciseMs()
        assert.are.equal(5, ms)
        assert.are.equal("netGetTime", name)
    end)
end)
