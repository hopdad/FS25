-- Hired workers: which AI jobs are running and why each one stopped. Listens to the AI system's own
-- messages (VERIFY_FIRST.md, 6):
--   MessageType.AI_JOB_STARTED (job, startFarmId)   from AISystem:startJobInternal
--   MessageType.AI_JOB_STOPPED (job, aiMessage)     from AISystem:stopJobInternal
-- Both fire on the server and on clients; this module only runs on the server.
--
-- The registry lives in ctx.workers for the mission. Job ids restart every session, so a job is only
-- identified within one. Stops go into a short ring that the fleet channel carries to the bridge,
-- which turns them into alerts (P1). Each start and stop is also a ledger event (P2): worker_stop
-- carries the job's wages, which the money funnel has booked by then, because AISystem stops the job
-- (AIJob.stop pays what is left) before it publishes AI_JOB_STOPPED.

FarmLink = FarmLink or {}

local AIWorkers = {
    name = "workers",
    authority = "server",
    MAX_STOPS = 20,
}
FarmLink.AIWorkers = AIWorkers

local function gameMinutes()
    local Clock = FarmLink.Clock
    return Clock.gameDay() * 1440 + Clock.minuteOfDay()
end

local function describeJob(job, farmId)
    local Game = FarmLink.Game
    local vehicle = Game.jobVehicle(job)
    local helper = Game.call(job, "getHelperName")
    return {
        jobId = tostring(job.jobId),
        vehicleId = Game.vehicleId(vehicle),
        vehicle = vehicle,
        farmId = type(farmId) == "number" and farmId or (type(job.startedFarmId) == "number" and job.startedFarmId or 0),
        jobType = Game.jobTypeName(job),
        helper = type(helper) == "string" and helper or nil,
        fieldId = Game.jobField(job),
        startedAt = FarmLink.Clock.realTimestamp(),
        startedAtGameMinutes = gameMinutes(),
    }
end

---Records a job as running. Safe to call twice for the same job.
function AIWorkers.onJobStarted(ctx, job, startFarmId)
    if type(job) ~= "table" or job.jobId == nil then
        return
    end
    local workers = ctx.workers
    local key = tostring(job.jobId)
    if workers.active[key] == nil then
        local entry = describeJob(job, startFarmId)
        workers.active[key] = entry
        workers.order[#workers.order + 1] = key
        FarmLink.MoneyFunnel.resetJob(key)
        if entry.vehicleId ~= nil then
            FarmLink.EventLog.emit("worker_start", entry.farmId, {
                jobId = entry.jobId,
                vehicleId = entry.vehicleId,
                jobType = entry.jobType or "UNKNOWN",
                fieldId = FarmLink.Json.orNull(entry.fieldId),
            })
        end
    end
    ctx.fleetDirty = true
end

---Moves a job from running to the stop ring, with its registered stop reason.
function AIWorkers.onJobStopped(ctx, job, aiMessage)
    if type(job) ~= "table" or job.jobId == nil then
        return
    end
    local Clock = FarmLink.Clock
    local workers = ctx.workers
    local key = tostring(job.jobId)
    local entry = workers.active[key] or describeJob(job, nil)
    workers.active[key] = nil
    for i = #workers.order, 1, -1 do
        if workers.order[i] == key then
            table.remove(workers.order, i)
        end
    end

    local duration = nil
    if entry.startedAtGameMinutes ~= nil then
        duration = math.max(0, gameMinutes() - entry.startedAtGameMinutes)
    end
    workers.stops[#workers.stops + 1] = {
        stopId = workers.nextStopId,
        jobId = entry.jobId,
        vehicleId = entry.vehicleId,
        farmId = entry.farmId,
        jobType = entry.jobType,
        helper = entry.helper,
        reason = FarmLink.Game.aiMessageName(aiMessage),
        durationMin = duration,
        realTs = Clock.realTimestamp(),
        day = Clock.gameDay(),
        minute = Clock.minuteOfDay(),
    }
    workers.nextStopId = workers.nextStopId + 1
    while #workers.stops > AIWorkers.MAX_STOPS do
        table.remove(workers.stops, 1)
    end
    ctx.fleetDirty = true

    -- The job's last wages first, so they precede its worker_stop in the log.
    FarmLink.MoneyFunnel.flushJob(key)
    if entry.vehicleId ~= nil then
        FarmLink.EventLog.emit("worker_stop", entry.farmId, {
            jobId = entry.jobId,
            vehicleId = entry.vehicleId,
            reason = FarmLink.Game.aiMessageName(aiMessage),
            durationMin = duration or 0,
            wagesTotal = FarmLink.MoneyFunnel.jobWages(key),
        })
    end
end

---Running jobs in start order.
function AIWorkers.activeJobs(ctx)
    local out = {}
    for _, key in ipairs(ctx.workers.order) do
        out[#out + 1] = ctx.workers.active[key]
    end
    return out
end

-- The message center calls back with the subscription target first; the target carries the mission
-- context so the callbacks never touch a previous mission's state.
local Subscriber = {}
Subscriber.__index = Subscriber

function Subscriber:started(job, startFarmId)
    local ok, err = pcall(AIWorkers.onJobStarted, self.ctx, job, startFarmId)
    if not ok then
        FarmLink.Log.error("workers: start handler failed: %s", tostring(err))
    end
end

function Subscriber:stopped(job, aiMessage)
    local ok, err = pcall(AIWorkers.onJobStopped, self.ctx, job, aiMessage)
    if not ok then
        FarmLink.Log.error("workers: stop handler failed: %s", tostring(err))
    end
end

function AIWorkers.init(ctx)
    ctx.workers = { active = {}, order = {}, stops = {}, nextStopId = 1 }

    -- Jobs restored with the savegame are already running when the mission starts.
    local aiSystem = g_currentMission ~= nil and g_currentMission.aiSystem or nil
    local running = FarmLink.Game.call(aiSystem, "getActiveJobs")
    if type(running) == "table" then
        for _, job in ipairs(running) do
            AIWorkers.onJobStarted(ctx, job, job.startedFarmId)
        end
    end

    if type(g_messageCenter) ~= "table" or type(MessageType) ~= "table" then
        error("g_messageCenter or MessageType missing", 0)
    end
    local subscriber = setmetatable({ ctx = ctx }, Subscriber)
    ctx.workers.subscriber = subscriber
    g_messageCenter:subscribe(MessageType.AI_JOB_STARTED, Subscriber.started, subscriber)
    g_messageCenter:subscribe(MessageType.AI_JOB_STOPPED, Subscriber.stopped, subscriber)
end

function AIWorkers.shutdown(ctx)
    local subscriber = ctx.workers ~= nil and ctx.workers.subscriber or nil
    if subscriber ~= nil and type(g_messageCenter) == "table" then
        g_messageCenter:unsubscribeAll(subscriber)
    end
end
