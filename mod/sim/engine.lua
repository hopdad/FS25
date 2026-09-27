-- A stand-in for the FS25 engine, enough to run FarmLink's Lua outside the game: under busted for the
-- specs, and from sim/run.lua for the end-to-end tests that check the mod's files against
-- packages/schema and drive the command channel with files the bridge wrote. It mirrors the API
-- shapes recorded in docs/VERIFY_FIRST.md; it does not model the game's behavior beyond that.

local lfs = require("lfs")
local Xml = require("xml")

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

function Engine.writeFile(path, text)
    local file = assert(io.open(path, "w"))
    file:write(text)
    file:close()
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

-- XMLFile, backed by a real XML document (sim/xml.lua) -----------------------------------------------

local XMLFile = {}
XMLFile.__index = XMLFile

function XMLFile.create(_objectName, path, rootName)
    return setmetatable({ path = path, root = Xml.newRoot(rootName) }, XMLFile)
end

---nil for a missing or unparsable file, as the game does.
function XMLFile.loadIfExists(_objectName, path)
    local text = Engine.readFile(path)
    if text == nil then
        return nil
    end
    local ok, root = pcall(Xml.parse, text)
    if not ok then
        return nil
    end
    return setmetatable({ path = path, root = root }, XMLFile)
end

function XMLFile:getString(path, default)
    local value = Xml.get(self.root, path)
    if value == nil then
        return default
    end
    return value
end

function XMLFile:getInt(path, default)
    local value = tonumber(Xml.get(self.root, path))
    if value == nil then
        return default
    end
    return math.floor(value)
end

function XMLFile:getFloat(path, default)
    local value = tonumber(Xml.get(self.root, path))
    if value == nil then
        return default
    end
    return value
end

function XMLFile:getBool(path, default)
    local value = Xml.get(self.root, path)
    if value == "true" then
        return true
    elseif value == "false" then
        return false
    end
    return default
end

function XMLFile:setString(path, value)
    Xml.set(self.root, path, tostring(value))
end

function XMLFile:setInt(path, value)
    Xml.set(self.root, path, string.format("%d", value))
end

function XMLFile:setFloat(path, value)
    Xml.set(self.root, path, string.format("%.6g", value))
end

function XMLFile:setBool(path, value)
    Xml.set(self.root, path, value and "true" or "false")
end

function XMLFile:hasProperty(path)
    local node, attribute = Xml.resolve(self.root, path, false)
    if node == nil then
        return false
    end
    if attribute ~= nil then
        return node.attributes[attribute] ~= nil
    end
    return true
end

---Calls fn(index, key) for base(0), base(1), ... while they exist; index counts from 1.
function XMLFile:iterate(basePath, fn)
    local i = 0
    while true do
        local key = string.format("%s(%d)", basePath, i)
        if not self:hasProperty(key) then
            return
        end
        if fn(i + 1, key) == false then
            return
        end
        i = i + 1
    end
end

function XMLFile:save()
    Engine.writeFile(self.path, Xml.serialize(self.root))
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

-- FinanceStats buckets, one per statistic name. FarmStats keeps the period being played in
-- `finances` and archives it onto `financesHistory` (oldest first) on PERIOD_CHANGED.
local FINANCE_STAT_NAMES = {
    "newVehiclesCost",
    "soldVehicles",
    "soldProducts",
    "purchaseFuel",
    "purchaseSeeds",
    "purchaseFertilizer",
    "vehicleRunningCost",
    "vehicleLeasingCost",
    "wagePayment",
    "other",
}

local function newFarmStats()
    local stats = { finances = {}, financesHistory = {} }
    function stats:archiveFinances()
        self.financesHistory[#self.financesHistory + 1] = self.finances
        self.finances = {}
    end
    return stats
end

local Farm = {}
Farm.__index = Farm

function Farm.new(farmId, balance, name)
    return setmetatable({ farmId = farmId, money = balance, loan = 0, name = name, stats = newFarmStats() }, Farm)
end

function Farm:changeBalance(amount, moneyType)
    self.money = self.money + amount
    local statistic = type(moneyType) == "table" and moneyType.statistic or "other"
    self.stats.finances[statistic] = (self.stats.finances[statistic] or 0) + amount
end

function Farm:getBalance()
    return self.money
end

local function newFarmManager()
    local manager = { farms = {}, byId = {} }
    function manager:add(farm)
        self.farms[#self.farms + 1] = farm
        self.byId[farm.farmId] = farm
        return farm
    end
    function manager:getFarmById(farmId)
        return self.byId[farmId]
    end
    function manager:updateFarmStats(farmId, statName, delta)
        self.stats[farmId] = self.stats[farmId] or {}
        self.stats[farmId][statName] = (self.stats[farmId][statName] or 0) + delta
    end
    manager.stats = {}
    -- Like the game, the list starts with the spectator farm and holds the unnamed guided-tour farm.
    local spectator = manager:add(Farm.new(0, 0, "Spectator"))
    spectator.isSpectator = true
    manager:add(Farm.new(1, 100000, "Riverbend Farms"))
    manager:add(Farm.new(14, 0, nil))
    -- The farms' statistics subscribe when the map loads, before any mod does.
    g_messageCenter:subscribe(MessageType.PERIOD_CHANGED, function()
        for _, farm in ipairs(manager.farms) do
            farm.stats:archiveFinances()
        end
    end, manager)
    return manager
end

-- Fill types --------------------------------------------------------------------------------------

local FILL_TYPES = { "UNKNOWN", "DIESEL", "WHEAT", "DEF", "AIR", "SEEDS", "BARLEY", "FLOUR", "LIQUIDFERTILIZER", "HERBICIDE" }
local FILL_TYPE_INDEX = {}
for index, name in ipairs(FILL_TYPES) do
    FILL_TYPE_INDEX[name] = index
end

-- Vehicles ----------------------------------------------------------------------------------------

-- vehicles/VehiclePropertyState.lua
local PROPERTY_OWNED = 2
local PROPERTY_LEASED = 3

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

---Wearable:repairVehicle: pays for the repair and clears the damage.
function Vehicle:repairVehicle(_atSellingPoint)
    g_currentMission:addMoney(-(self.repairPrice or 1840), self:getOwnerFarmId(), MoneyType.VEHICLE_REPAIR, true, true)
    self.damage = 0
end

function Vehicle:getOwnerFarmId()
    return self.farmId
end

function Vehicle:getRootVehicle()
    return self.rootVehicle or self
end

function Vehicle:getShowInVehiclesOverview()
    return self.listed ~= false and (self.propertyState == PROPERTY_OWNED or self.propertyState == PROPERTY_LEASED)
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

local function adopt(vehicle, root)
    for _, implement in ipairs(vehicle.implements) do
        implement.rootVehicle = root
        adopt(implement, root)
    end
end

---A vehicle with the specs FarmLink reads. opts.fillUnits entries are { fillType, level, capacity };
---opts.fuel is { fillType, level, capacity } and makes it motorized. opts.implements are attached.
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
        farmId = opts.farmId or 1,
        listed = opts.listed,
        propertyState = opts.propertyState or PROPERTY_OWNED,
        implements = opts.implements or {},
        rootNode = {
            x = opts.x or 0,
            y = opts.y or 100,
            z = opts.z or 0,
            dirX = opts.dirX or 0,
            dirZ = opts.dirZ or -1,
        },
    }, Vehicle)
    vehicle.rootVehicle = vehicle
    adopt(vehicle, vehicle)

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
        vehicle.spec_enterable = { isControlled = opts.entered == true, isEntered = opts.entered == true }
    end
    vehicle.spec_fillUnit = { fillUnits = units }
    return vehicle
end

---Adds a vehicle and everything attached to it to the mission's vehicle list.
function Engine.addVehicle(vehicle)
    local list = g_currentMission.vehicleSystem.vehicles
    list[#list + 1] = vehicle
    g_messageCenter:publish(MessageType.VEHICLE_ADDED)
    for _, implement in ipairs(vehicle.implements) do
        Engine.addVehicle(implement)
    end
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
    ERROR_UNLOADINGSTATION_FULL = messageClass("ERROR_UNLOADINGSTATION_FULL"),
    SUCCESS_FINISHED_JOB = messageClass("SUCCESS_FINISHED_JOB"),
    SUCCESS_STOPPED_BY_USER = messageClass("SUCCESS_STOPPED_BY_USER"),
}

local function newAIMessageManager()
    local manager = { messages = {} }
    for _, name in ipairs({
        "ERROR_OUT_OF_FUEL",
        "ERROR_UNLOADINGSTATION_FULL",
        "SUCCESS_FINISHED_JOB",
        "SUCCESS_STOPPED_BY_USER",
    }) do
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

---The AI system's start and stop paths: both publish the same messages the game does.
local function newAISystem()
    local system = { activeJobs = {}, nextJobId = 1 }
    function system:getActiveJobs()
        return self.activeJobs
    end
    function system:getJobById(jobId)
        for _, job in ipairs(self.activeJobs) do
            if job.jobId == jobId then
                return job
            end
        end
        return nil
    end
    function system:startJob(job, startFarmId)
        if job.jobId == nil then
            job.jobId = self.nextJobId
        end
        self.nextJobId = math.max(self.nextJobId, job.jobId) + 1
        job.startedFarmId = startFarmId
        self.activeJobs[#self.activeJobs + 1] = job
        if job.vehicle ~= nil then
            job.vehicle.isAI = true
        end
        g_messageCenter:publish(MessageType.AI_JOB_STARTED, job, startFarmId)
    end
    function system:stopJob(job, aiMessage)
        if type(job.stop) == "function" then
            job:stop(aiMessage)
        end
        for i, active in ipairs(self.activeJobs) do
            if active == job then
                table.remove(self.activeJobs, i)
                break
            end
        end
        if job.vehicle ~= nil then
            job.vehicle.isAI = false
        end
        g_messageCenter:publish(MessageType.AI_JOB_STOPPED, job, aiMessage)
    end
    return system
end

---A field-work job for a vehicle. jobId may be nil; the AI system assigns one on start.
-- AIJob as the game has it: wages accrue in updateCost every frame and are booked once they pass
-- 25, and whatever is left when the job stops (ai/jobs/AIJob.lua). A fresh class per install, since
-- mods hook the class itself.
local function newAIJobClass()
    local AIJobClass = {}
    AIJobClass.__index = AIJobClass

    function AIJobClass:updateCost(dt)
        self.pendingCost = (self.pendingCost or 0) + 0.0004 * dt * (self.costScale or 1)
        if self.pendingCost > 25 then
            g_currentMission:addMoney(-self.pendingCost, self.startedFarmId, MoneyType.AI, true)
            self.pendingCost = 0
        end
    end

    function AIJobClass:stop(_aiMessage)
        if (self.pendingCost or 0) > 0 then
            g_currentMission:addMoney(-self.pendingCost, self.startedFarmId, MoneyType.AI, true)
            self.pendingCost = 0
        end
    end
    return AIJobClass
end

-- The work-area specializations that buy inputs for a hired worker. The game dispatches their
-- listeners by name at call time (SpecializationUtil.raiseEvent), so a mod can wrap them.
-- SowingMachine books bought seed in onEndWorkAreaProcessing, after the seedUsage stat; Sprayer books
-- bought fertilizer in getExternalFill, which onStartWorkAreaProcessing calls, and reports its
-- hectares and usage in onEndWorkAreaProcessing.
local function newSowingMachine()
    local Spec = {}
    function Spec.onEndWorkAreaProcessing(self, _dt, _hasProcessed)
        local spec = self.spec_sowingMachine
        local params = spec.workAreaParameters
        if params.lastChangedArea > 0 then
            local farmId = self:getOwnerFarmId()
            local ha = MathUtil.areaToHa(params.lastStatsArea, g_currentMission:getFruitPixelsToSqm())
            g_farmManager:updateFarmStats(farmId, "seedUsage", params.usage or 0)
            g_farmManager:updateFarmStats(farmId, "sownHectares", ha)
            if self:getIsAIActive() and g_currentMission.missionInfo.helperBuySeeds then
                g_currentMission:addMoney(-(params.inputPrice or 0), farmId, MoneyType.PURCHASE_SEEDS)
            end
        end
    end
    return Spec
end

-- Cultivator and Plow report their hectares from onEndWorkAreaProcessing, like the others.
local function newTillageSpec(specKey, statName)
    local Spec = {}
    function Spec.onEndWorkAreaProcessing(self, _dt)
        local params = self[specKey].workAreaParameters
        if params.lastStatsArea > 0 then
            local ha = MathUtil.areaToHa(params.lastStatsArea, g_currentMission:getFruitPixelsToSqm())
            g_farmManager:updateFarmStats(self:getOwnerFarmId(), statName, ha)
        end
    end
    return Spec
end

local function newSprayer()
    local Spec = {}
    function Spec.onStartWorkAreaProcessing(self, _dt)
        local params = self.spec_sprayer.workAreaParameters
        -- getExternalFill: a hired worker buys what it sprays.
        if self:getIsAIActive() and g_currentMission.missionInfo.helperBuyFertilizer then
            g_currentMission:addMoney(-(params.inputPrice or 0), self:getOwnerFarmId(), MoneyType.PURCHASE_FERTILIZER)
            params.sprayFillType = params.pendingFillType
            params.usage = params.pendingUsage
        end
    end
    function Spec.onEndWorkAreaProcessing(self, _dt, _hasProcessed)
        local params = self.spec_sprayer.workAreaParameters
        local farmId = self:getOwnerFarmId()
        g_farmManager:updateFarmStats(farmId, "sprayedHectares", MathUtil.areaToHa(params.lastStatsArea, 1))
        g_farmManager:updateFarmStats(farmId, "sprayUsage", params.usage or 0)
    end
    return Spec
end

function Engine.newJob(jobId, vehicle, farmId, opts)
    opts = opts or {}
    local job = {
        jobId = jobId,
        jobTypeIndex = 1,
        startedFarmId = farmId or 1,
        vehicle = vehicle,
        vehicleParameter = {
            getVehicle = function()
                return vehicle
            end,
        },
        positionAngleParameter = {
            getPosition = function()
                return opts.x or 10, opts.z or 10
            end,
        },
    }
    job.costScale = opts.costScale
    function job:getHelperName()
        return opts.helper or "Alex"
    end
    return setmetatable(job, AIJob)
end

function Engine.startJob(job)
    g_currentMission.aiSystem:startJob(job, job.startedFarmId)
end

function Engine.stopJob(job, message)
    g_currentMission.aiSystem:stopJob(job, message)
end

-- Economy -----------------------------------------------------------------------------------------

-- A selling point: sellFillType credits the sale through addMoney and returns the price, as in the
-- game (TransactionLog's notes on SellingStation.sellFillType).
SellingStation = {}
SellingStation.__index = SellingStation

function SellingStation.new(uniqueId, name, pricesPerLiter)
    local accepted = {}
    for fillType in pairs(pricesPerLiter) do
        accepted[FILL_TYPE_INDEX[fillType]] = true
    end
    return setmetatable({
        isSellingPoint = true,
        acceptedFillTypes = accepted,
        pricesPerLiter = pricesPerLiter,
        name = name,
        owningPlaceable = {
            getUniqueId = function()
                return uniqueId
            end,
        },
    }, SellingStation)
end

function SellingStation:getName()
    return self.name
end

function SellingStation:getEffectiveFillTypePrice(fillTypeIndex)
    for name, price in pairs(self.pricesPerLiter) do
        if FILL_TYPE_INDEX[name] == fillTypeIndex then
            return price
        end
    end
    return 0
end

function SellingStation:sellFillType(farmId, fillDelta, fillTypeIndex, _toolType, _extraAttributes)
    local price = fillDelta * self:getEffectiveFillTypePrice(fillTypeIndex)
    g_currentMission:addMoney(price, farmId, MoneyType.SOLD_PRODUCTS, true)
    return price
end

-- A fuel station: fillVehicle books fuel through addMoney on every call, which the game makes once a
-- frame while the vehicle fills up.
FillTrigger = {}
FillTrigger.__index = FillTrigger

function FillTrigger.new(pricePerLiter)
    return setmetatable({ pricePerLiter = pricePerLiter, moneyChangeType = MoneyType.register("other", "finance_purchaseFuel") }, FillTrigger)
end

function FillTrigger:getCurrentFillType()
    return FILL_TYPE_INDEX.DIESEL
end

function FillTrigger:fillVehicle(vehicle, delta, _dt)
    local farmId = 1
    local spec = vehicle.spec_motorized
    local consumer = spec ~= nil and spec.consumersByFillType[FILL_TYPE_INDEX.DIESEL] or nil
    local unit = consumer ~= nil and vehicle.spec_fillUnit.fillUnits[consumer.fillUnitIndex] or nil
    if unit == nil then
        return 0
    end
    delta = math.min(delta, unit.capacity - unit.fillLevel)
    if delta <= 0 then
        return 0
    end
    unit.fillLevel = unit.fillLevel + delta
    g_farmManager:updateFarmStats(farmId, "expenses", delta * self.pricePerLiter)
    g_currentMission:addMoney(-delta * self.pricePerLiter, farmId, self.moneyChangeType, true)
    return delta
end

-- Every install starts from these, as a fresh game process would, whatever an earlier mod load hooked.
local ECONOMY_ORIGINALS = {
    sellFillType = SellingStation.sellFillType,
    fillVehicle = FillTrigger.fillVehicle,
}

-- Mission -----------------------------------------------------------------------------------------

local Mission = {}
Mission.__index = Mission

function Mission:getFruitPixelsToSqm()
    return 1
end

function Mission:getIsServer()
    return self.isServer
end

function Mission:addMoney(amount, farmId, moneyType, _addChange, _forceShowChange)
    if farmId == 0 then
        return
    end
    local farm = g_farmManager:getFarmById(farmId)
    if farm ~= nil then
        farm:changeBalance(amount, moneyType)
    end
end

local function storage(levels, ownerFarmId)
    return {
        ownerFarmId = ownerFarmId,
        getFillLevels = function()
            local out = {}
            for name, liters in pairs(levels) do
                out[FILL_TYPE_INDEX[name]] = liters
            end
            return out
        end,
    }
end

local function newMission(opts)
    local farmManager = newFarmManager()
    g_farmManager = farmManager

    local silo = {
        spec_silo = {
            storages = {
                storage({ WHEAT = 180000.44, BARLEY = 0 }, nil),
                -- A shared silo keeps one storage per farm; farm 2's grain is not farm 1's.
                storage({ WHEAT = 5000 }, 2),
            },
        },
        getOwnerFarmId = function()
            return 1
        end,
    }
    local mill = {
        owningPlaceable = {
            getUniqueId = function()
                return "placeable7"
            end,
        },
        storage = storage({ FLOUR = 3000, WHEAT = 0 }, nil),
        getName = function()
            return "Grain Mill"
        end,
    }

    local mission = setmetatable({
        isServer = opts.isServer ~= false,
        missionInfo = {
            savegameDirectory = opts.savegameDirectory,
            savegameName = opts.savegameName or "Riverbend Springs",
            savegameIndex = opts.savegameIndex or 1,
            timeScale = opts.timeScale or 5,
            helperBuySeeds = opts.helperBuySeeds ~= false,
            helperBuyFertilizer = opts.helperBuyFertilizer ~= false,
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
            weather = {
                forecast = {
                    getCurrentWeather = function()
                        return { forecastType = 1, temperature = 21.26 }
                    end,
                    getDailyForecast = function(_self, offset)
                        return {
                            day = (opts.day or 37) + offset,
                            forecastType = 4,
                            lowTemperature = 9,
                            highTemperature = 17,
                        }
                    end,
                },
            },
        },
        farms = farmManager.byId,
        vehicleSystem = { vehicles = {} },
        placeableSystem = { placeables = { silo } },
        productionChainManager = {
            getProductionPointsForFarmId = function(_self, farmId)
                if farmId == 1 then
                    return { mill }
                end
                return {}
            end,
        },
        storageSystem = {
            stations = {
                SellingStation.new("placeable21", "Grain Elevator", { WHEAT = 0.42, BARLEY = 0.38 }),
                { isSellingPoint = false, acceptedFillTypes = {} },
            },
            getUnloadingStations = function(self)
                return self.stations
            end,
        },
        aiSystem = newAISystem(),
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

    -- opts.blockAppend: refuse io.open's append mode, as the FS25 sandbox might (PLAN_REVIEW.md F1).
    Engine.realIoOpen = Engine.realIoOpen or io.open
    io.open = Engine.realIoOpen
    if opts.blockAppend then
        io.open = function(path, mode)
            if type(mode) == "string" and mode:sub(1, 1) == "a" then
                return nil, path .. ": Permission denied"
            end
            return Engine.realIoOpen(path, mode)
        end
    end
    g_modIsLoaded = opts.modsLoaded or {}
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
    Engine.skippedSec = 0
    getTimeSec = function()
        return os.clock() + Engine.skippedSec
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
    MessageType = {
        HOUR_CHANGED = 1,
        DAY_CHANGED = 2,
        PERIOD_CHANGED = 3,
        YEAR_CHANGED = 4,
        VEHICLE_REMOVED = 5,
        VEHICLE_ADDED = 6,
        VEHICLE_REPAIRED = 7,
        AI_JOB_STARTED = 101,
        AI_JOB_STOPPED = 102,
        AI_JOB_REMOVED = 103,
    }
    g_messageCenter = MessageCenter.new()
    MoneyType = {
        OTHER = { id = 1, title = "finance_other", statistic = "other" },
        AI = { id = 2, title = "finance_wagePayment", statistic = "wagePayment" },
        SOLD_PRODUCTS = { id = 3, title = "finance_soldProducts", statistic = "soldProducts" },
        SHOP_VEHICLE_BUY = { id = 4, title = "finance_newVehiclesCost", statistic = "newVehiclesCost" },
        SHOP_VEHICLE_SELL = { id = 5, title = "finance_vehicleSale", statistic = "soldVehicles" },
        VEHICLE_REPAIR = { id = 6, title = "finance_vehicleRunningCost", statistic = "vehicleRunningCost" },
        PURCHASE_SEEDS = { id = 7, title = "finance_purchaseSeeds", statistic = "purchaseSeeds" },
        PURCHASE_FERTILIZER = { id = 8, title = "finance_purchaseFertilizer", statistic = "purchaseFertilizer" },
        LEASING_COSTS = { id = 9, title = "finance_vehicleLeasingCost", statistic = "vehicleLeasingCost" },
    }
    FinanceStats = { statNames = FINANCE_STAT_NAMES }
    AIJob = newAIJobClass()
    SowingMachine = newSowingMachine()
    Sprayer = newSprayer()
    Cultivator = newTillageSpec("spec_cultivator", "cultivatedHectares")
    Plow = newTillageSpec("spec_plow", "plowedHectares")
    -- Contract land: Engine.contractAt(true) puts every position on an active mission's field.
    Engine.onContractLand = false
    g_missionManager = {
        getMissionMapActiveMissionIdAtWorldPosition = function(_self, _x, _z)
            return Engine.onContractLand and 7 or 0
        end,
    }
    MathUtil = {
        areaToHa = function(area, pixelsToSqm)
            return area * pixelsToSqm / 10000
        end,
    }
    -- WearableRepairEvent:run repairs the vehicle, then announces it.
    WearableRepairEvent = {}
    WearableRepairEvent.__index = WearableRepairEvent
    function WearableRepairEvent.new(vehicle, atSellingPoint)
        return setmetatable({ vehicle = vehicle, atSellingPoint = atSellingPoint }, WearableRepairEvent)
    end
    function WearableRepairEvent:run(_connection)
        self.vehicle:repairVehicle(self.atSellingPoint)
        g_messageCenter:publish(MessageType.VEHICLE_REPAIRED, self.vehicle, self.atSellingPoint)
    end
    -- Types registered at map load get an id but no constant name, like the fuel stations' own.
    local nextMoneyTypeId = 100
    MoneyType.register = function(statistic, title)
        nextMoneyTypeId = nextMoneyTypeId + 1
        return { id = nextMoneyTypeId, statistic = statistic, title = title }
    end
    _G.Farm = Farm
    SellingStation.sellFillType = ECONOMY_ORIGINALS.sellFillType
    FillTrigger.fillVehicle = ECONOMY_ORIGINALS.fillVehicle
    g_farmManager = nil
    AIMessageSuccessStoppedByUser = Engine.AIMessages.SUCCESS_STOPPED_BY_USER
    FSCareerMissionInfo = {
        saveToXMLFile = function(_missionInfo)
            Engine.saveCalls = Engine.saveCalls + 1
        end,
    }
    Combine = {
        addCutterArea = function(_self, _area, liters)
            return liters
        end,
        registerOverwrittenFunctions = function(_vehicleType) end,
    }
    SpecializationUtil = {
        -- As in the game: each overwrite receives the function it replaces as superFunc, so several
        -- mods can overwrite the same one. `overwritten` lists what was registered, for the specs.
        registerOverwrittenFunction = function(vehicleType, name, fn)
            vehicleType.functions = vehicleType.functions or {}
            local previous = vehicleType.functions[name]
            vehicleType.functions[name] = function(self, ...)
                return fn(self, previous, ...)
            end
            vehicleType.overwritten = vehicleType.overwritten or {}
            vehicleType.overwritten[name] = vehicleType.overwritten[name] or {}
            table.insert(vehicleType.overwritten[name], fn)
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
    local vehicleType = { functions = { addCutterArea = Combine.addCutterArea } }
    Combine.registerOverwrittenFunctions(vehicleType)
    return vehicleType
end

---A combine threshes: liters of a fill type through its type's addCutterArea, as the cutter calls it.
function Engine.thresh(vehicleType, combine, liters, fillType)
    return vehicleType.functions.addCutterArea(combine, 5, liters, 1, FILL_TYPE_INDEX[fillType], 1, combine:getOwnerFarmId(), 1)
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
        -- AISystem:update: every running job's wages accrue.
        for _, job in ipairs(g_currentMission.aiSystem:getActiveJobs()) do
            if type(job.updateCost) == "function" then
                job:updateCost(dtMs)
            end
        end
    end
end

---Simulates the game pausing for this many real seconds without calling any update.
function Engine.pause(seconds)
    Engine.skippedSec = Engine.skippedSec + seconds
end

---Starts the next in-game day, as the environment does at midnight.
function Engine.newDay()
    local env = g_currentMission.environment
    env.currentMonotonicDay = env.currentMonotonicDay + 1
    env.currentDay = env.currentDay + 1
    env.currentDayInPeriod = env.currentDayInPeriod % env.daysPerPeriod + 1
    g_messageCenter:publish(MessageType.DAY_CHANGED, env.currentDay)
    -- The first day of a period starts a new month, and March a new year.
    if env.currentDayInPeriod == 1 then
        env.currentPeriod = env.currentPeriod % 12 + 1
        g_messageCenter:publish(MessageType.PERIOD_CHANGED, env.currentPeriod)
        if env.currentPeriod == 1 then
            env.currentYear = env.currentYear + 1
            g_messageCenter:publish(MessageType.YEAR_CHANGED, env.currentYear)
        end
    end
end

---Repairs a vehicle at the workshop, through WearableRepairEvent as the game does.
function Engine.repair(vehicle, price)
    vehicle.repairPrice = price
    WearableRepairEvent.new(vehicle, false):run({})
end

---One frame of sowing (or, with the sprayer spec, spraying): the area worked, the liters used and
---what a hired worker paid for them. Dispatched by name, as SpecializationUtil.raiseEvent does.
function Engine.workArea(vehicle, spec, sqm, inputPrice, liters, fillType)
    if spec == Cultivator or spec == Plow then
        local key = spec == Plow and "spec_plow" or "spec_cultivator"
        vehicle[key] = { workAreaParameters = { lastStatsArea = sqm } }
    elseif spec == Sprayer then
        local fillTypeIndex = FILL_TYPE_INDEX[fillType or "LIQUIDFERTILIZER"]
        vehicle.spec_sprayer = {
            workAreaParameters = {
                lastChangedArea = sqm,
                lastStatsArea = sqm,
                inputPrice = inputPrice,
                sprayFillType = fillTypeIndex,
                pendingFillType = fillTypeIndex,
                pendingUsage = liters or 0,
                usage = liters or 0,
            },
        }
        Sprayer["onStartWorkAreaProcessing"](vehicle, 16)
    else
        vehicle.spec_sowingMachine = {
            seedFillType = FILL_TYPE_INDEX.SEEDS,
            workAreaParameters = { lastChangedArea = sqm, lastStatsArea = sqm, inputPrice = inputPrice, usage = liters or 0 },
        }
    end
    spec["onEndWorkAreaProcessing"](vehicle, 16, true)
end

---Buys a vehicle in the shop: the purchase is booked, then the vehicle is added.
function Engine.buyVehicle(vehicle, price, farmId)
    g_currentMission:addMoney(-price, farmId or 1, MoneyType.SHOP_VEHICLE_BUY, true)
    return Engine.addVehicle(vehicle)
end

---Sells liters of a fill type at the first selling point, as unloading a trailer does.
function Engine.sell(farmId, fillType, liters)
    local station = g_currentMission.storageSystem.stations[1]
    return station:sellFillType(farmId, liters, FILL_TYPE_INDEX[fillType], nil, nil)
end

---Refuels a vehicle for the given real seconds at a fuel station, one fillVehicle call per frame.
function Engine.refuel(vehicle, seconds, dtMs)
    dtMs = dtMs or 16
    local trigger = FillTrigger.new(1.4)
    for _ = 1, math.floor(seconds * 1000 / dtMs) do
        trigger:fillVehicle(vehicle, 0.1 * dtMs, dtMs)
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
