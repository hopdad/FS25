-- Daily prices (docs/HANDOFF.md, "Prices"; PLAN_REVIEW.md F3): one `prices` event per game day with
-- what every selling point pays for every fill type it takes, in money per 1000 liters. Written when
-- the session starts and at every new day, after the day rollover. It is the only source of price
-- curves, and of the market price field P&L falls back on for a crop that was not sold.

FarmLink = FarmLink or {}

local Prices = {
    name = "prices",
    authority = "server",
}
FarmLink.Prices = Prices

local function stationId(station)
    local Game = FarmLink.Game
    local placeable = type(station) == "table" and station.owningPlaceable or nil
    local id = Game.call(placeable, "getUniqueId")
    if type(id) ~= "string" or id == "" then
        id = Game.call(station, "getName") or Game.call(placeable, "getName")
    end
    if type(id) ~= "string" or id == "" then
        return nil
    end
    return id
end

---Every selling point's price for every fill type it accepts, sorted by station and fill type.
function Prices.table()
    local Game = FarmLink.Game
    local system = g_currentMission ~= nil and g_currentMission.storageSystem or nil
    local stations = Game.call(system, "getUnloadingStations")
    local entries = {}
    for _, station in pairs(type(stations) == "table" and stations or {}) do
        local id = type(station) == "table" and station.isSellingPoint == true and stationId(station) or nil
        if id ~= nil then
            for fillTypeIndex in pairs(station.acceptedFillTypes or {}) do
                local name = Game.fillTypeName(fillTypeIndex)
                local price = Game.num(Game.call(station, "getEffectiveFillTypePrice", fillTypeIndex))
                if name ~= nil and price ~= nil and price >= 0 then
                    entries[#entries + 1] = {
                        stationId = id,
                        fillType = name,
                        pricePer1000L = Game.round(price * 1000, 4),
                    }
                end
            end
        end
    end
    table.sort(entries, function(a, b)
        if a.stationId ~= b.stationId then
            return a.stationId < b.stationId
        end
        return a.fillType < b.fillType
    end)
    return entries
end

function Prices.write()
    FarmLink.EventLog.emit("prices", 0, { entries = FarmLink.Json.array(Prices.table()) })
end

function Prices.init(_ctx)
    Prices.write()
    if type(g_messageCenter) == "table" and type(MessageType) == "table" and MessageType.DAY_CHANGED ~= nil then
        g_messageCenter:subscribe(MessageType.DAY_CHANGED, function()
            local ok, err = pcall(Prices.write)
            if not ok then
                FarmLink.Log.error("daily prices failed: %s", tostring(err))
            end
        end, Prices)
    end
end

function Prices.shutdown(_ctx)
    if type(g_messageCenter) == "table" and type(g_messageCenter.unsubscribeAll) == "function" then
        pcall(g_messageCenter.unsubscribeAll, g_messageCenter, Prices)
    end
end
