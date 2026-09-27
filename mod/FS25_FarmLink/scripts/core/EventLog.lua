-- The event log (P2): every ledger event as one JSON line in events/<day>.ndjson under the save's
-- folder, keyed by (saveId, branchId, seq). The bridge copies the lines to Supabase; docs/LEDGER.md
-- describes what they mean. Contract: packages/schema/src/events.ts.
--
-- Branches (PLAN_REVIEW.md F2). heads.xml, next to the log, holds the highest seq claimed on each
-- branch, and every batch claims its seqs there before its lines are written, so a crash can leave a
-- gap but never reuse a seq. The savegame keeps the branch and seq it was saved at (farmLink.xml).
-- Loading a savegame whose seq is behind its branch's head means the game went back in time: the
-- log starts a new branch that continues from the savegame's seq, and the branch's first line, a
-- `session` event, names its parent and that fork point.
--
-- Files (F1). Lines are written in batches, at most once a second of real time, by appending to the
-- day's file. If the game refuses append mode, the log instead keeps a handle open per day, each in
-- a file of its own (events/<day>-<session>-<n>.ndjson), because write mode starts a file over.
-- Handles for days before yesterday are closed as new days start.

FarmLink = FarmLink or {}

local EventLog = {
    name = "eventLog",
    authority = "server",
    DIR = "events/",
    HEADS_FILE = "heads.xml",
    HEADS_ROOT = "farmLinkHeads",
    FLUSH_MS = 1000,
    -- Lines kept while writes fail; beyond this the oldest are dropped (and show as a seq gap).
    MAX_PENDING = 20000,
    -- Mods the ledger works alongside, reported in each session event.
    INTEGRATIONS = { "FS25_Courseplay", "FS25_AutoDrive" },
}
FarmLink.EventLog = EventLog

local state = nil

-- heads.xml ---------------------------------------------------------------------------------------

---The highest seq claimed on each branch this save's log has seen: { [branchId] = seq }.
---@param path string
---@return table
function EventLog.loadHeads(path)
    local heads = {}
    if type(XMLFile) ~= "table" then
        return heads
    end
    local xml = XMLFile.loadIfExists("farmLinkHeads", path)
    if xml == nil then
        return heads
    end
    pcall(xml.iterate, xml, EventLog.HEADS_ROOT .. ".branch", function(_, key)
        local id = xml:getString(key .. "#id")
        local head = xml:getInt(key .. "#head")
        if FarmLink.Ids.isUuid(id) and type(head) == "number" and head >= 0 then
            heads[id] = math.max(heads[id] or 0, head)
        end
    end)
    xml:delete()
    return heads
end

---@param path string
---@param heads table
---@return boolean ok, string|nil err
function EventLog.saveHeads(path, heads)
    if type(XMLFile) ~= "table" or type(XMLFile.create) ~= "function" then
        return false, "XMLFile unavailable"
    end
    local xml = XMLFile.create("farmLinkHeads", path, EventLog.HEADS_ROOT)
    if xml == nil then
        return false, "could not create " .. path
    end
    local ids = {}
    for id in pairs(heads) do
        ids[#ids + 1] = id
    end
    table.sort(ids)
    local ok, err = pcall(function()
        xml:setInt(EventLog.HEADS_ROOT .. "#format", 1)
        for index, id in ipairs(ids) do
            local key = string.format("%s.branch(%d)", EventLog.HEADS_ROOT, index - 1)
            xml:setString(key .. "#id", id)
            xml:setInt(key .. "#head", heads[id])
        end
        xml:save()
    end)
    xml:delete()
    if not ok then
        return false, tostring(err)
    end
    return true, nil
end

-- Branch decision ---------------------------------------------------------------------------------

---Decides which branch this session writes to, from the savegame's branch and seq and the heads
---the log has claimed. Returns the branch, the seq to continue from, and, for a new branch, its
---parent and fork seq.
---@param ledger table { branchId, seq } from farmLink.xml
---@param heads table
---@return table { branchId, seq, parentBranchId, forkSeq }
function EventLog.chooseBranch(ledger, heads)
    local savedSeq = ledger.seq or 0
    local head = heads[ledger.branchId]
    if head ~= nil and head > savedSeq then
        return {
            branchId = FarmLink.Ids.uuid4(),
            seq = savedSeq,
            parentBranchId = ledger.branchId,
            forkSeq = savedSeq,
        }
    end
    return { branchId = ledger.branchId, seq = savedSeq }
end

-- Writing -----------------------------------------------------------------------------------------

local function integrations()
    local found = {}
    if type(g_modIsLoaded) == "table" then
        for _, name in ipairs(EventLog.INTEGRATIONS) do
            if g_modIsLoaded[name] then
                found[#found + 1] = name
            end
        end
    end
    return FarmLink.Json.array(found)
end

local function claim()
    local last = state.pending[#state.pending]
    if last == nil or (state.heads[state.branchId] or 0) >= last.seq then
        return
    end
    state.heads[state.branchId] = last.seq
    local ok, err = EventLog.saveHeads(state.headsPath, state.heads)
    if not ok then
        state.stats.claimErrors = state.stats.claimErrors + 1
        FarmLink.Log.error("event log: could not claim seqs in %s: %s", EventLog.HEADS_FILE, tostring(err))
    end
end

local function dayFile(day)
    return state.dir .. tostring(day) .. ".ndjson"
end

local function writeWithHandle(day, text)
    local FileIO = FarmLink.FileIO
    local handle = state.handles[day]
    if handle == nil then
        for openDay, open in pairs(state.handles) do
            if openDay < day - 1 then
                FileIO.closeHandle(open)
                state.handles[openDay] = nil
            end
        end
        -- A new name every time, so reopening a day never starts an earlier file over.
        state.segments = state.segments + 1
        local name = string.format("%d-%s-%d.ndjson", day, state.sessionTag, state.segments)
        local err
        handle, err = FileIO.openHandle(state.dir .. name)
        if handle == nil then
            return false, err
        end
        state.handles[day] = handle
    end
    return FileIO.writeHandle(handle, text)
end

local function writeDay(day, text)
    if state.mode == "append" then
        local ok, err = FarmLink.FileIO.appendText(dayFile(day), text)
        if ok then
            return true, nil
        end
        if state.stats.written > 0 then
            return false, err
        end
        -- Append never worked this session: the sandbox refuses it. Keep handles open instead.
        state.mode = "handle"
        FarmLink.Log.warning("event log: append mode refused (%s); keeping files open instead", tostring(err))
    end
    return writeWithHandle(day, text)
end

---Writes every pending line: claims their seqs, then appends each day's lines to its file. Lines
---that fail stay pending for the next flush.
---@return boolean ok
function EventLog.flush()
    if state == nil or #state.pending == 0 then
        return true
    end
    claim()
    local pending = state.pending
    local days, byDay = {}, {}
    for _, entry in ipairs(pending) do
        if byDay[entry.day] == nil then
            byDay[entry.day] = {}
            days[#days + 1] = entry.day
        end
        local lines = byDay[entry.day]
        lines[#lines + 1] = entry.line
    end

    local failedDays = {}
    for _, day in ipairs(days) do
        local ok, err = writeDay(day, table.concat(byDay[day], "\n") .. "\n")
        if ok then
            state.stats.written = state.stats.written + #byDay[day]
        else
            failedDays[day] = true
            state.stats.writeErrors = state.stats.writeErrors + 1
            if state.stats.writeErrors <= 10 then
                FarmLink.Log.error("event log: writing day %d failed: %s", day, tostring(err))
            end
        end
    end

    local kept = {}
    for _, entry in ipairs(pending) do
        if failedDays[entry.day] then
            kept[#kept + 1] = entry
        end
    end
    local overflow = #kept - EventLog.MAX_PENDING
    if overflow > 0 then
        state.stats.dropped = state.stats.dropped + overflow
        local trimmed = {}
        for i = overflow + 1, #kept do
            trimmed[#trimmed + 1] = kept[i]
        end
        kept = trimmed
    end
    state.pending = kept
    state.stats.flushes = state.stats.flushes + 1
    return #kept == 0
end

---Adds one event to the log and returns its seq, or nil when the log is not running. data must
---match the contract for eventType; farmId 0 is for events that belong to no farm.
---@param eventType string
---@param farmId integer
---@param data table
---@param userId string|nil FS25 uniqueUserId of the player who caused it
---@return integer|nil seq
function EventLog.emit(eventType, farmId, data, userId)
    if state == nil then
        return nil
    end
    local Clock = FarmLink.Clock
    state.seq = state.seq + 1
    local envelope = {
        v = 1,
        saveId = state.saveId,
        branchId = state.branchId,
        seq = state.seq,
        day = Clock.gameDay(),
        minute = Clock.minuteOfDay(),
        year = Clock.calendar().year,
        realTs = Clock.realTimestamp(),
        farmId = farmId,
        userId = FarmLink.Json.orNull(userId),
        type = eventType,
        data = data,
    }
    state.pending[#state.pending + 1] = { day = envelope.day, seq = state.seq, line = FarmLink.Json.encode(envelope) }
    state.stats.emitted = state.stats.emitted + 1
    return state.seq
end

-- Module ------------------------------------------------------------------------------------------

---The seq of the last event, and every branch's claimed head, for meta.json. nil when not running.
---@return integer|nil lastSeq, table|nil heads
function EventLog.status()
    if state == nil then
        return nil, nil
    end
    local heads = {}
    for id, head in pairs(state.heads) do
        heads[id] = head
    end
    return state.seq, heads
end

---Counters for meta.json and the probe.
---@return table|nil
function EventLog.stats()
    if state == nil then
        return nil
    end
    local out = { mode = state.mode, pending = #state.pending }
    for key, value in pairs(state.stats) do
        out[key] = value
    end
    return out
end

---Mission start: picks the branch, then writes the session's first line.
function EventLog.init(ctx)
    local FileIO = FarmLink.FileIO
    local dir = ctx.saveDir .. EventLog.DIR
    local ok, err = FileIO.ensureDir(ctx.saveDir, EventLog.DIR)
    if not ok then
        error("creating " .. dir .. ": " .. tostring(err), 0)
    end
    local headsPath = ctx.saveDir .. EventLog.HEADS_FILE
    local heads = EventLog.loadHeads(headsPath)
    local branch = EventLog.chooseBranch(ctx.ledger, heads)
    if branch.parentBranchId ~= nil then
        FarmLink.Log.info(
            "event log: this savegame is behind its branch (seq %d, logged up to %d); new branch %s",
            branch.forkSeq,
            heads[branch.parentBranchId],
            branch.branchId
        )
    end
    heads[branch.branchId] = math.max(heads[branch.branchId] or 0, branch.seq)
    ctx.ledger.branchId = branch.branchId
    ctx.ledger.seq = branch.seq

    state = {
        saveId = ctx.ledger.saveId,
        branchId = branch.branchId,
        seq = branch.seq,
        heads = heads,
        headsPath = headsPath,
        dir = dir,
        mode = "append",
        handles = {},
        segments = 0,
        sessionTag = string.sub(ctx.sessionId or FarmLink.Ids.uuid4(), 1, 8),
        pending = {},
        throttle = FarmLink.Clock.newThrottle(EventLog.FLUSH_MS),
        stats = { emitted = 0, written = 0, flushes = 0, writeErrors = 0, claimErrors = 0, dropped = 0 },
    }

    local calendar = FarmLink.Clock.calendar()
    EventLog.emit("session", 0, {
        modVersion = ctx.modVersion,
        gameVersion = ctx.gameVersion,
        integrations = integrations(),
        period = calendar.period,
        dayInPeriod = calendar.dayInPeriod,
        daysPerPeriod = calendar.daysPerPeriod,
        parentBranchId = branch.parentBranchId,
        forkSeq = branch.forkSeq,
    })
    EventLog.flush()
end

function EventLog.update(dt, _ctx)
    if state ~= nil and state.throttle:tick(dt) then
        EventLog.flush()
    end
end

---The career is being saved: write everything so far, and record the seq the savegame is at. Runs
---after every module's beforeSave, so the lines they flushed are in.
function EventLog.checkpoint(ctx)
    if state == nil then
        return
    end
    EventLog.flush()
    ctx.ledger.branchId = state.branchId
    ctx.ledger.seq = state.seq
end

function EventLog.shutdown(_ctx)
    if state == nil then
        return
    end
    EventLog.flush()
    for _, handle in pairs(state.handles) do
        FarmLink.FileIO.closeHandle(handle)
    end
    state = nil
end
