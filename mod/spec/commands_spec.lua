local helper = require("helper")

describe("command channel", function()
    local Engine
    local EPOCH = "3b7e1c2a-9d4f-4a6b-8c1e-2f3a4b5c6d7e"

    before_each(function()
        Engine = helper.freshMod()
    end)

    ---A timestamp the way the bridge writes it: local wall clock with the local offset.
    local function localTimestamp(secondsAgo)
        local t = os.time() - (secondsAgo or 0)
        local zone = os.date("%z", t)
        return os.date("%Y-%m-%dT%H:%M:%S", t) .. zone:sub(1, 3) .. ":" .. zone:sub(4, 5)
    end

    ---Writes commands.xml as the bridge does (packages/schema/src/xml.ts).
    local function writeCommands(epoch, commands)
        local lines = {
            '<?xml version="1.0" encoding="utf-8" standalone="no" ?>',
            string.format('<commands v="1" epoch="%s">', epoch),
        }
        for _, c in ipairs(commands) do
            local extra = ""
            for name, value in pairs(c.args or {}) do
                extra = extra .. string.format(' %s="%s"', name, value)
            end
            lines[#lines + 1] = string.format(
                '    <command id="%d" type="%s" farmId="%d" issuedAt="%s" ttlSec="%d"%s/>',
                c.id,
                c.type,
                c.farmId or 1,
                c.issuedAt or localTimestamp(1),
                c.ttlSec or 30,
                extra
            )
        end
        lines[#lines + 1] = "</commands>"
        Engine.writeFile(FarmLink.ctx.saveDir .. "commands.xml", table.concat(lines, "\n") .. "\n")
    end

    local function acks()
        return helper.readJson(FarmLink.ctx.saveDir .. "acks.json")
    end

    local function running(uniqueId)
        local vehicle = Engine.addVehicle(helper.tractor({ uniqueId = uniqueId or "vehicle14" }))
        local job = Engine.newJob(nil, vehicle, 1)
        Engine.startJob(job)
        return job
    end

    it("answers a ping", function()
        Engine.loadMission({})
        writeCommands(EPOCH, { { id = 1, type = "ping" } })
        Engine.run(0.6)
        local ring = acks()
        assert.are.equal(EPOCH, ring.epoch)
        assert.are.equal(1, ring.watermark)
        assert.are.equal("ok", ring.acks[1].status)
        assert.are.equal("pong", ring.acks[1].message)
    end)

    it("stops a worker the way the stop button does, and reports the stop as user-stopped", function()
        Engine.loadMission({})
        local job = running()
        writeCommands(EPOCH, { { id = 7, type = "worker.stop", args = { jobId = tostring(job.jobId) } } })
        Engine.run(0.6)
        assert.are.equal("ok", acks().acks[1].status)
        assert.are.equal(0, #g_currentMission.aiSystem:getActiveJobs())
        assert.are.equal("SUCCESS_STOPPED_BY_USER", FarmLink.ctx.workers.stops[1].reason)
    end)

    it("answers ok for a worker that is no longer running", function()
        Engine.loadMission({})
        writeCommands(EPOCH, { { id = 1, type = "worker.stop", args = { jobId = "99" } } })
        Engine.run(0.6)
        assert.are.same({ "ok", "not running" }, { acks().acks[1].status, acks().acks[1].message })
    end)

    it("refuses to stop another farm's worker", function()
        Engine.loadMission({})
        local job = running()
        writeCommands(EPOCH, { { id = 1, type = "worker.stop", farmId = 2, args = { jobId = tostring(job.jobId) } } })
        Engine.run(0.6)
        assert.are.equal("rejected", acks().acks[1].status)
        assert.are.equal(1, #g_currentMission.aiSystem:getActiveJobs())
    end)

    it("expires a command older than its TTL instead of running it", function()
        Engine.loadMission({})
        local job = running()
        writeCommands(EPOCH, {
            { id = 1, type = "worker.stop", issuedAt = localTimestamp(120), ttlSec = 30, args = { jobId = tostring(job.jobId) } },
        })
        Engine.run(0.6)
        assert.are.equal("expired", acks().acks[1].status)
        assert.are.equal(1, #g_currentMission.aiSystem:getActiveJobs())
    end)

    it("rejects unknown types and bad arguments, and moves past them", function()
        Engine.loadMission({})
        writeCommands(EPOCH, {
            { id = 1, type = "worker.teleport" },
            { id = 2, type = "worker.stop", args = { jobId = "abc" } },
            { id = 3, type = "ping" },
        })
        Engine.run(0.6)
        local ring = acks()
        assert.are.same({ "rejected", "rejected", "ok" }, { ring.acks[1].status, ring.acks[2].status, ring.acks[3].status })
        assert.are.equal(3, ring.watermark)
    end)

    it("runs each id once, in order, however often the ring is rewritten", function()
        Engine.loadMission({})
        writeCommands(EPOCH, { { id = 2, type = "ping" }, { id = 1, type = "ping" } })
        Engine.run(0.6)
        writeCommands(EPOCH, { { id = 1, type = "ping" }, { id = 2, type = "ping" }, { id = 3, type = "ping" } })
        Engine.run(0.6)
        local ids = {}
        for _, ack in ipairs(acks().acks) do
            ids[#ids + 1] = ack.id
        end
        assert.are.same({ 1, 2, 3 }, ids)
    end)

    it("starts over when a reinstalled bridge numbers from 1 under a new epoch", function()
        Engine.loadMission({})
        writeCommands(EPOCH, { { id = 40, type = "ping" } })
        Engine.run(0.6)
        local newEpoch = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d"
        writeCommands(newEpoch, { { id = 1, type = "ping" } })
        Engine.run(0.6)
        local ring = acks()
        assert.are.equal(newEpoch, ring.epoch)
        assert.are.equal(1, ring.watermark)
        assert.are.equal(1, #ring.acks)
    end)

    it("keeps the watermark in farmLink.xml across save and reload", function()
        Engine.loadMission({})
        writeCommands(EPOCH, { { id = 5, type = "ping" } })
        Engine.run(0.6)
        Engine.saveCareer()
        local directory = g_currentMission.missionInfo.savegameDirectory
        local saveDir = FarmLink.ctx.saveDir
        Engine.unloadMission()

        Engine.loadMission({ savegameDirectory = directory })
        assert.are.equal(saveDir, FarmLink.ctx.saveDir)
        assert.are.equal(EPOCH, FarmLink.ctx.commands.epoch)
        assert.are.equal(5, FarmLink.ctx.commands.watermark)
        writeCommands(EPOCH, { { id = 5, type = "ping" }, { id = 6, type = "ping" } })
        Engine.run(0.6)
        assert.are.equal(1, #acks().acks)
        assert.are.equal(6, acks().acks[1].id)
    end)

    it("ignores a half-written commands.xml until it is complete", function()
        Engine.loadMission({})
        Engine.writeFile(FarmLink.ctx.saveDir .. "commands.xml", '<?xml version="1.0"?><commands v="1" epoch="' .. EPOCH .. '"><command id="1" ty')
        Engine.run(0.6)
        assert.is_nil(Engine.readFile(FarmLink.ctx.saveDir .. "acks.json"))
        writeCommands(EPOCH, { { id = 1, type = "ping" } })
        Engine.run(0.6)
        assert.are.equal("ok", acks().acks[1].status)
    end)

    it("sees the bridge while its heartbeat keeps changing", function()
        Engine.loadMission({})
        local path = FarmLink.ctx.saveDir .. "bridge.xml"
        local function beat(n)
            Engine.writeFile(path, string.format('<?xml version="1.0"?>\n<bridge v="1" version="0.2.0" beat="%d" realTs="%s" features="commands"/>\n', n, localTimestamp(0)))
        end
        beat(1)
        Engine.run(5.1, 100)
        assert.is_true(FarmLink.ctx.bridge.present)
        assert.are.equal("0.2.0", FarmLink.ctx.bridge.version)
        Engine.run(15, 100)
        assert.is_false(FarmLink.ctx.bridge.present)
        beat(2)
        Engine.run(5.1, 100)
        assert.is_true(FarmLink.ctx.bridge.present)
    end)
end)
