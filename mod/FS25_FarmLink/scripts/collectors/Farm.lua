-- live_farm.json: each farm's balance, loan, silo stocks and production stocks, plus the weather and
-- forecast. Written every 60 s. Contract: packages/schema/src/live.ts.

FarmLink = FarmLink or {}

local Farm = {
    name = "farm",
    authority = "server",
    FILE_NAME = "live_farm.json",
    INTERVAL_MS = 60000,
    FORECAST_DAYS = 4,
}
FarmLink.FarmCollector = Farm

-- environment/weather/WeatherType.lua
local WEATHER_TYPES = {
    [1] = "SUN",
    [2] = "PARTIALLY_CLOUDY",
    [3] = "CLOUDY",
    [4] = "RAIN",
    [5] = "SNOW",
    [6] = "HAIL",
    [7] = "TWISTER",
    [8] = "THUNDER",
}

local function weatherType(id)
    return WEATHER_TYPES[id] or "UNKNOWN"
end

---Adds a storage's fill levels (fill type index -> liters) into totals (fill type name -> liters).
local function addFillLevels(totals, storage)
    local levels = FarmLink.Game.call(storage, "getFillLevels")
    if type(levels) ~= "table" then
        return
    end
    for fillTypeIndex, liters in pairs(levels) do
        local name = FarmLink.Game.fillTypeName(fillTypeIndex)
        local amount = FarmLink.Game.num(liters)
        if name ~= nil and amount ~= nil and amount > 0 then
            totals[name] = (totals[name] or 0) + amount
        end
    end
end

local function stockList(totals)
    local names = {}
    for name in pairs(totals) do
        names[#names + 1] = name
    end
    table.sort(names)
    local out = {}
    for _, name in ipairs(names) do
        out[#out + 1] = { fillType = name, liters = FarmLink.Game.round(totals[name], 1) }
    end
    return FarmLink.Json.array(out)
end

---Silo contents for one farm, summed by fill type. A silo shared between farms keeps one storage per
---farm (storage.ownerFarmId); an ordinary silo belongs to its placeable's owner.
function Farm.storage(farmId)
    local Game = FarmLink.Game
    local totals = {}
    local system = g_currentMission ~= nil and g_currentMission.placeableSystem or nil
    local placeables = system ~= nil and system.placeables or nil
    if type(placeables) == "table" then
        for _, placeable in ipairs(placeables) do
            local spec = type(placeable) == "table" and placeable.spec_silo or nil
            if type(spec) == "table" and type(spec.storages) == "table" then
                local owner = Game.call(placeable, "getOwnerFarmId")
                for _, storage in ipairs(spec.storages) do
                    local storageOwner = type(storage) == "table" and storage.ownerFarmId or nil
                    if storageOwner == farmId or (storageOwner == nil and owner == farmId) then
                        addFillLevels(totals, storage)
                    end
                end
            end
        end
    end
    return stockList(totals)
end

---Production points owned by one farm, with what each holds.
function Farm.productions(farmId)
    local Game = FarmLink.Game
    local out = {}
    local manager = g_currentMission ~= nil and g_currentMission.productionChainManager or nil
    local points = Game.call(manager, "getProductionPointsForFarmId", farmId)
    if type(points) == "table" then
        for index, point in ipairs(points) do
            local totals = {}
            addFillLevels(totals, point.storage)
            local id = Game.call(point.owningPlaceable, "getUniqueId")
            local name = Game.call(point, "getName")
            out[#out + 1] = {
                id = type(id) == "string" and id or ("production" .. index),
                name = type(name) == "string" and name or "Production",
                stocks = stockList(totals),
            }
        end
    end
    return FarmLink.Json.array(out)
end

local function farmList()
    local Game = FarmLink.Game
    local farms = Game.call(g_farmManager, "getFarms")
    if type(farms) ~= "table" and g_farmManager ~= nil then
        farms = g_farmManager.farms
    end
    return type(farms) == "table" and farms or {}
end

function Farm.farmRow(farm)
    local Game = FarmLink.Game
    local balance = Game.num(Game.call(farm, "getBalance")) or Game.num(farm.money) or 0
    local name = farm.name
    return {
        farmId = farm.farmId,
        name = type(name) == "string" and name or ("Farm " .. tostring(farm.farmId)),
        balance = Game.round(balance, 2),
        loan = Game.round(math.max(0, Game.num(farm.loan) or 0), 2),
        storage = Farm.storage(farm.farmId),
        productions = Farm.productions(farm.farmId),
    }
end

---Current weather and the next days' forecast, read from environment.weather.forecast.
function Farm.weather()
    local Game = FarmLink.Game
    local Json = FarmLink.Json
    local env = g_currentMission ~= nil and g_currentMission.environment or nil
    local forecast = type(env) == "table" and type(env.weather) == "table" and env.weather.forecast or nil

    local current = Json.null
    local info = Game.call(forecast, "getCurrentWeather")
    if type(info) == "table" and Game.num(info.temperature) ~= nil then
        current = {
            type = weatherType(info.forecastType),
            temperatureC = Game.round(info.temperature, 1),
        }
    end

    local days = {}
    for offset = 1, Farm.FORECAST_DAYS do
        local day = Game.call(forecast, "getDailyForecast", offset)
        if
            type(day) == "table"
            and Game.num(day.day) ~= nil
            and Game.num(day.lowTemperature) ~= nil
            and Game.num(day.highTemperature) ~= nil
        then
            days[#days + 1] = {
                day = math.max(0, math.floor(day.day)),
                type = weatherType(day.forecastType),
                minC = Game.round(day.lowTemperature, 1),
                maxC = Game.round(day.highTemperature, 1),
            }
        end
    end
    return { current = current, forecast = Json.array(days) }
end

---One live_farm.json document. Farm 0 is the spectator farm and is left out.
function Farm.frame(ctx)
    local Clock = FarmLink.Clock
    local farms = {}
    for _, farm in ipairs(farmList()) do
        if type(farm) == "table" and type(farm.farmId) == "number" and farm.farmId > 0 then
            local ok, row = pcall(Farm.farmRow, farm)
            if ok then
                farms[#farms + 1] = row
            end
        end
    end
    local weatherOk, weather = pcall(Farm.weather)
    if not weatherOk then
        weather = { current = FarmLink.Json.null, forecast = FarmLink.Json.array({}) }
    end
    return {
        v = 1,
        saveId = ctx.ledger.saveId,
        sessionId = ctx.sessionId,
        realTs = Clock.realTimestamp(),
        day = Clock.gameDay(),
        minute = Clock.minuteOfDay(),
        farm = { farms = FarmLink.Json.array(farms), weather = weather },
    }
end

function Farm.write(ctx)
    local text = FarmLink.Json.encode(Farm.frame(ctx))
    local ok, err = FarmLink.FileIO.writeText(ctx.saveDir .. Farm.FILE_NAME, text)
    if not ok then
        error("writing live_farm.json: " .. tostring(err), 0)
    end
end

function Farm.init(ctx)
    ctx.farmThrottle = FarmLink.Clock.newThrottle(Farm.INTERVAL_MS, Farm.INTERVAL_MS)
end

function Farm.update(dt, ctx)
    if ctx.farmThrottle:tick(dt) then
        Farm.write(ctx)
    end
end
