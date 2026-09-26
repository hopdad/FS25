-- A stand-in for the FS25 engine, enough to run FarmLink's Lua outside the game: under busted for the
-- specs, and from sim/run.lua for the end-to-end test that validates the mod's files against
-- packages/schema. It mirrors the API shapes recorded in docs/VERIFY_FIRST.md; it does not model the
-- game's behavior beyond that.

local lfs = require("lfs")

local Engine = {}

local HERE = debug.getinfo(1, "S").source:match("^@(.*/)") or "./"
Engine.MOD_DIR = HERE .. "../FS25_FarmLink/"

local function mkdirs(path)
    local current = ""
    for part in path:gmatch("[^/]+") do
        current = current .. "/" .. part
        lfs.mkdir(current)
    end
end

---A fresh empty directory with a trailing slash.
function Engine.tempDir(prefix)
    local name = os.tmpname()
    os.remove(name)
    local dir = name .. "_" .. (prefix or "farmlink") .. "/"
    mkdirs(dir)
    return dir
end

function Engine.readFile(path)
    local file = io.open(path, "r")
    if file == nil then
        return nil
    end
    local text = file:read("*a")
    file:close()
    return text
end

-- Utils -------------------------------------------------------------------------------------------

local Utils = {}

function Utils.appendedFunction(oldFunc, newFunc)
    if oldFunc == nil then
        return newFunc
    end
    return function(...)
        oldFunc(...)
        newFunc(...)
    end
end

function Utils.prependedFunction(oldFunc, newFunc)
    if oldFunc == nil then
        return newFunc
    end
    return function(...)
        newFunc(...)
        oldFunc(...)
    end
end

function Utils.overwrittenFunction(oldFunc, newFunc)
    return function(self, ...)
        return newFunc(self, oldFunc, ...)
    end
end

-- XMLFile: a key-value store written as "path<TAB>value" lines. Not XML; only the API shape matters.

local XMLFile = {}
XMLFile.__index = XMLFile

function XMLFile.create(_objectName, path, rootName)
    return setmetatable({ path = path, root = rootName, values = {} }, XMLFile)
end

function XMLFile.loadIfExists(_objectName, path)
    local text = Engine.readFile(path)
    if text == nil then
        return nil
    end
    local xml = setmetatable({ path = path, values = {} }, XMLFile)
    for line in text:gmatch("[^\n]+") do
        local key, value = line:match("^([^\t]+)\t(.*)$")
        if key ~= nil then
            xml.values[key] = value
        end
    end
    return xml
end

function XMLFile:setString(key, value)
    self.values[key] = tostring(value)
end

function XMLFile:setInt(key, value)
    self.values[key] = string.format("%d", value)
end

function XMLFile:getString(key, default)
    local value = self.values[key]
    if value == nil then
        return default
    end
    return value
end

function XMLFile:getInt(key, default)
    local value = tonumber(self.values[key])
    if value == nil then
        return default
    end
    return value
end

function XMLFile:save()
    local keys = {}
    for key in pairs(self.values) do
        keys[#keys + 1] = key
    end
    table.sort(keys)
    local file = assert(io.open(self.path, "w"))
    for _, key in ipairs(keys) do
        file:write(key, "\t", self.values[key], "\n")
    end
    file:close()
end

function XMLFile:delete() end

-- Message center ----------------------------------------------------------------------------------

local MessageCenter = {}
MessageCenter.__index = MessageCenter

function MessageCenter.new()
    return setmetatable({ subscribers = {} }, MessageCenter)
end

function MessageCenter:subscribe(messageType, callback, target)
    self.subscribers[#self.subscribers + 1] = { messageType = messageType, callback = callback, target = target }
end

function MessageCenter:unsubscribeAll(target)
    for i = #self.subscribers, 1, -1 do
        if self.subscribers[i].target == target then
            table.remove(self.subscribers, i)
        end
    end
end

function MessageCenter:publish(messageType, ...)
    for _, entry in ipairs(self.subscribers) do
        if entry.messageType == messageType then
            if entry.target ~= nil then
                entry.callback(entry.target, ...)
            else
                entry.callback(...)
            end
        end
    end
end

-- Farms and money ---------------------------------------------------------------------------------

local Farm = {}
Farm.__index = Farm

function Farm.new(farmId, balance)
    return setmetatable({ farmId = farmId, money = balance, loan = 0 }, Farm)
end

function Farm:changeBalance(amount, _moneyType)
    self.money = self.money + amount
end

function Farm:getBalance()
    return self.money
end

-- Vehicles ----------------------------------------------------------------------------------------

local FILL_TYPES = { "UNKNOWN", "DIESEL", "WHEAT", "DEF", "AIR", "SEEDS", "BARLEY" }
local FILL_TYPE_INDEX = {}
for index, name in ipairs(FILL_TYPES) do
    FILL_TYPE_INDEX[name] = index
end

local Vehicle = {}
Vehicle.__index = Vehicle

function Vehicle:getUniqueId()
    return self.uniqueId
end

function Vehicle:getFullName()
    return self.fullName
end

function Vehicle:getLastSpeed()
    return self.speedKmh
end

function Vehicle:getMotor()
    return self.motor
end

function Vehicle:getMotorState()
    return self.motorState
end

function Vehicle:getDamageAmount()
    return self.damage
end

function Vehicle:getIsAIActive()
    return self.isAI == true
end

function Vehicle:getFillUnitCapacity(index)
    return self.spec_fillUnit.fillUnits[index].capacity
end

function Vehicle:getFillUnitFillLevel(index)
    return self.spec_fillUnit.fillUnits[index].fillLevel
end

function Vehicle:getFillUnitFillLevelPercentage(index)
    local unit = self.spec_fillUnit.fillUnits[index]
    if unit.capacity == 0 then
        return 0
    end
    return unit.fillLevel / unit.capacity
end

function Vehicle:getAttachedImplements()
    local out = {}
    for _, implement in ipairs(self.implements) do
        out[#out + 1] = { object = implement }
    end
    return out
end

local Motor = {}
Motor.__index = Motor

function Motor:getLastMotorRpm()
    return self.rpm
end

function Motor:getGearToDisplay()
    return self.gear
end

---A vehicle with the specs FarmLink reads. opts.fillUnits entries are { fillType, level, capacity };
---opts.fuel is { fillType, level, capacity } and becomes a motor consumer.
function Engine.newVehicle(opts)
    local vehicle = setmetatable({
        uniqueId = opts.uniqueId,
        fullName = opts.name or "Test Vehicle",
        typeName = opts.typeName or "tractor",
        speedKmh = opts.speedKmh or 0,
        operatingTime = opts.operatingTimeMs,
        damage = opts.damage,
        isAI = opts.isAI,
        motorState = opts.motorState or 4,
        implements = opts.implements or {},
        rootNode = {
            x = opts.x or 0,
            y = opts.y or 100,
            z = opts.z or 0,
            dirX = opts.dirX or 0,
            dirZ = opts.dirZ or -1,
        },
    }, Vehicle)

    local units = {}
    for _, unit in ipairs(opts.fillUnits or {}) do
        units[#units + 1] = {
            fillType = FILL_TYPE_INDEX[unit.fillType or "UNKNOWN"],
            fillLevel = unit.level,
            capacity = unit.capacity,
            showOnInfoHud = unit.showOnInfoHud,
        }
    end
    if opts.fuel ~= nil then
        units[#units + 1] = {
            fillType = FILL_TYPE_INDEX[opts.fuel.fillType],
            fillLevel = opts.fuel.level,
            capacity = opts.fuel.capacity,
        }
        vehicle.spec_motorized = {
            consumersByFillType = { [FILL_TYPE_INDEX[opts.fuel.fillType]] = { fillUnitIndex = #units } },
            propellantFillUnitIndices = { #units },
        }
        vehicle.motor = setmetatable({ rpm = opts.rpm or 0, gear = opts.gear }, Motor)
    end
    vehicle.spec_fillUnit = { fillUnits = units }
    return vehicle
end

-- AI ----------------------------------------------------------------------------------------------

local function messageClass(name)
    local class = { name = name }
    class.new = function()
        return setmetatable({}, { __index = class, class = class })
    end
    return class
end

Engine.AIMessages = {
    ERROR_OUT_OF_FUEL = messageClass("ERROR_OUT_OF_FUEL"),
    SUCCESS_STOPPED_BY_USER = messageClass("SUCCESS_STOPPED_BY_USER"),
}

local function newAIMessageManager()
    local manager = { messages = {} }
    for _, name in ipairs({ "ERROR_OUT_OF_FUEL", "SUCCESS_STOPPED_BY_USER" }) do
        manager.messages[#manager.messages + 1] = { name = name, classObject = Engine.AIMessages[name] }
    end
    function manager:getMessageIndex(message)
        local mt = getmetatable(message)
        for index, entry in ipairs(self.messages) do
            if mt ~= nil and mt.class == entry.classObject then
                return index
            end
        end
        return nil
    end
    return manager
end

function Engine.newJob(jobId, vehicle, farmId)
    return {
        jobId = jobId,
        jobTypeIndex = 1,
        startedFarmId = farmId or 1,
        vehicleParameter = {
            getVehicle = function()
                return vehicle
            end,
        },
        getHelperName = function()
            return "Alex"
        end,
    }
end

function Engine.startJob(job)
    g_messageCenter:publish(MessageType.AI_JOB_STARTED, job, job.startedFarmId)
end

function Engine.stopJob(job, message)
    g_messageCenter:publish(MessageType.AI_JOB_STOPPED, job, message)
end

-- Mission -----------------------------------------------------------------------------------------

local Mission = {}
Mission.__index = Mission

function Mission:getIsServer()
    return self.isServer
end

function Mission:addMoney(amount, farmId, moneyType, _addChange, _forceShowChange)
    if farmId == 0 then
        return
    end
    local farm = self.farms[farmId]
    if farm ~= nil then
        farm:changeBalance(amount, moneyType)
    end
end

local function newMission(opts)
    local mission = setmetatable({
        isServer = opts.isServer ~= false,
        missionInfo = {
            savegameDirectory = opts.savegameDirectory,
            savegameName = opts.savegameName or "Riverbend Springs",
            savegameIndex = opts.savegameIndex or 1,
            timeScale = opts.timeScale or 5,
        },
        missionDynamicInfo = { isMultiplayer = opts.isMultiplayer == true },
        environment = {
            currentMonotonicDay = opts.day or 37,
            currentDay = opts.day or 37,
            currentYear = 2,
            currentPeriod = 4,
            currentDayInPeriod = 1,
            daysPerPeriod = 3,
            dayTime = opts.dayTimeMs or (14 * 3600000 + 5 * 60000),
        },
        farms = { [1] = Farm.new(1, 100000) },
        vehicleSystem = { vehicles = {} },
        aiSystem = {
            stopJobById = function()
                return true
            end,
            getActiveJobs = function()
                return {}
            end,
        },
        aiMessageManager = newAIMessageManager(),
        aiJobTypeManager = {
            jobTypes = { { name = "FIELDWORK" } },
            getJobTypeByIndex = function(self, index)
                return self.jobTypes[index]
            end,
        },
        time = 0,
    }, Mission)
    return mission
end

-- Installation ------------------------------------------------------------------------------------

---Sets every engine global FarmLink touches and returns the engine state. opts.profileDir is the
---user profile folder (a fresh temp folder by default).
function Engine.install(opts)
    opts = opts or {}
    local profileDir = opts.profileDir or Engine.tempDir("profile")
    mkdirs(profileDir .. "modSettings")

    Engine.profileDir = profileDir
    Engine.listeners = {}
    Engine.saveCalls = 0
    Engine.logLines = {}

    FarmLink = nil
    g_currentMission = nil

    source = function(path)
        dofile(path)
    end
    g_currentModName = "FS25_FarmLink"
    g_currentModDirectory = Engine.MOD_DIR
    addModEventListener = function(listener)
        Engine.listeners[#Engine.listeners + 1] = listener
    end
    Logging = {
        info = function(fmt, ...)
            Engine.logLines[#Engine.logLines + 1] = "INFO " .. string.format(fmt, ...)
        end,
        warning = function(fmt, ...)
            Engine.logLines[#Engine.logLines + 1] = "WARNING " .. string.format(fmt, ...)
        end,
        error = function(fmt, ...)
            Engine.logLines[#Engine.logLines + 1] = "ERROR " .. string.format(fmt, ...)
        end,
    }
    _G.Utils = Utils

    if opts.noModSettingsGlobal then
        g_modSettingsDirectory = nil
    else
        g_modSettingsDirectory = profileDir .. "modSettings/"
    end
    getUserProfileAppPath = function()
        return profileDir
    end
    createFolder = function(path)
        lfs.mkdir((path:gsub("/+$", "")))
    end
    fileExists = function(path)
        return lfs.attributes(path, "mode") == "file"
    end
    deleteFile = function(path)
        -- The game refuses a path containing "//" (VERIFY_FIRST.md, 1).
        if path:find("//", 1, true) == nil then
            os.remove(path)
        end
    end
    copyFile = nil
    createFile = nil
    fileWrite = nil
    FileAccess = nil
    netGetTime = nil
    getDate = function(format)
        return os.date(format)
    end
    getTimeSec = function()
        return os.clock()
    end
    getTime = function()
        return os.time() * 1000
    end
    getMD5 = function(text)
        -- Not MD5: a deterministic 32-hex digest, which is all Ids needs.
        local h1, h2, h3, h4 = 2166136261, 16777619, 3141592653, 2718281829
        for i = 1, #text do
            local b = text:byte(i)
            h1 = (h1 * 31 + b) % 4294967296
            h2 = (h2 * 37 + b + i) % 4294967296
            h3 = (h3 * 41 + b * 7) % 4294967296
            h4 = (h4 * 43 + b * 13 + i) % 4294967296
        end
        return string.format("%08x%08x%08x%08x", h1, h2, h3, h4)
    end

    _G.XMLFile = XMLFile
    MessageType = { HOUR_CHANGED = 1, DAY_CHANGED = 2, PERIOD_CHANGED = 3, AI_JOB_STARTED = 101, AI_JOB_STOPPED = 102, AI_JOB_REMOVED = 103 }
    g_messageCenter = MessageCenter.new()
    MoneyType = {
        OTHER = { id = 1, title = "finance_other", statistic = "other" },
        AI = { id = 2, title = "finance_wagePayment", statistic = "wagePayment" },
        SOLD_PRODUCTS = { id = 3, title = "finance_soldProducts", statistic = "soldProducts" },
        PURCHASE_FUEL = { id = 4, title = "finance_purchaseFuel", statistic = "purchaseFuel" },
        register = function() end,
    }
    _G.Farm = Farm
    FSCareerMissionInfo = {
        saveToXMLFile = function(_missionInfo)
            Engine.saveCalls = Engine.saveCalls + 1
        end,
    }
    Engine.combineTypeHooks = {}
    Combine = {
        addCutterArea = function(_self, _area, liters)
            return liters
        end,
        registerOverwrittenFunctions = function(_vehicleType) end,
    }
    SpecializationUtil = {
        registerOverwrittenFunction = function(vehicleType, name, fn)
            vehicleType.overwritten = vehicleType.overwritten or {}
            vehicleType.overwritten[name] = fn
        end,
    }
    FillType = FILL_TYPE_INDEX
    g_fillTypeManager = {
        getFillTypeNameByIndex = function(_self, index)
            return FILL_TYPES[index]
        end,
    }
    g_fruitTypeManager = {
        getFruitTypeByIndex = function(_self, index)
            if index == 3 then
                return { name = "WHEAT" }
            end
            return nil
        end,
    }
    local field12 = { fieldId = 12, areaHa = 4.2, fieldState = { fruitTypeIndex = 3 } }
    g_fieldManager = { fields = { [12] = field12 }, farmlandIdFieldMapping = { [12] = field12 } }
    g_farmlandManager = {
        getFarmlandIdAtWorldPosition = function(_self, x, _z)
            if x >= 0 then
                return 12
            end
            return 0
        end,
    }
    getWorldTranslation = function(node)
        return node.x, node.y, node.z
    end
    localDirectionToWorld = function(node, _x, _y, _z)
        return node.dirX, 0, node.dirZ
    end
    g_localPlayer = {
        vehicle = nil,
        getCurrentVehicle = function(self)
            return self.vehicle
        end,
    }
    g_gameVersionDisplay = "1.12.0.0"
    g_dedicatedServer = nil
    g_dedicatedServerInfo = nil
    return Engine
end

---Sources the mod the way the game does when a savegame with the mod enabled is started.
function Engine.loadMod()
    source(Engine.MOD_DIR .. "scripts/FarmLink.lua")
end

---Simulates the vehicle-type finalization that happens during map load.
function Engine.finalizeCombineType()
    local vehicleType = {}
    Combine.registerOverwrittenFunctions(vehicleType)
    return vehicleType
end

function Engine.loadMission(opts)
    g_currentMission = newMission(opts or {})
    for _, listener in ipairs(Engine.listeners) do
        listener:loadMap("map.xml")
    end
    return g_currentMission
end

function Engine.unloadMission()
    for _, listener in ipairs(Engine.listeners) do
        listener:deleteMap()
    end
    g_currentMission = nil
end

---Runs update(dt) for the given number of real seconds and advances the in-game clock.
function Engine.run(seconds, dtMs)
    dtMs = dtMs or 16
    local steps = math.floor(seconds * 1000 / dtMs)
    for _ = 1, steps do
        local env = g_currentMission.environment
        env.dayTime = (env.dayTime + dtMs * g_currentMission.missionInfo.timeScale) % 86400000
        for _, listener in ipairs(Engine.listeners) do
            listener:update(dtMs)
        end
    end
end

---Saves the career. A never-saved career gets a savegame folder first, as the game does.
function Engine.saveCareer()
    local info = g_currentMission.missionInfo
    if info.savegameDirectory == nil then
        info.savegameDirectory = Engine.profileDir .. "savegame" .. tostring(info.savegameIndex)
        mkdirs(info.savegameDirectory)
    end
    FSCareerMissionInfo.saveToXMLFile(info)
end

return Engine
