-- farmLink.xml in the savegame folder: the ledger identity, which has to travel with the save and roll
-- back with it. P0 stores saveId and branchId; P2 adds the seq high-water, the command watermark,
-- aggregates and the worker registry.
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
---@return table ledger { saveId, branchId, isNew, loadedFrom }
function Persistence.load(savegameDirectory)
    local Ids = FarmLink.Ids
    local ledger = { isNew = true, loadedFrom = nil }

    if hasDirectory(savegameDirectory) and type(XMLFile) == "table" then
        local path = Persistence.path(savegameDirectory)
        local xml = XMLFile.loadIfExists("farmLinkXML", path)
        if xml ~= nil then
            local saveId = xml:getString(Persistence.ROOT .. ".save#id")
            local branchId = xml:getString(Persistence.ROOT .. ".save#branchId")
            xml:delete()
            if Ids.isUuid(saveId) and Ids.isUuid(branchId) then
                ledger.saveId = saveId
                ledger.branchId = branchId
                ledger.isNew = false
                ledger.loadedFrom = path
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
        xml:save()
    end)
    xml:delete()
    if not ok then
        return false, tostring(err)
    end
    ledger.isNew = false
    return true, nil
end
