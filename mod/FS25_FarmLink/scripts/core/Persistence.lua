-- farmLink.xml in the savegame folder: the ledger identity, which has to travel with the save and roll
-- back with it. It stores saveId, branchId, the event log's seq when the save was made, the command
-- watermark, and the machines the ledger knows (ledger/Machines.lua) with the operating time last
-- written for each.
--
-- Read when the mission loads and written from FSCareerMissionInfo.saveToXMLFile (hooked once in
-- FarmLink.lua). A career that was never saved has no savegameDirectory yet: it gets new ids, which
-- are written at its first save.

FarmLink = FarmLink or {}

local Persistence = {}
FarmLink.Persistence = Persistence

Persistence.FILE_NAME = "farmLink.xml"
Persistence.ROOT = "farmLink"
Persistence.FORMAT = 1
Persistence.MAX_MACHINES = 10000

---@param savegameDirectory string
---@return string
function Persistence.path(savegameDirectory)
    return FarmLink.FileIO.normalizeDir(savegameDirectory) .. Persistence.FILE_NAME
end

local function hasDirectory(savegameDirectory)
    return type(savegameDirectory) == "string" and savegameDirectory ~= ""
end

---Reads the ledger identity for a savegame, or creates a new one.
---@param savegameDirectory string|nil
---@return table ledger { saveId, branchId, seq, isNew, loadedFrom, commandEpoch, commandWatermark, machines }
function Persistence.load(savegameDirectory)
    local Ids = FarmLink.Ids
    local ledger = { isNew = true, loadedFrom = nil, seq = 0, machines = {} }

    if hasDirectory(savegameDirectory) and type(XMLFile) == "table" then
        local path = Persistence.path(savegameDirectory)
        local xml = XMLFile.loadIfExists("farmLinkXML", path)
        if xml ~= nil then
            local saveId = xml:getString(Persistence.ROOT .. ".save#id")
            local branchId = xml:getString(Persistence.ROOT .. ".save#branchId")
            local seq = xml:getInt(Persistence.ROOT .. ".save#seq")
            local commandEpoch = xml:getString(Persistence.ROOT .. ".commands#epoch")
            local commandWatermark = xml:getInt(Persistence.ROOT .. ".commands#watermark")
            local machines = Persistence.loadMachines(xml)
            xml:delete()
            if Ids.isUuid(saveId) and Ids.isUuid(branchId) then
                ledger.saveId = saveId
                ledger.branchId = branchId
                if type(seq) == "number" and seq > 0 then
                    ledger.seq = seq
                end
                ledger.isNew = false
                ledger.loadedFrom = path
                if Ids.isUuid(commandEpoch) and type(commandWatermark) == "number" then
                    ledger.commandEpoch = commandEpoch
                    ledger.commandWatermark = commandWatermark
                end
                ledger.machines = machines
            else
                FarmLink.Log.warning("%s has no valid ids; starting a new ledger", path)
            end
        end
    end

    if ledger.saveId == nil then
        ledger.saveId = Ids.uuid4()
        ledger.branchId = Ids.uuid4()
    end
    return ledger
end

local function machineKey(i)
    return string.format("%s.machines.machine(%d)", Persistence.ROOT, i)
end

---The machines the ledger knows: { [vehicleId] = { writtenMs, farmId } }.
function Persistence.loadMachines(xml)
    local machines = {}
    for i = 0, Persistence.MAX_MACHINES - 1 do
        local key = machineKey(i)
        local id = xml:getString(key .. "#id")
        if type(id) ~= "string" or id == "" then
            break
        end
        machines[id] = {
            writtenMs = tonumber(xml:getString(key .. "#operatingMs")) or 0,
            farmId = xml:getInt(key .. "#farmId") or 0,
        }
    end
    return machines
end

-- Operating time is kept as a string: milliseconds pass the range of an XML int within 600 hours.
local function saveMachines(xml, machines)
    local ids = {}
    for id in pairs(machines or {}) do
        ids[#ids + 1] = id
    end
    table.sort(ids)
    for i, id in ipairs(ids) do
        local key = machineKey(i - 1)
        xml:setString(key .. "#id", id)
        xml:setInt(key .. "#farmId", machines[id].farmId or 0)
        xml:setString(key .. "#operatingMs", string.format("%.0f", machines[id].writtenMs or 0))
    end
end

---Writes the ledger identity next to the savegame's own files.
---@param savegameDirectory string|nil
---@param ledger table
---@return boolean ok, string|nil err
function Persistence.save(savegameDirectory, ledger)
    if not hasDirectory(savegameDirectory) then
        return false, "no savegame directory"
    end
    if type(XMLFile) ~= "table" or type(XMLFile.create) ~= "function" then
        return false, "XMLFile unavailable"
    end
    local path = Persistence.path(savegameDirectory)
    local xml = XMLFile.create("farmLinkXML", path, Persistence.ROOT)
    if xml == nil then
        return false, "could not create " .. path
    end
    local ok, err = pcall(function()
        xml:setInt(Persistence.ROOT .. "#format", Persistence.FORMAT)
        xml:setString(Persistence.ROOT .. ".save#id", ledger.saveId)
        xml:setString(Persistence.ROOT .. ".save#branchId", ledger.branchId)
        xml:setInt(Persistence.ROOT .. ".save#seq", ledger.seq or 0)
        if ledger.commandEpoch ~= nil then
            xml:setString(Persistence.ROOT .. ".commands#epoch", ledger.commandEpoch)
            xml:setInt(Persistence.ROOT .. ".commands#watermark", ledger.commandWatermark or 0)
        end
        saveMachines(xml, ledger.machines)
        xml:save()
    end)
    xml:delete()
    if not ok then
        return false, tostring(err)
    end
    ledger.isNew = false
    return true, nil
end
