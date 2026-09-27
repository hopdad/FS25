local helper = require("helper")
local lfs = require("lfs")

describe("the event log", function()
    local Engine

    before_each(function()
        Engine = helper.freshMod()
    end)

    local function eventsDir()
        return FarmLink.ctx.saveDir .. "events/"
    end

    ---Every line in the events folder, decoded, with the file it came from; sorted by seq.
    local function readEvents(dir)
        local names = {}
        for name in lfs.dir(dir or eventsDir()) do
            if name:match("%.ndjson$") then
                names[#names + 1] = name
            end
        end
        table.sort(names)
        local events = {}
        for _, name in ipairs(names) do
            local text = Engine.readFile((dir or eventsDir()) .. name)
            assert.are.equal("\n", text:sub(-1), name .. " ends mid-line")
            for line in text:gmatch("[^\n]+") do
                local event = helper.decode(line)
                event.file = name
                events[#events + 1] = event
            end
        end
        table.sort(events, function(a, b)
            return a.seq < b.seq
        end)
        return events
    end

    local function seqs(events)
        local out = {}
        for i, event in ipairs(events) do
            out[i] = event.seq
        end
        return out
    end

    local function fuel(amount)
        return {
            amount = amount,
            moneyType = "PURCHASE_FUEL",
            context = { kind = "fuel", vehicleId = "vehicle7f3a", fillType = "DIESEL", liters = 40 },
        }
    end

    local function headsIn(saveDir)
        return FarmLink.EventLog.loadHeads(saveDir .. "heads.xml")
    end

    it("starts every session with a session event, and a new save at seq 1", function()
        Engine.loadMission({})
        local events = readEvents()
        assert.are.equal(1, #events)
        local session = events[1]
        assert.are.equal("37.ndjson", session.file)
        assert.are.same({
            v = 1,
            saveId = FarmLink.ctx.ledger.saveId,
            branchId = FarmLink.ctx.ledger.branchId,
            seq = 1,
            day = 37,
            minute = 845,
            year = 2,
            farmId = 0,
            userId = helper.NULL,
            type = "session",
        }, {
            v = session.v,
            saveId = session.saveId,
            branchId = session.branchId,
            seq = session.seq,
            day = session.day,
            minute = session.minute,
            year = session.year,
            farmId = session.farmId,
            userId = session.userId,
            type = session.type,
        })
        assert.are.same({
            modVersion = FarmLink.ctx.modVersion,
            gameVersion = "1.12.0.0",
            integrations = {},
            period = 4,
            dayInPeriod = 1,
            daysPerPeriod = 3,
        }, session.data)
        assert.is_truthy(session.realTs:match("^%d%d%d%d%-%d%d%-%d%dT%d%d:%d%d:%d%d"))
    end)

    it("numbers events in order and writes them in batches, at most once a second", function()
        Engine.loadMission({})
        local EventLog = FarmLink.EventLog
        assert.are.equal(2, EventLog.emit("money", 1, fuel(-60)))
        assert.are.equal(3, EventLog.emit("money", 1, fuel(-40), "4f1e2d3c"))
        Engine.run(0.5)
        assert.are.equal(1, #readEvents())
        Engine.run(0.6)
        local events = readEvents()
        assert.are.same({ 1, 2, 3 }, seqs(events))
        assert.are.equal(-60, events[2].data.amount)
        assert.are.equal("4f1e2d3c", events[3].userId)
        assert.are.equal(helper.NULL, events[2].userId)
    end)

    it("files each line under the game day it happened on", function()
        Engine.loadMission({})
        FarmLink.EventLog.emit("money", 1, fuel(-60))
        Engine.newDay()
        FarmLink.EventLog.emit("money", 1, fuel(-40))
        Engine.run(1.1)
        local byFile = {}
        for _, event in ipairs(readEvents()) do
            byFile[event.file] = (byFile[event.file] or 0) + 1
        end
        assert.are.same({ ["37.ndjson"] = 2, ["38.ndjson"] = 1 }, byFile)
    end)

    it("claims each batch's seqs in heads.xml", function()
        Engine.loadMission({})
        local branch = FarmLink.ctx.ledger.branchId
        assert.are.same({ [branch] = 1 }, headsIn(FarmLink.ctx.saveDir))
        FarmLink.EventLog.emit("money", 1, fuel(-60))
        FarmLink.EventLog.emit("money", 1, fuel(-40))
        Engine.run(1.1)
        assert.are.same({ [branch] = 3 }, headsIn(FarmLink.ctx.saveDir))
    end)

    it("writes every event before a save, and the savegame keeps the seq it was saved at", function()
        local directory = Engine.tempDir("savegame1")
        Engine.loadMission({ savegameDirectory = directory })
        FarmLink.EventLog.emit("money", 1, fuel(-60))
        FarmLink.EventLog.emit("money", 1, fuel(-40))
        Engine.saveCareer()
        assert.are.same({ 1, 2, 3 }, seqs(readEvents()))
        local saved = FarmLink.Persistence.load(directory)
        assert.are.equal(3, saved.seq)
        assert.are.equal(FarmLink.ctx.ledger.branchId, saved.branchId)
    end)

    it("continues the branch when the latest save is loaded again", function()
        local directory = Engine.tempDir("savegame1")
        Engine.loadMission({ savegameDirectory = directory })
        local branch = FarmLink.ctx.ledger.branchId
        FarmLink.EventLog.emit("money", 1, fuel(-60))
        Engine.saveCareer()
        local saveDir = FarmLink.ctx.saveDir
        Engine.unloadMission()

        Engine.loadMission({ savegameDirectory = directory })
        assert.are.equal(branch, FarmLink.ctx.ledger.branchId)
        local events = readEvents()
        assert.are.same({ 1, 2, 3 }, seqs(events))
        assert.are.equal("session", events[3].type)
        assert.is_nil(events[3].data.parentBranchId)
        assert.are.same({ [branch] = 3 }, headsIn(saveDir))
    end)

    it("forks a new branch at the savegame's seq when an older save is loaded", function()
        local directory = Engine.tempDir("savegame1")
        Engine.loadMission({ savegameDirectory = directory })
        local parent = FarmLink.ctx.ledger.branchId
        FarmLink.EventLog.emit("money", 1, fuel(-60))
        Engine.saveCareer()
        -- Played on after saving, then quit without saving: seqs 3 and 4 are not in the savegame.
        FarmLink.EventLog.emit("money", 1, fuel(-40))
        FarmLink.EventLog.emit("money", 1, fuel(-20))
        local saveDir = FarmLink.ctx.saveDir
        Engine.unloadMission()
        assert.are.same({ [parent] = 4 }, headsIn(saveDir))

        Engine.loadMission({ savegameDirectory = directory })
        local branch = FarmLink.ctx.ledger.branchId
        assert.are_not.equal(parent, branch)
        assert.is_true(FarmLink.Ids.isUuid(branch))
        local onBranch = {}
        for _, event in ipairs(readEvents()) do
            if event.branchId == branch then
                onBranch[#onBranch + 1] = event
            end
        end
        assert.are.equal(1, #onBranch)
        local session = onBranch[1]
        assert.are.same({ seq = 3, type = "session" }, { seq = session.seq, type = session.type })
        assert.are.equal(parent, session.data.parentBranchId)
        assert.are.equal(2, session.data.forkSeq)
        assert.are.same({ [parent] = 4, [branch] = 3 }, headsIn(saveDir))

        -- Saving on the new branch makes the savegame continue it from now on.
        Engine.saveCareer()
        Engine.unloadMission()
        Engine.loadMission({ savegameDirectory = directory })
        assert.are.equal(branch, FarmLink.ctx.ledger.branchId)
        assert.are.equal(4, FarmLink.EventLog.status())
    end)

    it("keeps files open for the session where append mode is refused", function()
        Engine = helper.freshMod({ blockAppend = true })
        Engine.loadMission({})
        FarmLink.EventLog.emit("money", 1, fuel(-60))
        Engine.run(1.1)
        FarmLink.EventLog.emit("money", 1, fuel(-40))
        Engine.run(1.1)
        local events = readEvents()
        assert.are.same({ 1, 2, 3 }, seqs(events))
        local tag = string.sub(FarmLink.ctx.sessionId, 1, 8)
        assert.are.equal("37-" .. tag .. "-1.ndjson", events[3].file)
        assert.are.equal("handle", FarmLink.EventLog.stats().mode)
        assert.is_truthy(table.concat(Engine.logLines, "\n"):find("append mode refused", 1, true))
    end)

    it("opens a new file for each day while keeping files open", function()
        Engine = helper.freshMod({ blockAppend = true })
        Engine.loadMission({})
        Engine.newDay()
        FarmLink.EventLog.emit("money", 1, fuel(-60))
        Engine.run(1.1)
        local tag = string.sub(FarmLink.ctx.sessionId, 1, 8)
        local files = {}
        for _, event in ipairs(readEvents()) do
            files[#files + 1] = event.file
        end
        assert.are.same({ "37-" .. tag .. "-1.ndjson", "38-" .. tag .. "-2.ndjson" }, files)
    end)

    it("keeps the lines of a failed write and writes them once it can", function()
        Engine.loadMission({})
        local dir = eventsDir()
        os.remove(dir .. "37.ndjson")
        assert.is_true(lfs.rmdir(dir))
        FarmLink.EventLog.emit("money", 1, fuel(-60))
        Engine.run(1.1)
        assert.are.equal(1, FarmLink.EventLog.stats().pending)
        assert.are.equal(1, FarmLink.EventLog.stats().writeErrors)
        lfs.mkdir(dir)
        Engine.run(1.1)
        assert.are.equal(0, FarmLink.EventLog.stats().pending)
        assert.are.same({ 2 }, seqs(readEvents()))
    end)

    it("writes what is left when the mission ends", function()
        Engine.loadMission({})
        local dir = eventsDir()
        FarmLink.EventLog.emit("money", 1, fuel(-60))
        Engine.unloadMission()
        assert.are.same({ 1, 2 }, seqs(readEvents(dir)))
        assert.is_nil(FarmLink.EventLog.emit("money", 1, fuel(-40)))
    end)

    it("names Courseplay and AutoDrive in the session event when they are loaded", function()
        Engine = helper.freshMod({ modsLoaded = { FS25_AutoDrive = true, FS25_Courseplay = true } })
        Engine.loadMission({})
        assert.are.same({ "FS25_Courseplay", "FS25_AutoDrive" }, readEvents()[1].data.integrations)
    end)

    it("writes nothing on a multiplayer client", function()
        Engine.loadMission({ isServer = false, isMultiplayer = true })
        assert.is_nil(FarmLink.EventLog.emit("money", 1, fuel(-60)))
    end)
end)
