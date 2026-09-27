-- The day rollover (docs/LEDGER.md): when a new day starts, every module writes what it has gathered
-- (beforeRollover), then each player farm gets a day_rollover event with its balance, its loan, the
-- new day's calendar, and the finance statistics of the day that ended. Reconciliation runs between
-- consecutive rollovers of a farm (PLAN_REVIEW.md C3), so nothing gathered may stay behind.
--
-- The finance statistics are FarmStats', which keeps one bucket per month and archives it onto
-- financesHistory on PERIOD_CHANGED. A day's figures are the difference from the snapshot taken at
-- the previous rollover; if a month was archived since, they are the rest of that month plus the new
-- month so far. That holds whichever of DAY_CHANGED and PERIOD_CHANGED arrives first, which the P2
-- probe's `finances` section records in the game.

FarmLink = FarmLink or {}

local DayRollover = {
    name = "dayRollover",
    authority = "server",
}
FarmLink.DayRollover = DayRollover

local state = nil

local function statNames(bucket)
    local names = FinanceStats ~= nil and FinanceStats.statNames or nil
    if type(names) == "table" and #names > 0 then
        return names
    end
    local out = {}
    for name, value in pairs(bucket or {}) do
        if type(name) == "string" and type(value) == "number" then
            out[#out + 1] = name
        end
    end
    table.sort(out)
    return out
end

local function copyBucket(bucket)
    local out = {}
    for name, value in pairs(type(bucket) == "table" and bucket or {}) do
        if type(value) == "number" then
            out[name] = value
        end
    end
    return out
end

local function snapshot(farm)
    local stats = type(farm.stats) == "table" and farm.stats or {}
    local history = type(stats.financesHistory) == "table" and stats.financesHistory or {}
    return { finances = copyBucket(stats.finances), historyLength = #history }
end

---The finance statistics since the farm's last snapshot, by statistic name, without zeros.
function DayRollover.financesSince(farm, last)
    local Game = FarmLink.Game
    local stats = type(farm.stats) == "table" and farm.stats or {}
    local current = type(stats.finances) == "table" and stats.finances or {}
    local history = type(stats.financesHistory) == "table" and stats.financesHistory or {}
    last = last or { finances = {}, historyLength = #history }
    local archived = nil
    if #history > last.historyLength then
        archived = history[#history]
    end
    local out = {}
    for _, name in ipairs(statNames(current)) do
        local value
        if archived ~= nil then
            value = (Game.num(archived[name]) or 0) - (last.finances[name] or 0) + (Game.num(current[name]) or 0)
        else
            value = (Game.num(current[name]) or 0) - (last.finances[name] or 0)
        end
        if math.abs(value) >= 0.005 then
            out[name] = Game.round(value, 2)
        end
    end
    return out
end

local function playerFarms()
    local manager = g_farmManager
    local farms = type(manager) == "table" and manager.farms or nil
    local out = {}
    for _, farm in ipairs(type(farms) == "table" and farms or {}) do
        if FarmLink.FarmCollector.isPlayerFarm(farm) then
            out[#out + 1] = farm
        end
    end
    return out
end

---A new day started: flush every module, then write each farm's rollover.
function DayRollover.onDayChanged(ctx)
    FarmLink.registry:call("beforeRollover", true, ctx)
    local Game = FarmLink.Game
    local calendar = FarmLink.Clock.calendar()
    for _, farm in ipairs(playerFarms()) do
        local balance = Game.num(Game.call(farm, "getBalance")) or Game.num(farm.money) or 0
        FarmLink.EventLog.emit("day_rollover", farm.farmId, {
            balance = Game.round(balance, 6),
            loan = math.max(0, Game.num(farm.loan) or 0),
            financeByCategory = FarmLink.Json.object(DayRollover.financesSince(farm, state.snapshots[farm.farmId])),
            period = calendar.period,
            dayInPeriod = calendar.dayInPeriod,
            daysPerPeriod = calendar.daysPerPeriod,
        })
        state.snapshots[farm.farmId] = snapshot(farm)
    end
end

function DayRollover.init(ctx)
    state = { snapshots = {} }
    for _, farm in ipairs(playerFarms()) do
        state.snapshots[farm.farmId] = snapshot(farm)
    end
    if type(g_messageCenter) == "table" and type(MessageType) == "table" and MessageType.DAY_CHANGED ~= nil then
        g_messageCenter:subscribe(MessageType.DAY_CHANGED, function()
            local ok, err = pcall(DayRollover.onDayChanged, ctx)
            if not ok then
                FarmLink.Log.error("day rollover failed: %s", tostring(err))
            end
        end, DayRollover)
    end
end

function DayRollover.shutdown(_ctx)
    if type(g_messageCenter) == "table" and type(g_messageCenter.unsubscribeAll) == "function" then
        pcall(g_messageCenter.unsubscribeAll, g_messageCenter, DayRollover)
    end
    state = nil
end
