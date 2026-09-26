-- FarmLink bootstrap: sources the mod's files, installs the process-wide hooks once, and drives the
-- module registry from the game's mod event listener.
--
-- Rules every module follows (docs/HANDOFF.md "Mod (Lua) spec", docs/PLAN_REVIEW.md F7):
--   * Ledger work and file writes happen only where g_currentMission:getIsServer() is true.
--   * Every module call goes through the registry's pcall; the save never breaks because FarmLink did.
--   * Mod Lua state outlives a mission, so hooks are installed once per process, at file scope, and
--     all per-mission state is rebuilt in loadMap and dropped in deleteMap.

FarmLink = FarmLink or {}

FarmLink.MOD_NAME = g_currentModName or "FS25_FarmLink"
FarmLink.MOD_DIR = g_currentModDirectory or ""
FarmLink.VERSION = "0.1.0.0"
FarmLink.SCHEMA_VERSION = 1

local SOURCES = {
    "scripts/core/Log.lua",
    "scripts/core/Json.lua",
    "scripts/core/Clock.lua",
    "scripts/core/FileIO.lua",
    "scripts/core/Ids.lua",
    "scripts/core/Game.lua",
    "scripts/core/Registry.lua",
    "scripts/core/Persistence.lua",
    "scripts/core/Meta.lua",
    "scripts/hooks/AIWorkers.lua",
    "scripts/collectors/Vehicle.lua",
    "scripts/collectors/Fleet.lua",
    "scripts/collectors/Farm.lua",
    "scripts/commands/CommandChannel.lua",
    "scripts/commands/handlers/Ping.lua",
    "scripts/commands/handlers/WorkerStop.lua",
    "scripts/probe/Probe.lua",
}

for _, file in ipairs(SOURCES) do
    source(FarmLink.MOD_DIR .. file)
end

local Log = FarmLink.Log

if FarmLink.registry == nil then
    FarmLink.registry = FarmLink.Registry.new(Log)
    FarmLink.registry:add(FarmLink.Meta)
    -- Workers first: the fleet channel reads the worker registry.
    FarmLink.registry:add(FarmLink.AIWorkers)
    FarmLink.registry:add(FarmLink.VehicleCollector)
    FarmLink.registry:add(FarmLink.Fleet)
    FarmLink.registry:add(FarmLink.FarmCollector)
    FarmLink.registry:add(FarmLink.CommandChannel)
    if FarmLink.Probe.ENABLED then
        FarmLink.registry:add(FarmLink.Probe)
    end
end

-- Per-mission context; nil between missions.
FarmLink.ctx = nil

---Whether this instance owns the ledger: the single-player game, the multiplayer host, or the
---dedicated server.
---@return boolean
function FarmLink.isAuthority()
    local mission = g_currentMission
    if mission == nil or type(mission.getIsServer) ~= "function" then
        return false
    end
    local ok, isServer = pcall(mission.getIsServer, mission)
    return ok and isServer == true
end

---@return string "singleplayer" | "host" | "dedicated"
function FarmLink.detectMode(mission)
    if g_dedicatedServer ~= nil or g_dedicatedServerInfo ~= nil then
        return "dedicated"
    end
    local dynamicInfo = mission ~= nil and mission.missionDynamicInfo or nil
    if dynamicInfo ~= nil and dynamicInfo.isMultiplayer then
        return "host"
    end
    return "singleplayer"
end

---@return string
function FarmLink.gameVersion()
    local version = g_gameVersionDisplay or g_gameVersion
    if version == nil then
        return "unknown"
    end
    return tostring(version)
end

---The version in modDesc.xml, falling back to the constant above.
---@return string
function FarmLink.modVersion()
    if g_modManager ~= nil and type(g_modManager.getModByName) == "function" then
        local ok, mod = pcall(g_modManager.getModByName, g_modManager, FarmLink.MOD_NAME)
        if ok and type(mod) == "table" and type(mod.version) == "string" and mod.version ~= "" then
            return mod.version
        end
    end
    return FarmLink.VERSION
end

---Resolves folders and the ledger identity for the mission that is starting.
---@return table|nil ctx, string|nil err
function FarmLink.buildContext(mission)
    local baseDir, baseDirSource = FarmLink.FileIO.resolveBaseDir(FarmLink.MOD_NAME)
    if baseDir == nil then
        return nil, "no modSettings folder (g_modSettingsDirectory and getUserProfileAppPath both unavailable)"
    end

    local info = mission.missionInfo or {}
    local ledger = FarmLink.Persistence.load(info.savegameDirectory)

    local ok, err = FarmLink.FileIO.ensureDir(baseDir, ledger.saveId)
    if not ok then
        return nil, "creating " .. baseDir .. ledger.saveId .. "/: " .. tostring(err)
    end

    return {
        isAuthority = true,
        modVersion = FarmLink.modVersion(),
        gameVersion = FarmLink.gameVersion(),
        mode = FarmLink.detectMode(mission),
        baseDir = baseDir,
        baseDirSource = baseDirSource,
        saveDir = baseDir .. ledger.saveId .. "/",
        ledger = ledger,
        sessionId = FarmLink.Ids.uuid4(),
        savegameDirectory = info.savegameDirectory,
        saveName = info.savegameName,
        savegameIndex = info.savegameIndex,
        registry = FarmLink.registry,
        stats = { live = { writes = 0, timed = 0, totalMs = 0, maxMs = 0 } },
        lastSave = nil,
    }
end

function FarmLink.startMission()
    FarmLink.registry:reset()
    FarmLink.ctx = nil

    if not FarmLink.isAuthority() then
        FarmLink.ctx = { isAuthority = false }
        Log.info("%s on a multiplayer client: the server keeps the ledger", FarmLink.modVersion())
        return
    end

    local ctx, err = FarmLink.buildContext(g_currentMission)
    if ctx == nil then
        Log.error("inactive this session: %s", tostring(err))
        return
    end
    FarmLink.ctx = ctx
    Log.info(
        "%s on game %s (%s); saveId %s%s; files in %s",
        ctx.modVersion,
        ctx.gameVersion,
        ctx.mode,
        ctx.ledger.saveId,
        ctx.ledger.isNew and " (new)" or "",
        ctx.saveDir
    )
    FarmLink.registry:call("init", true, ctx)
end

-- Mod event listener -------------------------------------------------------------------------------

function FarmLink:loadMap(_filename)
    local ok, err = pcall(FarmLink.startMission)
    if not ok then
        FarmLink.ctx = nil
        Log.error("start failed: %s", tostring(err))
    end
end

function FarmLink:update(dt)
    local ctx = FarmLink.ctx
    if ctx ~= nil and ctx.isAuthority then
        FarmLink.registry:call("update", true, dt, ctx)
    end
end

function FarmLink:deleteMap()
    local ctx = FarmLink.ctx
    FarmLink.ctx = nil
    if ctx ~= nil and ctx.isAuthority then
        FarmLink.registry:call("shutdown", true, ctx)
    end
end

-- Career save --------------------------------------------------------------------------------------

---Appended to FSCareerMissionInfo.saveToXMLFile: writes farmLink.xml next to the save.
function FarmLink.onCareerSaved(missionInfo)
    local ctx = FarmLink.ctx
    if ctx == nil or not ctx.isAuthority then
        return
    end
    local directory = type(missionInfo) == "table" and missionInfo.savegameDirectory or nil
    local ok, err = FarmLink.Persistence.save(directory, ctx.ledger)
    ctx.lastSave = { ok = ok, err = err }
    if ok then
        ctx.savegameDirectory = directory
    else
        Log.error("could not write %s: %s", FarmLink.Persistence.FILE_NAME, tostring(err))
    end
    FarmLink.registry:call("onSave", true, ctx, missionInfo)
end

function FarmLink.installProcessHooks()
    if FarmLink.processHooksInstalled then
        return
    end
    FarmLink.processHooksInstalled = true

    local canAppend = type(Utils) == "table" and type(Utils.appendedFunction) == "function"
    if canAppend and type(FSCareerMissionInfo) == "table" and type(FSCareerMissionInfo.saveToXMLFile) == "function" then
        FSCareerMissionInfo.saveToXMLFile = Utils.appendedFunction(
            FSCareerMissionInfo.saveToXMLFile,
            function(missionInfo)
                local ok, err = pcall(FarmLink.onCareerSaved, missionInfo)
                if not ok then
                    Log.error("save hook failed: %s", tostring(err))
                end
            end
        )
        FarmLink.saveHookInstalled = true
    else
        Log.warning("FSCareerMissionInfo.saveToXMLFile not found; %s will not be saved", FarmLink.Persistence.FILE_NAME)
    end

    if FarmLink.Probe.ENABLED then
        local ok, err = pcall(FarmLink.Probe.installProcessHooks)
        if not ok then
            Log.error("probe hooks failed: %s", tostring(err))
        end
    end
end

FarmLink.installProcessHooks()

if not FarmLink.listenerAdded then
    FarmLink.listenerAdded = true
    addModEventListener(FarmLink)
end
