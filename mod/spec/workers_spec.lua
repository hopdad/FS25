local helper = require("helper")

describe("AIWorkers", function()
    local Engine

    before_each(function()
        Engine = helper.freshMod()
    end)

    local function hire(opts)
        opts = opts or {}
        local vehicle = Engine.addVehicle(helper.tractor({ uniqueId = opts.uniqueId or "vehicle14", x = 30 }))
        local job = Engine.newJob(opts.jobId, vehicle, opts.farmId or 1, { helper = opts.helper })
        Engine.startJob(job)
        return job, vehicle
    end

    it("records a started job with its vehicle, type, helper and field", function()
        Engine.loadMission({})
        local job = hire({ helper = "Sam" })
        local jobs = FarmLink.AIWorkers.activeJobs(FarmLink.ctx)
        assert.are.equal(1, #jobs)
        assert.are.equal(tostring(job.jobId), jobs[1].jobId)
        assert.are.equal("vehicle14", jobs[1].vehicleId)
        assert.are.equal("FIELDWORK", jobs[1].jobType)
        assert.are.equal("Sam", jobs[1].helper)
        assert.are.equal(12, jobs[1].fieldId)
        assert.are.equal(1, jobs[1].farmId)
    end)

    it("moves a stopped job to the stop ring with the registered reason and game-minute duration", function()
        Engine.loadMission({})
        local job = hire()
        g_currentMission.environment.dayTime = g_currentMission.environment.dayTime + 95 * 60000
        Engine.stopJob(job, Engine.AIMessages.ERROR_OUT_OF_FUEL.new())

        assert.are.equal(0, #FarmLink.AIWorkers.activeJobs(FarmLink.ctx))
        local stop = FarmLink.ctx.workers.stops[1]
        assert.are.equal(1, stop.stopId)
        assert.are.equal("ERROR_OUT_OF_FUEL", stop.reason)
        assert.are.equal(95, stop.durationMin)
        assert.are.equal("vehicle14", stop.vehicleId)
    end)

    it("names a stop without a message UNKNOWN", function()
        Engine.loadMission({})
        local job = hire()
        Engine.stopJob(job, nil)
        assert.are.equal("UNKNOWN", FarmLink.ctx.workers.stops[1].reason)
    end)

    it("keeps only the newest stops", function()
        Engine.loadMission({})
        for i = 1, FarmLink.AIWorkers.MAX_STOPS + 5 do
            local job = hire({ uniqueId = "vehicle" .. i })
            Engine.stopJob(job, Engine.AIMessages.SUCCESS_FINISHED_JOB.new())
        end
        local stops = FarmLink.ctx.workers.stops
        assert.are.equal(FarmLink.AIWorkers.MAX_STOPS, #stops)
        assert.are.equal(6, stops[1].stopId)
    end)

    it("picks up jobs that were already running when the mission started", function()
        local vehicle = Engine.newVehicle({ uniqueId = "vehicle3", fuel = { fillType = "DIESEL", level = 1, capacity = 1 } })
        Engine.loadMission({})
        Engine.unloadMission()
        -- A fresh mission whose AI system restored a job from the savegame before FarmLink starts.
        local listeners = Engine.listeners
        Engine.listeners = {}
        local mission = Engine.loadMission({})
        Engine.listeners = listeners
        mission.aiSystem:startJob(Engine.newJob(4, vehicle, 1), 1)
        FarmLink:loadMap("map.xml")
        local jobs = FarmLink.AIWorkers.activeJobs(FarmLink.ctx)
        assert.are.equal(1, #jobs)
        assert.are.equal("4", jobs[1].jobId)
    end)

    it("stops listening when the mission ends", function()
        Engine.loadMission({})
        local ctx = FarmLink.ctx
        Engine.unloadMission()
        Engine.loadMission({})
        local job = hire()
        Engine.stopJob(job, nil)
        assert.are.equal(0, #ctx.workers.stops)
        assert.are.equal(1, #FarmLink.ctx.workers.stops)
    end)
end)
