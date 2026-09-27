-- meta.json: who wrote these files and whether the game is still running. Written when the mission
-- starts and every 60 s. `beat` increments on every write, so the bridge can judge liveness without
-- comparing clocks (PLAN_REVIEW.md F1). Contract: packages/schema/src/meta.ts.

FarmLink = FarmLink or {}

local Meta = {
    name = "meta",
    authority = "server",
    FILE_NAME = "meta.json",
    INTERVAL_MS = 60000,
}
FarmLink.Meta = Meta

local state = nil

local function round(value, decimals)
    local mult = 10 ^ decimals
    return math.floor(value * mult + 0.5) / mult
end

---The meta.json document for the current mission.
---@param ctx table
---@return table
function Meta.build(ctx)
    local Json = FarmLink.Json
    local live = ctx.stats.live
    local lastSeq, heads = FarmLink.EventLog.status()
    local average = 0
    if live.timed > 0 then
        average = round(live.totalMs / live.timed, 4)
    end

    return {
        v = 1,
        modVersion = ctx.modVersion,
        gameVersion = ctx.gameVersion,
        saveId = ctx.ledger.saveId,
        branchId = ctx.ledger.branchId,
        schemaVersion = FarmLink.SCHEMA_VERSION,
        lastSeq = lastSeq or ctx.ledger.seq or 0,
        heads = Json.object(heads or {}),
        heartbeat = FarmLink.Clock.realTimestamp(),
        beat = state.beat,
        mode = ctx.mode,
        saveName = Json.orNull(ctx.saveName),
        savegameIndex = Json.orNull(ctx.savegameIndex),
        stats = {
            liveWrites = live.writes,
            liveWriteAvgMs = average,
            liveWriteMaxMs = round(live.maxMs, 4),
            moduleErrors = Json.object(ctx.registry:errorTotals()),
            disabledModules = Json.array(ctx.registry:disabledNames()),
            events = FarmLink.EventLog.stats(),
        },
    }
end

---@param ctx table
function Meta.write(ctx)
    state.beat = state.beat + 1
    local text = FarmLink.Json.encode(Meta.build(ctx))
    local ok, err = FarmLink.FileIO.writeText(ctx.saveDir .. Meta.FILE_NAME, text)
    if not ok then
        error("writing meta.json: " .. tostring(err), 0)
    end
end

function Meta.init(ctx)
    state = {
        beat = 0,
        throttle = FarmLink.Clock.newThrottle(Meta.INTERVAL_MS),
    }
    Meta.write(ctx)
end

function Meta.update(dt, ctx)
    if state.throttle:tick(dt) then
        Meta.write(ctx)
    end
end

---A save is a natural checkpoint: refresh the heartbeat and the write statistics.
function Meta.onSave(ctx, _missionInfo)
    Meta.write(ctx)
end

function Meta.shutdown(_ctx)
    state = nil
end
