-- The command channel, mod side. The bridge rewrites commands.xml with a ring of recent commands;
-- the mod polls it, runs every command above its watermark in id order, and answers in acks.json.
-- XML because the sandbox only lets a mod read XML (PLAN_REVIEW.md F1); wire format in
-- packages/schema/src/xml.ts.
--
-- Rules (docs/HANDOFF.md, "Data contracts"):
--   * ids above the persisted watermark run in order, once; the watermark advances even on failure
--   * a command older than its TTL is answered "expired" and not run
--   * every handler is idempotent (stopping a stopped worker is "ok")
--   * statuses: ok, rejected, expired, error
-- The watermark belongs to the bridge's epoch: a reinstalled bridge numbers from 1 again under a new
-- epoch, and the mod starts over instead of ignoring it.

FarmLink = FarmLink or {}

local CommandChannel = {
    name = "commands",
    authority = "server",
    FILE_NAME = "commands.xml",
    ACKS_FILE_NAME = "acks.json",
    BRIDGE_FILE_NAME = "bridge.xml",
    POLL_MS = 500,
    BRIDGE_POLL_MS = 5000,
    BRIDGE_TIMEOUT_MS = 10000,
    MAX_ACKS = 50,
    -- Envelope attributes; every other attribute of <command> is an argument.
    ENVELOPE = { id = true, type = true, farmId = true, issuedAt = true, ttlSec = true },
}
FarmLink.CommandChannel = CommandChannel

local handlers = {}

---Registers a handler: execute(ctx, command) returns status, message.
function CommandChannel.register(commandType, handler)
    handlers[commandType] = handler
end

local function readCommands(path)
    local xml = XMLFile.loadIfExists("farmLinkCommands", path)
    if xml == nil then
        return nil, nil
    end
    local epoch = xml:getString("commands#epoch")
    local commands = {}
    local ok, err = pcall(xml.iterate, xml, "commands.command", function(_, key)
        local command = {
            id = xml:getInt(key .. "#id"),
            type = xml:getString(key .. "#type"),
            farmId = xml:getInt(key .. "#farmId"),
            issuedAt = xml:getString(key .. "#issuedAt"),
            ttlSec = xml:getInt(key .. "#ttlSec"),
            args = {},
        }
        local handler = handlers[command.type]
        if handler ~= nil then
            for _, name in ipairs(handler.args or {}) do
                command.args[name] = xml:getString(key .. "#" .. name)
            end
        end
        commands[#commands + 1] = command
    end)
    xml:delete()
    if not ok then
        error("reading commands.xml: " .. tostring(err), 0)
    end
    table.sort(commands, function(a, b)
        return (a.id or 0) < (b.id or 0)
    end)
    return epoch, commands
end

---Runs one command and returns status, message. Never raises.
function CommandChannel.execute(ctx, command)
    if type(command.id) ~= "number" or command.id < 1 then
        return "rejected", "missing id"
    end
    local handler = handlers[command.type]
    if handler == nil then
        return "rejected", "unknown command type " .. tostring(command.type)
    end
    local ttl = command.ttlSec or 0
    local age = FarmLink.Clock.secondsSince(command.issuedAt)
    if age == nil then
        return "rejected", "unreadable issuedAt"
    end
    if ttl > 0 and age > ttl then
        return "expired", string.format("issued %d s ago, ttl %d s", math.floor(age), ttl)
    end
    local ok, status, message = pcall(handler.execute, ctx, command)
    if not ok then
        return "error", tostring(status)
    end
    return status or "ok", message
end

local function writeAcks(ctx)
    local state = ctx.commands
    local Json = FarmLink.Json
    local document = {
        v = 1,
        epoch = Json.orNull(state.epoch),
        watermark = state.watermark,
        acks = Json.array(state.acks),
    }
    local ok, err = FarmLink.FileIO.writeText(ctx.saveDir .. CommandChannel.ACKS_FILE_NAME, Json.encode(document))
    if not ok then
        error("writing acks.json: " .. tostring(err), 0)
    end
end

---Reads commands.xml once and runs whatever is new. Returns how many commands ran.
function CommandChannel.poll(ctx)
    local state = ctx.commands
    local epoch, commands = readCommands(ctx.saveDir .. CommandChannel.FILE_NAME)
    if epoch == nil then
        return 0
    end
    if epoch ~= state.epoch then
        FarmLink.Log.info("commands: new bridge epoch %s, watermark reset", tostring(epoch))
        state.epoch = epoch
        state.watermark = 0
        state.acks = {}
    end

    local ran = 0
    for _, command in ipairs(commands) do
        if type(command.id) == "number" and command.id > state.watermark then
            local status, message = CommandChannel.execute(ctx, command)
            state.acks[#state.acks + 1] = {
                v = 1,
                id = command.id,
                status = status,
                message = FarmLink.Json.orNull(message),
                at = FarmLink.Clock.realTimestamp(),
            }
            while #state.acks > CommandChannel.MAX_ACKS do
                table.remove(state.acks, 1)
            end
            state.watermark = command.id
            ran = ran + 1
            FarmLink.Log.info("command %d %s: %s%s", command.id, tostring(command.type), status, message and (" (" .. message .. ")") or "")
        end
    end
    if ran > 0 then
        ctx.ledger.commandEpoch = state.epoch
        ctx.ledger.commandWatermark = state.watermark
        writeAcks(ctx)
    end
    return ran
end

---Reads bridge.xml: the bridge counts as present while its beat keeps changing (PLAN_REVIEW.md F1).
function CommandChannel.checkBridge(ctx, nowMs)
    local link = ctx.bridge
    local xml = XMLFile.loadIfExists("farmLinkBridge", ctx.saveDir .. CommandChannel.BRIDGE_FILE_NAME)
    if xml ~= nil then
        local beat = xml:getInt("bridge#beat")
        link.version = xml:getString("bridge#version")
        link.features = xml:getString("bridge#features")
        xml:delete()
        if beat ~= nil and beat ~= link.beat then
            link.beat = beat
            link.lastChangeMs = nowMs
        end
    end
    link.present = link.lastChangeMs ~= nil and nowMs - link.lastChangeMs <= CommandChannel.BRIDGE_TIMEOUT_MS
end

function CommandChannel.init(ctx)
    ctx.commands = {
        epoch = ctx.ledger.commandEpoch,
        watermark = ctx.ledger.commandWatermark or 0,
        acks = {},
        pollThrottle = FarmLink.Clock.newThrottle(CommandChannel.POLL_MS),
        bridgeThrottle = FarmLink.Clock.newThrottle(CommandChannel.BRIDGE_POLL_MS, CommandChannel.BRIDGE_POLL_MS),
        elapsedMs = 0,
    }
    ctx.bridge = { present = false }
end

function CommandChannel.update(dt, ctx)
    local state = ctx.commands
    state.elapsedMs = state.elapsedMs + (dt or 0)
    if state.pollThrottle:tick(dt) then
        CommandChannel.poll(ctx)
    end
    if state.bridgeThrottle:tick(dt) then
        CommandChannel.checkBridge(ctx, state.elapsedMs)
    end
end
