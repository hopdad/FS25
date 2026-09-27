-- P0 probe. Answers the runtime half of the verify-first items (docs/VERIFY_FIRST.md) and writes the
-- answers to modSettings/FS25_FarmLink/_probe/probe.json: once at mission start, every 10 s, on every
-- save and at mission end. LedgerProbe.lua adds the ledger's (P2) questions as the `ledger` section.
--
-- It only observes. Every hook calls the game's own function first and returns its results
-- unchanged, and every probe step runs under pcall. Set ENABLED to false once P0 has passed.

FarmLink = FarmLink or {}

local Probe = {
    name = "probe",
    authority = "server",
    ENABLED = true,
    DIR = "_probe",
    FILE_NAME = "probe.json",
    INTERVAL_MS = 10000,
    MAX_SAMPLES = 25,
}
FarmLink.Probe = Probe

local unpack = unpack or table.unpack

local state = nil

local function pack(...)
    return { n = select("#", ...), ... }
end

local function null()
    return FarmLink.Json.null
end

---A JSON-safe rendering of any value: scalars as themselves, nil as null, the rest by type name.
local function describe(value)
    local kind = type(value)
    if kind == "nil" then
        return null()
    end
    if kind == "string" or kind == "boolean" then
        return value
    end
    if kind == "number" then
        if value ~= value or value == math.huge or value == -math.huge then
            return tostring(value)
        end
        return value
    end
    return "<" .. kind .. ">"
end

---Calls fn and reports what happened: { ok, result, result2 } or { ok = false, error }.
local function try(fn, ...)
    if type(fn) ~= "function" then
        return { ok = false, error = "not a function (" .. type(fn) .. ")" }
    end
    local r = pack(pcall(fn, ...))
    if r[1] then
        return { ok = true, result = describe(r[2]), result2 = describe(r[3]) }
    end
    return { ok = false, error = tostring(r[2]) }
end

local function call(object, method, ...)
    if type(object) ~= "table" or type(object[method]) ~= "function" then
        return nil
    end
    local ok, result = pcall(object[method], object, ...)
    if ok then
        return result
    end
    return nil
end

local function count(t)
    local n = 0
    if type(t) == "table" then
        for _ in pairs(t) do
            n = n + 1
        end
    end
    return n
end

local function pushSample(list, sample)
    list[#list + 1] = sample
    if #list > Probe.MAX_SAMPLES then
        table.remove(list, 1)
    end
end

local function round2(value)
    return math.floor(value * 100 + 0.5) / 100
end

local function fillTypeName(index)
    if type(index) ~= "number" then
        return nil
    end
    local name = call(g_fillTypeManager, "getFillTypeNameByIndex", index)
    if type(name) == "string" then
        return name
    end
    return nil
end

local function moneyTypeName(moneyType)
    if type(moneyType) ~= "table" then
        return describe(moneyType)
    end
    return FarmLink.Game.moneyTypeName(moneyType)
end

-- Static sections, computed once per mission ------------------------------------------------------

local function compiles(source)
    local loader = loadstring or load
    if type(loader) ~= "function" then
        return "no loader"
    end
    local ok, chunk = pcall(loader, source)
    return ok and chunk ~= nil
end

local function runtimeSection()
    return {
        version = describe(_VERSION),
        luajit = type(jit) == "table",
        loadstring = type(loadstring),
        gotoStatement = compiles("goto done ::done::"),
        integerDivision = compiles("return 7 // 2"),
        compoundAssignment = compiles("local a = 1 a += 1"),
        setfenv = type(setfenv),
        debugTraceback = type(debug) == "table" and type(debug.traceback) or "no debug library",
        bitLibrary = type(bit),
        bitAND = type(bitAND),
    }
end

local function ioModes(dir)
    if type(io) ~= "table" or type(io.open) ~= "function" then
        return "io.open unavailable"
    end
    local path = dir .. "mode_test.txt"
    FarmLink.FileIO.writeText(path, "seed\n")
    local out = {}
    for _, mode in ipairs({ "w", "wb", "a", "ab", "r", "rb", "r+", "w+" }) do
        local ok, file, err = pcall(io.open, path, mode)
        if ok and file ~= nil then
            out[mode] = "ok"
            pcall(file.close, file)
        elseif ok then
            out[mode] = "refused: " .. tostring(err)
        else
            out[mode] = "error: " .. tostring(file)
        end
    end
    return out
end

---Writes a line, appends a second one, and reads the file back if reads work. If they do not, the
---bridge's --doctor reads append_test.txt instead: two lines means append mode works.
local function appendTest(dir)
    local path = dir .. "append_test.txt"
    local out = { file = Probe.DIR .. "/append_test.txt", expected = "first\\nsecond\\n" }
    out.write = FarmLink.FileIO.writeText(path, "first\n")
    local ok, err = pcall(function()
        local file = assert(io.open(path, "a"))
        file:write("second\n")
        file:close()
    end)
    out.append = ok and "ok" or tostring(err)
    local readOk, content = pcall(function()
        local file = assert(io.open(path, "r"))
        local text = file:read("*a")
        file:close()
        return text
    end)
    out.readBack = readOk and describe(content) or ("unavailable: " .. tostring(content))
    return out
end

local function engineWriteTest(dir)
    if type(createFile) ~= "function" or type(fileWrite) ~= "function" or type(FileAccess) ~= "table" then
        return "createFile/fileWrite/FileAccess unavailable"
    end
    local path = dir .. "engine_write_test.txt"
    local out = try(function()
        local handle = createFile(path, FileAccess.WRITE)
        fileWrite(handle, "engine\n")
        delete(handle)
        return handle
    end)
    out.existsAfter = FarmLink.FileIO.exists(path)
    return out
end

local function deleteTest(dir)
    local FileIO = FarmLink.FileIO
    local out = {}
    local plain = dir .. "delete_test.txt"
    FileIO.writeText(plain, "x")
    out.plain = try(deleteFile, plain)
    out.plain.existsAfter = FileIO.exists(plain)

    local doubled = dir .. "delete_test_doubled.txt"
    FileIO.writeText(doubled, "x")
    out.doubledSlash = try(deleteFile, (string.gsub(doubled, "/([^/]+)$", "//%1")))
    out.doubledSlash.existsAfter = FileIO.exists(doubled)
    return out
end

local function xmlRoundTrip(dir)
    if type(XMLFile) ~= "table" then
        return "XMLFile unavailable"
    end
    local path = dir .. "xml_test.xml"
    return try(function()
        local xml = XMLFile.create("farmLinkProbe", path, "probe")
        xml:setString("probe.value#text", "hello")
        xml:save()
        xml:delete()
        local back = XMLFile.loadIfExists("farmLinkProbe", path)
        if back == nil then
            return nil
        end
        local value = back:getString("probe.value#text")
        back:delete()
        return value
    end)
end

local function dump(t, limit)
    local out = {}
    local n = 0
    if type(t) == "table" then
        for k, v in pairs(t) do
            n = n + 1
            if n > (limit or 60) then
                break
            end
            out[tostring(k)] = describe(v)
        end
    end
    return FarmLink.Json.object(out)
end

local function filesSection(dir)
    return {
        globals = {
            io = type(io),
            ioOpen = type(io) == "table" and type(io.open) or "no io",
            os = type(os),
            createFile = type(createFile),
            fileWrite = type(fileWrite),
            fileRead = type(fileRead),
            createFolder = type(createFolder),
            fileExists = type(fileExists),
            deleteFile = type(deleteFile),
            copyFile = type(copyFile),
            deleteFolder = type(deleteFolder),
            folderExists = type(folderExists),
            getFiles = type(getFiles),
            Files = type(Files),
            renameFile = type(renameFile),
            moveFile = type(moveFile),
            XMLFile = type(XMLFile),
            loadXMLFile = type(loadXMLFile),
            createXMLFile = type(createXMLFile),
            FileAccess = type(FileAccess),
        },
        fileAccess = dump(FileAccess),
        ioModes = ioModes(dir),
        append = appendTest(dir),
        engineWrite = engineWriteTest(dir),
        delete = deleteTest(dir),
        xmlRoundTrip = xmlRoundTrip(dir),
    }
end

local function pathsSection(ctx)
    return {
        g_modSettingsDirectory = describe(g_modSettingsDirectory),
        g_currentModSettingsDirectory = describe(g_currentModSettingsDirectory),
        getUserProfileAppPath = try(getUserProfileAppPath),
        getAppBasePath = try(getAppBasePath),
        modDirectoryAtSource = describe(FarmLink.MOD_DIR),
        modNameAtSource = describe(FarmLink.MOD_NAME),
        resolvedBaseDir = describe(ctx.baseDir),
        resolvedFrom = describe(ctx.baseDirSource),
    }
end

local function renameSection(dir)
    local FileIO = FarmLink.FileIO
    local hasOs = type(os) == "table"
    local out = {
        osRename = hasOs and type(os.rename) or "no os",
        renameFile = type(renameFile),
        moveFile = type(moveFile),
        copyFile = type(copyFile),
    }
    local function attempt(fn, label)
        local src, dst = dir .. label .. "_src.txt", dir .. label .. "_dst.txt"
        FileIO.writeText(src, "x")
        FileIO.delete(dst)
        local result = try(fn, src, dst)
        result.dstExists = FileIO.exists(dst)
        result.srcExists = FileIO.exists(src)
        -- A second rename onto the now-existing target: C rename() refuses that on Windows.
        FileIO.writeText(src, "y")
        result.overExisting = try(fn, src, dst)
        return result
    end
    if hasOs and type(os.rename) == "function" then
        out.osRenameTest = attempt(os.rename, "os_rename")
    end
    if type(renameFile) == "function" then
        out.renameFileTest = attempt(renameFile, "rename_file")
    end
    if type(copyFile) == "function" then
        local src, dst = dir .. "copy_src.txt", dir .. "copy_dst.txt"
        FileIO.writeText(src, "x")
        out.copyFileTest = try(copyFile, src, dst, true)
        out.copyFileTest.dstExists = FileIO.exists(dst)
    end
    return out
end

local function clockSection()
    local Clock = FarmLink.Clock
    local hasOs = type(os) == "table"
    local before, timer = Clock.preciseMs()
    local sum = 0
    for i = 1, 200000 do
        sum = sum + i
    end
    local after = Clock.preciseMs()
    return {
        getDateIso = try(getDate, "%Y-%m-%dT%H:%M:%S"),
        getDateZoneNumeric = try(getDate, "%z"),
        getDateZoneName = try(getDate, "%Z"),
        realTimestamp = Clock.realTimestamp(),
        getTimeSec = try(getTimeSec),
        netGetTime = try(netGetTime),
        getTime = try(getTime),
        osClock = hasOs and try(os.clock) or "no os",
        osTime = hasOs and try(os.time) or "no os",
        osDateUtc = hasOs and try(os.date, "!%Y-%m-%dT%H:%M:%SZ") or "no os",
        g_time = describe(g_time),
        missionTime = describe(g_currentMission ~= nil and g_currentMission.time or nil),
        preciseTimer = describe(timer),
        loop200kMs = (before ~= nil and after ~= nil) and (after - before) or null(),
        loopChecksum = sum,
    }
end

local function moneyTypesList()
    if type(MoneyType) ~= "table" then
        return "MoneyType unavailable"
    end
    local list = {}
    local other = {}
    for name, value in pairs(MoneyType) do
        if type(value) == "table" and value.id ~= nil then
            list[#list + 1] = {
                name = tostring(name),
                id = describe(value.id),
                title = describe(value.title),
                statistic = describe(value.statistic),
            }
        else
            other[#other + 1] = tostring(name) .. ":" .. type(value)
        end
    end
    table.sort(list, function(a, b)
        local idA, idB = tonumber(a.id) or 0, tonumber(b.id) or 0
        if idA == idB then
            return a.name < b.name
        end
        return idA < idB
    end)
    table.sort(other)
    return { types = list, otherMembers = other }
end

local function aiSection()
    local mission = g_currentMission
    local aiSystem = mission ~= nil and mission.aiSystem or nil
    local messages = mission ~= nil and mission.aiMessageManager or nil
    local names = {}
    if type(messages) == "table" and type(messages.messages) == "table" then
        for _, message in ipairs(messages.messages) do
            names[#names + 1] = describe(message.name)
        end
    end
    local messageTypes = type(MessageType) == "table" and MessageType or {}
    return {
        messageTypes = {
            AI_JOB_STARTED = describe(messageTypes.AI_JOB_STARTED),
            AI_JOB_STOPPED = describe(messageTypes.AI_JOB_STOPPED),
            AI_JOB_REMOVED = describe(messageTypes.AI_JOB_REMOVED),
        },
        aiSystem = type(aiSystem),
        stopJobById = type(aiSystem ~= nil and aiSystem.stopJobById or nil),
        getActiveJobs = type(aiSystem ~= nil and aiSystem.getActiveJobs or nil),
        aiMessageManager = type(messages),
        getMessageIndex = type(messages ~= nil and messages.getMessageIndex or nil),
        messageNames = FarmLink.Json.array(names),
        AIMessageSuccessStoppedByUser = type(AIMessageSuccessStoppedByUser),
        AIJobStartRequestEvent = type(AIJobStartRequestEvent),
    }
end

local function fieldSection()
    local farmlands = g_farmlandManager
    local fields = g_fieldManager
    return {
        farmlandManager = type(farmlands),
        getFarmlandIdAtWorldPosition = type(farmlands ~= nil and farmlands.getFarmlandIdAtWorldPosition or nil),
        fieldManager = type(fields),
        fieldCount = count(fields ~= nil and fields.fields or nil),
        farmlandIdFieldMapping = count(fields ~= nil and fields.farmlandIdFieldMapping or nil),
        getFieldById = type(fields ~= nil and fields.getFieldById or nil),
        Combine = type(Combine),
        addCutterArea = type(Combine ~= nil and Combine.addCutterArea or nil),
        registerOverwrittenFunction = type(SpecializationUtil ~= nil and SpecializationUtil.registerOverwrittenFunction or nil),
    }
end

-- Dynamic data -------------------------------------------------------------------------------------

local function playerPosition()
    local vehicle = call(g_localPlayer, "getCurrentVehicle")
    local node = type(vehicle) == "table" and vehicle.rootNode or nil
    if node == nil and type(g_localPlayer) == "table" then
        if type(g_localPlayer.getPosition) == "function" then
            local ok, x, y, z = pcall(g_localPlayer.getPosition, g_localPlayer)
            if ok and type(x) == "number" and type(z) == "number" then
                return x, z, false
            end
        end
        node = g_localPlayer.rootNode
    end
    if node == nil or type(getWorldTranslation) ~= "function" then
        return nil
    end
    local ok, x, _, z = pcall(getWorldTranslation, node)
    if not ok or type(x) ~= "number" then
        return nil
    end
    return x, z, vehicle ~= nil
end

---What the farmland and field lookups return where the player stands (verify-first item 5).
local function sampleHere()
    local x, z, inVehicle = playerPosition()
    if x == nil then
        return "no player position"
    end
    local farmlandId = call(g_farmlandManager, "getFarmlandIdAtWorldPosition", x, z)
    local mapping = g_fieldManager ~= nil and g_fieldManager.farmlandIdFieldMapping or nil
    local field = (type(mapping) == "table" and farmlandId ~= nil) and mapping[farmlandId] or nil
    local fieldId = nil
    local fruit = nil
    if type(field) == "table" then
        fieldId = call(field, "getId") or field.fieldId or field.id
        fruit = type(field.fieldState) == "table" and field.fieldState.fruitTypeIndex or nil
    end
    local fruitDesc = call(g_fruitTypeManager, "getFruitTypeByIndex", fruit)
    return {
        x = round2(x),
        z = round2(z),
        inVehicle = inVehicle == true,
        farmlandId = describe(farmlandId),
        fieldId = describe(fieldId),
        fieldAreaHa = describe(type(field) == "table" and field.areaHa or nil),
        fruitTypeIndex = describe(fruit),
        fruitName = describe(type(fruitDesc) == "table" and fruitDesc.name or nil),
    }
end

local function environmentSection()
    local mission = g_currentMission
    local env = mission ~= nil and mission.environment or nil
    local info = mission ~= nil and mission.missionInfo or nil
    local dynamicInfo = mission ~= nil and mission.missionDynamicInfo or nil
    local user = nil
    if mission ~= nil and mission.userManager ~= nil and mission.playerUserId ~= nil then
        user = call(mission.userManager, "getUserByUserId", mission.playerUserId)
    end
    local vehicles = mission ~= nil and mission.vehicleSystem ~= nil and mission.vehicleSystem.vehicles or nil
    return {
        calendar = {
            currentMonotonicDay = describe(env ~= nil and env.currentMonotonicDay or nil),
            currentDay = describe(env ~= nil and env.currentDay or nil),
            currentYear = describe(env ~= nil and env.currentYear or nil),
            currentPeriod = describe(env ~= nil and env.currentPeriod or nil),
            currentDayInPeriod = describe(env ~= nil and env.currentDayInPeriod or nil),
            daysPerPeriod = describe(env ~= nil and env.daysPerPeriod or nil),
            dayTime = describe(env ~= nil and env.dayTime or nil),
            timeScale = describe(info ~= nil and info.timeScale or nil),
        },
        versions = {
            g_gameVersion = describe(g_gameVersion),
            g_gameVersionDisplay = describe(g_gameVersionDisplay),
            g_gameVersionNotification = describe(g_gameVersionNotification),
            g_minModDescVersion = describe(g_minModDescVersion),
            g_maxModDescVersion = describe(g_maxModDescVersion),
        },
        server = {
            getIsServer = describe(call(mission, "getIsServer")),
            isMultiplayer = describe(dynamicInfo ~= nil and dynamicInfo.isMultiplayer or nil),
            g_server = type(g_server),
            g_client = type(g_client),
            g_dedicatedServer = type(g_dedicatedServer),
            g_dedicatedServerInfo = type(g_dedicatedServerInfo),
        },
        player = {
            g_localPlayer = type(g_localPlayer),
            getCurrentVehicle = type(g_localPlayer ~= nil and g_localPlayer.getCurrentVehicle or nil),
            playerUserId = describe(mission ~= nil and mission.playerUserId or nil),
            uniqueUserId = describe(call(user, "getUniqueUserId")),
        },
        vehicleCount = count(vehicles),
        savegameName = describe(info ~= nil and info.savegameName or nil),
    }
end

-- Hooks --------------------------------------------------------------------------------------------

local function recordAddMoney(s, amount, farmId, moneyType)
    local money = s.money
    money.addMoneyCalls = money.addMoneyCalls + 1
    local name = moneyTypeName(moneyType)
    pushSample(money.samples, {
        amount = describe(amount),
        farmId = describe(farmId),
        moneyType = name,
    })
    if FarmLink.LedgerProbe ~= nil then
        FarmLink.LedgerProbe.recordMoney(name, amount, farmId)
    end
end

---Appended to Farm.changeBalance at file scope. Counts balance changes that did not come through
---addMoney (PLAN_REVIEW.md F4).
function Probe.onChangeBalance(farm, amount, moneyType)
    local s = state
    if s == nil then
        return
    end
    pcall(function()
        local money = s.money
        money.changeBalanceCalls = money.changeBalanceCalls + 1
        if money.depth == 0 then
            money.outsideAddMoney = money.outsideAddMoney + 1
            local trace = null()
            if type(debug) == "table" and type(debug.traceback) == "function" then
                trace = string.sub(debug.traceback("changeBalance outside addMoney", 2), 1, 800)
            end
            pushSample(money.outsideSamples, {
                amount = describe(amount),
                farmId = describe(type(farm) == "table" and farm.farmId or nil),
                moneyType = moneyTypeName(moneyType),
                trace = trace,
            })
        end
    end)
end

local function wrapAddMoney(mission)
    local original = mission.addMoney
    if type(original) ~= "function" then
        return "addMoney missing"
    end
    local hadInstanceField = rawget(mission, "addMoney") ~= nil
    local wrapper = function(self, amount, farmId, moneyType, addChange, forceShowChange)
        local s = state
        if s ~= nil then
            s.money.depth = s.money.depth + 1
        end
        local r = pack(pcall(original, self, amount, farmId, moneyType, addChange, forceShowChange))
        if s ~= nil then
            s.money.depth = s.money.depth - 1
            pcall(recordAddMoney, s, amount, farmId, moneyType)
        end
        if not r[1] then
            error(r[2], 0)
        end
        return unpack(r, 2, r.n)
    end
    mission.addMoney = wrapper
    state.money.wrap = { mission = mission, original = original, wrapper = wrapper, hadInstanceField = hadInstanceField }
    return hadInstanceField and "wrapped (instance already had its own addMoney)" or "wrapped"
end

local function unwrapAddMoney()
    local wrap = state ~= nil and state.money.wrap or nil
    if wrap == nil or rawget(wrap.mission, "addMoney") ~= wrap.wrapper then
        return
    end
    if wrap.hadInstanceField then
        wrap.mission.addMoney = wrap.original
    else
        rawset(wrap.mission, "addMoney", nil)
    end
end

local function jobDetails(kind, job, farmId, reason)
    local vehicle = nil
    if type(job) == "table" and type(job.vehicleParameter) == "table" then
        vehicle = call(job.vehicleParameter, "getVehicle")
    end
    local jobType = nil
    local manager = g_currentMission ~= nil and g_currentMission.aiJobTypeManager or nil
    if type(job) == "table" and job.jobTypeIndex ~= nil then
        local entry = call(manager, "getJobTypeByIndex", job.jobTypeIndex)
        jobType = type(entry) == "table" and entry.name or nil
    end
    return {
        kind = kind,
        jobId = describe(type(job) == "table" and job.jobId or nil),
        jobType = describe(jobType),
        farmId = describe(farmId),
        vehicleId = describe(call(vehicle, "getUniqueId")),
        helper = describe(call(job, "getHelperName")),
        reason = describe(reason),
        day = FarmLink.Clock.gameDay(),
        minute = FarmLink.Clock.minuteOfDay(),
        realTs = FarmLink.Clock.realTimestamp(),
    }
end

local function aiMessageName(aiMessage)
    if aiMessage == nil then
        return "<nil>"
    end
    local manager = g_currentMission ~= nil and g_currentMission.aiMessageManager or nil
    local index = call(manager, "getMessageIndex", aiMessage)
    local entry = (index ~= nil and type(manager.messages) == "table") and manager.messages[index] or nil
    if type(entry) == "table" and entry.name ~= nil then
        return entry.name
    end
    return "<unregistered>"
end

function Probe:onAIJobStarted(job, startFarmId)
    local s = state
    if s ~= nil then
        pcall(function()
            pushSample(s.ai.events, jobDetails("started", job, startFarmId, nil))
        end)
    end
end

function Probe:onAIJobStopped(job, aiMessage)
    local s = state
    if s ~= nil then
        pcall(function()
            local farmId = type(job) == "table" and job.startedFarmId or nil
            pushSample(s.ai.events, jobDetails("stopped", job, farmId, aiMessageName(aiMessage)))
        end)
    end
end

local function subscribeAI()
    if type(g_messageCenter) ~= "table" or type(MessageType) ~= "table" then
        return "g_messageCenter or MessageType missing"
    end
    local subscribed = {}
    if MessageType.AI_JOB_STARTED ~= nil then
        g_messageCenter:subscribe(MessageType.AI_JOB_STARTED, Probe.onAIJobStarted, Probe)
        subscribed[#subscribed + 1] = "AI_JOB_STARTED"
    end
    if MessageType.AI_JOB_STOPPED ~= nil then
        g_messageCenter:subscribe(MessageType.AI_JOB_STOPPED, Probe.onAIJobStopped, Probe)
        subscribed[#subscribed + 1] = "AI_JOB_STOPPED"
    end
    return subscribed
end

local function recordHarvest(s, vehicle, added, fillTypeIndex)
    if type(added) ~= "number" or added <= 0 then
        return
    end
    local harvest = s.harvest
    harvest.calls = harvest.calls + 1
    harvest.liters = harvest.liters + added
    local farmlandId = 0
    if type(vehicle) == "table" and vehicle.rootNode ~= nil then
        local x, _, z = getWorldTranslation(vehicle.rootNode)
        farmlandId = call(g_farmlandManager, "getFarmlandIdAtWorldPosition", x, z) or 0
    end
    local key = tostring(farmlandId) .. ":" .. (fillTypeName(fillTypeIndex) or tostring(fillTypeIndex))
    harvest.litersByFarmlandAndFillType[key] = (harvest.litersByFarmlandAndFillType[key] or 0) + added
end

---Registered over Combine.addCutterArea. The return value is the liters the combine actually added
---(verify-first item 5); it is passed back untouched.
function Probe.addCutterArea(self, superFunc, area, liters, inputFruitType, outputFillType, strawRatio, farmId, cutterLoad)
    local r = pack(superFunc(self, area, liters, inputFruitType, outputFillType, strawRatio, farmId, cutterLoad))
    local s = state
    if s ~= nil then
        pcall(recordHarvest, s, self, r[1], outputFillType)
    end
    return unpack(r, 1, r.n)
end

---Process-wide hooks, installed once from FarmLink.lua at file scope (PLAN_REVIEW.md F7).
function Probe.installProcessHooks()
    if not Probe.ENABLED or Probe.processHooksInstalled then
        return
    end
    Probe.processHooksInstalled = true
    local hasUtils = type(Utils) == "table" and type(Utils.appendedFunction) == "function"

    if hasUtils and type(Farm) == "table" and type(Farm.changeBalance) == "function" then
        Farm.changeBalance = Utils.appendedFunction(Farm.changeBalance, Probe.onChangeBalance)
        Probe.changeBalanceHooked = true
    end

    if
        hasUtils
        and type(Combine) == "table"
        and type(Combine.registerOverwrittenFunctions) == "function"
        and type(SpecializationUtil) == "table"
        and type(SpecializationUtil.registerOverwrittenFunction) == "function"
    then
        Combine.registerOverwrittenFunctions = Utils.appendedFunction(
            Combine.registerOverwrittenFunctions,
            function(vehicleType)
                -- Runs inside the game's vehicle-type setup: a failure here must not reach it.
                local ok = pcall(SpecializationUtil.registerOverwrittenFunction, vehicleType, "addCutterArea", Probe.addCutterArea)
                if ok then
                    Probe.harvestHookTypes = (Probe.harvestHookTypes or 0) + 1
                end
            end
        )
        Probe.harvestHookRegistered = true
    end
end

-- Report -------------------------------------------------------------------------------------------

local function section(name, fn, ...)
    local ok, result = pcall(fn, ...)
    if ok then
        return result
    end
    return { error = name .. ": " .. tostring(result) }
end

---The probe.json document.
---@param ctx table
---@return table
function Probe.report(ctx)
    local Json = FarmLink.Json
    local live = ctx.stats.live
    local money = state.money
    return {
        v = 1,
        generatedAt = FarmLink.Clock.realTimestamp(),
        modVersion = ctx.modVersion,
        sections = {
            runtime = state.static.runtime,
            files = state.static.files,
            paths = state.static.paths,
            rename = state.static.rename,
            clock = state.static.clock,
            liveWrites = {
                writes = live.writes,
                timedWrites = live.timed,
                avgMs = live.timed > 0 and (live.totalMs / live.timed) or null(),
                maxMs = live.maxMs,
                timer = describe(select(2, FarmLink.Clock.preciseMs())),
            },
            money = {
                addMoneyType = type(g_currentMission ~= nil and g_currentMission.addMoney or nil),
                FSBaseMission = type(FSBaseMission),
                FSBaseMissionAddMoney = type(FSBaseMission ~= nil and FSBaseMission.addMoney or nil),
                changeBalanceHooked = Probe.changeBalanceHooked == true,
                addMoneyWrap = state.money.wrapStatus,
                addMoneyCalls = money.addMoneyCalls,
                changeBalanceCalls = money.changeBalanceCalls,
                changeBalanceOutsideAddMoney = money.outsideAddMoney,
                samples = Json.array(money.samples),
                outsideSamples = Json.array(money.outsideSamples),
                moneyTypes = state.static.moneyTypes,
            },
            field = {
                api = state.static.field,
                here = section("here", sampleHere),
                harvestHookRegistered = Probe.harvestHookRegistered == true,
                harvestHookVehicleTypes = Probe.harvestHookTypes or 0,
                harvestCalls = state.harvest.calls,
                harvestLiters = state.harvest.liters,
                litersByFarmlandAndFillType = Json.object(state.harvest.litersByFarmlandAndFillType),
            },
            ai = {
                api = state.static.ai,
                subscribed = state.ai.subscribed,
                events = Json.array(state.ai.events),
            },
            save = {
                hookInstalled = FarmLink.saveHookInstalled == true,
                savegameDirectoryAtLoad = describe(ctx.savegameDirectory),
                ledgerLoadedFrom = describe(ctx.ledger.loadedFrom),
                ledgerWasNew = state.ledgerWasNew,
                saves = Json.array(state.saves),
            },
            world = section("world", environmentSection),
            ledger = section("ledger", function()
                return FarmLink.LedgerProbe ~= nil and FarmLink.LedgerProbe.report() or nil
            end) or null(),
        },
    }
end

function Probe.write(ctx)
    local text = FarmLink.Json.encode(Probe.report(ctx))
    local ok, err = FarmLink.FileIO.writeText(state.dir .. Probe.FILE_NAME, text)
    if not ok then
        error("writing probe.json: " .. tostring(err), 0)
    end
end

function Probe.init(ctx)
    local dirOk, dirErr = FarmLink.FileIO.ensureDir(ctx.baseDir, Probe.DIR)
    if not dirOk then
        error("creating the _probe folder: " .. tostring(dirErr), 0)
    end
    local dir = ctx.baseDir .. Probe.DIR .. "/"
    state = {
        dir = dir,
        throttle = FarmLink.Clock.newThrottle(Probe.INTERVAL_MS),
        ledgerWasNew = ctx.ledger.isNew == true,
        money = {
            depth = 0,
            addMoneyCalls = 0,
            changeBalanceCalls = 0,
            outsideAddMoney = 0,
            samples = {},
            outsideSamples = {},
        },
        ai = { events = {} },
        harvest = { calls = 0, liters = 0, litersByFarmlandAndFillType = {} },
        saves = {},
    }
    state.static = {
        runtime = section("runtime", runtimeSection),
        files = section("files", filesSection, dir),
        paths = section("paths", pathsSection, ctx),
        rename = section("rename", renameSection, dir),
        clock = section("clock", clockSection),
        moneyTypes = section("moneyTypes", moneyTypesList),
        ai = section("ai", aiSection),
        field = section("field", fieldSection),
    }
    state.money.wrapStatus = section("wrapAddMoney", wrapAddMoney, g_currentMission)
    state.ai.subscribed = section("subscribeAI", subscribeAI)
    Probe.write(ctx)
    FarmLink.Log.info("P0 probe active; writing %s%s", dir, Probe.FILE_NAME)
end

function Probe.update(dt, ctx)
    if state.throttle:tick(dt) then
        Probe.write(ctx)
    end
end

function Probe.onSave(ctx, missionInfo)
    local directory = type(missionInfo) == "table" and missionInfo.savegameDirectory or nil
    local xmlPath = directory ~= nil and FarmLink.Persistence.path(directory) or nil
    pushSample(state.saves, {
        savegameDirectory = describe(directory),
        persisted = describe(ctx.lastSave ~= nil and ctx.lastSave.ok or nil),
        persistError = describe(ctx.lastSave ~= nil and ctx.lastSave.err or nil),
        farmLinkXmlExists = xmlPath ~= nil and FarmLink.FileIO.exists(xmlPath) or false,
        realTs = FarmLink.Clock.realTimestamp(),
    })
    Probe.write(ctx)
end

function Probe.shutdown(ctx)
    if state == nil then
        return
    end
    -- Modules shut down in reverse order, so the ledger probe is still running: let it finish first.
    if FarmLink.LedgerProbe ~= nil and type(FarmLink.LedgerProbe.finish) == "function" then
        pcall(FarmLink.LedgerProbe.finish)
    end
    pcall(Probe.write, ctx)
    unwrapAddMoney()
    if type(g_messageCenter) == "table" and type(g_messageCenter.unsubscribeAll) == "function" then
        pcall(g_messageCenter.unsubscribeAll, g_messageCenter, Probe)
    end
    state = nil
end
