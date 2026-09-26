-- worker.stop { jobId }: stops a hired worker the way the game's own stop button does, with the
-- "stopped by user" message. On the server AISystem:stopJob stops the job and broadcasts it to the
-- clients (VERIFY_FIRST.md, 6).
--
-- Idempotent: a job that is no longer running answers ok. A job of another farm is rejected, so a
-- command can only reach the farm it names.

FarmLink = FarmLink or {}

FarmLink.CommandChannel.register("worker.stop", {
    args = { "jobId" },
    execute = function(_ctx, command)
        local jobId = tonumber(command.args.jobId)
        if jobId == nil then
            return "rejected", "jobId must be a number"
        end
        local aiSystem = g_currentMission ~= nil and g_currentMission.aiSystem or nil
        if aiSystem == nil then
            return "error", "no AI system"
        end
        local job = FarmLink.Game.call(aiSystem, "getJobById", jobId)
        if job == nil then
            return "ok", "not running"
        end
        if job.startedFarmId ~= command.farmId then
            return "rejected", string.format("job %d belongs to farm %s", jobId, tostring(job.startedFarmId))
        end
        local message = nil
        if type(AIMessageSuccessStoppedByUser) == "table" and type(AIMessageSuccessStoppedByUser.new) == "function" then
            message = AIMessageSuccessStoppedByUser.new()
        end
        aiSystem:stopJob(job, message)
        return "ok", nil
    end,
})
