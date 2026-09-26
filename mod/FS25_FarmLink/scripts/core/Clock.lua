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
