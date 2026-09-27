-- Time: the game calendar, the wall clock, a precise timer for profiling, and real-time throttles.

FarmLink = FarmLink or {}

local Clock = {}
FarmLink.Clock = Clock

-- Written when the engine offers no usable wall clock at all. Still a valid timestamp, so live
-- frames keep flowing; the probe reports the missing clock.
Clock.FALLBACK_TIMESTAMP = "1970-01-01T00:00:00"

local Throttle = {}
Throttle.__index = Throttle

---A throttle that fires once per interval of real time, fed with the dt the engine passes to
---update(). elapsedMs sets the starting phase; pass intervalMs to fire on the first tick.
---@param intervalMs number
---@param elapsedMs number|nil
function Clock.newThrottle(intervalMs, elapsedMs)
    return setmetatable({ interval = intervalMs, elapsed = elapsedMs or 0 }, Throttle)
end

---Advances by dt ms and reports whether the interval has passed. After a long stall (loading,
---pause) it fires once and keeps its phase instead of firing repeatedly to catch up.
---@param dt number
---@return boolean
function Throttle:tick(dt)
    if type(dt) == "number" and dt > 0 then
        self.elapsed = self.elapsed + dt
    end
    if self.elapsed >= self.interval then
        self.elapsed = self.elapsed % self.interval
        return true
    end
    return false
end

---Makes the next tick fire.
function Throttle:trigger()
    self.elapsed = self.interval
end

local function environment()
    local mission = g_currentMission
    if mission == nil then
        return nil
    end
    return mission.environment
end

---environment.currentMonotonicDay: days per month can change mid-save, so this is the only day
---number that never jumps (PLAN_REVIEW.md C1).
---@return integer
function Clock.gameDay()
    local env = environment()
    if env == nil then
        return 0
    end
    local day = env.currentMonotonicDay
    if type(day) ~= "number" then
        day = env.currentDay
    end
    if type(day) ~= "number" then
        return 0
    end
    return math.max(0, math.floor(day))
end

local function wholeNumber(value, default, minimum)
    if type(value) ~= "number" or value ~= value then
        return default
    end
    return math.max(minimum, math.floor(value))
end

---The game calendar: environment.currentYear, the period (1 = March ... 12 = February), the day of
---that period and how many days each period has. Seasons are game years (PLAN_REVIEW.md C1).
---@return table { year, period, dayInPeriod, daysPerPeriod }
function Clock.calendar()
    local env = environment() or {}
    return {
        year = wholeNumber(env.currentYear, 0, 0),
        period = math.min(12, wholeNumber(env.currentPeriod, 1, 1)),
        dayInPeriod = wholeNumber(env.currentDayInPeriod, 1, 1),
        daysPerPeriod = wholeNumber(env.daysPerPeriod, 1, 1),
    }
end

---Minute of the in-game day, from environment.dayTime (ms since midnight).
---@return integer
function Clock.minuteOfDay()
    local env = environment()
    local ms = env ~= nil and env.dayTime or nil
    if type(ms) ~= "number" or ms < 0 then
        return 0
    end
    return math.floor(ms / 60000) % 1440
end

local LOCAL_TIME = "^%d%d%d%d%-%d%d%-%d%dT%d%d:%d%d:%d%d$"

local function dateFunction()
    if type(getDate) == "function" then
        return getDate
    end
    if type(os) == "table" and type(os.date) == "function" then
        return os.date
    end
    return nil
end

---The wall clock as RFC 3339. FS25 only exposes local time (getDate is strftime on the local clock),
---so the offset comes from %z and gets its colon ("-0400" -> "-04:00"). When %z yields no numeric
---offset, as some platforms print a zone name instead, the timestamp has no offset and the bridge,
---which runs on the same machine, applies its own (PLAN_REVIEW.md C2).
---@return string
function Clock.realTimestamp()
    local date = dateFunction()
    if date == nil then
        return Clock.FALLBACK_TIMESTAMP
    end
    local ok, base = pcall(date, "%Y-%m-%dT%H:%M:%S")
    if not ok or type(base) ~= "string" or base:match(LOCAL_TIME) == nil then
        return Clock.FALLBACK_TIMESTAMP
    end
    local zoneOk, zone = pcall(date, "%z")
    if zoneOk and type(zone) == "string" then
        local sign, hours, minutes = zone:match("^([+-])(%d%d):?(%d%d)$")
        if sign ~= nil then
            return base .. sign .. hours .. ":" .. minutes
        end
    end
    return base
end

-- Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's days_from_civil).
local function daysFromCivil(year, month, day)
    if month <= 2 then
        year = year - 1
    end
    local era = math.floor(year / 400)
    local yearOfEra = year - era * 400
    local shiftedMonth = (month + 9) % 12
    local dayOfYear = math.floor((153 * shiftedMonth + 2) / 5) + day - 1
    local dayOfEra = yearOfEra * 365 + math.floor(yearOfEra / 4) - math.floor(yearOfEra / 100) + dayOfYear
    return era * 146097 + dayOfEra - 719468
end

---Seconds since 1970 for an RFC 3339 timestamp, and whether it carried an offset. With
---ignoreOffset, or when the string has none, the wall-clock fields are read as they stand: the way
---two local times written on the same machine compare.
---@param timestamp string
---@param ignoreOffset boolean|nil
---@return number|nil seconds, boolean hasOffset
function Clock.toEpochSeconds(timestamp, ignoreOffset)
    if type(timestamp) ~= "string" then
        return nil, false
    end
    local y, mo, d, h, mi, s, rest = timestamp:match("^(%d%d%d%d)%-(%d%d)%-(%d%d)T(%d%d):(%d%d):(%d%d)(.*)$")
    if y == nil then
        return nil, false
    end
    local fraction, zone = rest:match("^(%.%d+)(.*)$")
    if fraction ~= nil then
        rest = zone
    end
    local offset = 0
    local hasOffset = false
    if rest == "Z" then
        hasOffset = true
    elseif rest ~= "" then
        local sign, offsetHours, offsetMinutes = rest:match("^([+-])(%d%d):(%d%d)$")
        if sign == nil then
            return nil, false
        end
        offset = (tonumber(offsetHours) * 3600 + tonumber(offsetMinutes) * 60) * (sign == "-" and -1 or 1)
        hasOffset = true
    end
    local seconds = daysFromCivil(tonumber(y), tonumber(mo), tonumber(d)) * 86400
        + tonumber(h) * 3600
        + tonumber(mi) * 60
        + tonumber(s)
    if hasOffset and not ignoreOffset then
        seconds = seconds - offset
    end
    return seconds, hasOffset
end

---How many seconds ago a timestamp written by the bridge was, by this game's clock. Both run on one
---machine, so when the game's clock has no offset the local wall-clock fields compare directly.
---@param timestamp string
---@return number|nil
function Clock.secondsSince(timestamp)
    local now = Clock.realTimestamp()
    local _, nowHasOffset = Clock.toEpochSeconds(now)
    local nowSeconds = Clock.toEpochSeconds(now, not nowHasOffset)
    local thenSeconds = Clock.toEpochSeconds(timestamp, not nowHasOffset)
    if nowSeconds == nil or thenSeconds == nil then
        return nil
    end
    return nowSeconds - thenSeconds
end

-- Candidate precise timers, first available wins. Looked up on every call because engine globals
-- are resolved at run time, not when this file is sourced. The P0 probe records each candidate's
-- raw value so the units can be confirmed in the game.
local function timers()
    return {
        { name = "getTimeSec", fn = getTimeSec, toMs = 1000 },
        { name = "netGetTime", fn = netGetTime, toMs = 1 },
        { name = "os.clock", fn = type(os) == "table" and os.clock or nil, toMs = 1000 },
    }
end

---Milliseconds from the most precise timer available, and the timer's name; nil when there is
---none. Only differences between two readings mean anything.
---@return number|nil, string|nil
function Clock.preciseMs()
    for _, timer in ipairs(timers()) do
        if type(timer.fn) == "function" then
            local ok, value = pcall(timer.fn)
            if ok and type(value) == "number" then
                return value * timer.toMs, timer.name
            end
        end
    end
    return nil, nil
end
