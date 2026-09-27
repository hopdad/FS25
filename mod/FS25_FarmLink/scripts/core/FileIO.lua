-- File access under modSettings/FS25_FarmLink/. What the FS25 sandbox allows (VERIFY_FIRST.md, 1):
--   * io.open in write mode. It does not create folders, so ensureDir runs first.
--   * No text reads. Anything the mod reads back is XML, through XMLFile.
--   * deleteFile only inside modSettings/<modName>/, and never for a path containing "//".
-- Nothing here raises: every function returns ok, err.

FarmLink = FarmLink or {}

local FileIO = {}
FarmLink.FileIO = FileIO

---Forward slashes and no doubled slashes, keeping a leading "//" (a Windows UNC share).
---@param path string
---@return string
function FileIO.collapseSlashes(path)
    local p = string.gsub(path, "\\", "/")
    local unc = string.sub(p, 1, 2) == "//"
    p = string.gsub(p, "//+", "/")
    if unc then
        p = "/" .. p
    end
    return p
end

---Like collapseSlashes, plus exactly one trailing slash.
---@param path string
---@return string
function FileIO.normalizeDir(path)
    local p = FileIO.collapseSlashes(path)
    if string.sub(p, -1) ~= "/" then
        p = p .. "/"
    end
    return p
end

---The mod's settings folder, and which source it came from. g_modSettingsDirectory is the FS25
---global; getUserProfileAppPath() is the fallback for when it is still nil (VERIFY_FIRST.md, 2).
---@param modName string
---@return string|nil dir, string|nil source
function FileIO.resolveBaseDir(modName)
    local root = g_modSettingsDirectory
    local source = "g_modSettingsDirectory"
    if type(root) ~= "string" or root == "" then
        root = nil
        if type(getUserProfileAppPath) == "function" then
            local ok, profile = pcall(getUserProfileAppPath)
            if ok and type(profile) == "string" and profile ~= "" then
                root = FileIO.normalizeDir(profile) .. "modSettings/"
                source = "getUserProfileAppPath"
            end
        end
    end
    if root == nil then
        return nil, nil
    end
    return FileIO.normalizeDir(root) .. modName .. "/", source
end

---Creates base and each folder of relative below it ("a/b/" creates a/ then a/b/). base's parent
---must exist; the game creates modSettings/ itself.
---@param base string
---@param relative string|nil
---@return boolean ok, string|nil err
function FileIO.ensureDir(base, relative)
    if type(createFolder) ~= "function" then
        return false, "createFolder unavailable"
    end
    local dir = FileIO.normalizeDir(base)
    local ok, err = pcall(createFolder, dir)
    if not ok then
        return false, tostring(err)
    end
    if relative ~= nil then
        for part in string.gmatch(FileIO.collapseSlashes(relative), "[^/]+") do
            dir = dir .. part .. "/"
            ok, err = pcall(createFolder, dir)
            if not ok then
                return false, tostring(err)
            end
        end
    end
    return true, nil
end

local function writeWithIo(path, text)
    local file, openErr = io.open(path, "w")
    if file == nil then
        return false, tostring(openErr)
    end
    local ok, result, writeErr = pcall(file.write, file, text)
    pcall(file.close, file)
    if not ok then
        return false, tostring(result)
    end
    if result == nil then
        return false, tostring(writeErr)
    end
    return true, nil
end

local function writeWithEngine(path, text)
    local handle = createFile(path, FileAccess.WRITE)
    if handle == nil or handle == 0 then
        return false, "createFile failed"
    end
    local ok, err = pcall(fileWrite, handle, text)
    pcall(delete, handle)
    if not ok then
        return false, tostring(err)
    end
    return true, nil
end

---Replaces path's contents with text. Writes in place: the sandbox offers no rename, and the bridge
---retries a read that lands mid-write (VERIFY_FIRST.md, 3).
---@param path string
---@param text string
---@return boolean ok, string|nil err
function FileIO.writeText(path, text)
    if type(io) == "table" and type(io.open) == "function" then
        return writeWithIo(path, text)
    end
    if type(createFile) == "function" and type(fileWrite) == "function" and type(FileAccess) == "table" then
        return writeWithEngine(path, text)
    end
    return false, "no file write API"
end

---Appends text to path, creating the file if needed. Fails where the sandbox refuses append mode,
---which the event log takes as its cue to keep a handle open instead (PLAN_REVIEW.md F1).
---@param path string
---@param text string
---@return boolean ok, string|nil err
function FileIO.appendText(path, text)
    if type(io) ~= "table" or type(io.open) ~= "function" then
        return false, "no io.open"
    end
    local ok, file, openErr = pcall(io.open, path, "a")
    if not ok then
        return false, tostring(file)
    end
    if file == nil then
        return false, tostring(openErr)
    end
    local written, result, writeErr = pcall(file.write, file, text)
    pcall(file.close, file)
    if not written then
        return false, tostring(result)
    end
    if result == nil then
        return false, tostring(writeErr)
    end
    return true, nil
end

---Opens path for writing and keeps it open, replacing any file already there. The caller writes
---with writeHandle and closes with closeHandle.
---@param path string
---@return table|nil handle, string|nil err
function FileIO.openHandle(path)
    if type(io) ~= "table" or type(io.open) ~= "function" then
        return nil, "no io.open"
    end
    local ok, file, openErr = pcall(io.open, path, "w")
    if not ok then
        return nil, tostring(file)
    end
    if file == nil then
        return nil, tostring(openErr)
    end
    return file, nil
end

---Writes text through a kept-open handle and flushes it, so a reader sees whole batches.
---@param handle table
---@param text string
---@return boolean ok, string|nil err
function FileIO.writeHandle(handle, text)
    local ok, result, writeErr = pcall(handle.write, handle, text)
    if not ok then
        return false, tostring(result)
    end
    if result == nil then
        return false, tostring(writeErr)
    end
    if type(handle.flush) == "function" then
        pcall(handle.flush, handle)
    end
    return true, nil
end

---@param handle table
function FileIO.closeHandle(handle)
    if handle ~= nil and type(handle.close) == "function" then
        pcall(handle.close, handle)
    end
end

---@param path string
---@return boolean
function FileIO.exists(path)
    if type(fileExists) ~= "function" then
        return false
    end
    local ok, result = pcall(fileExists, path)
    return ok and result == true
end

---Deletes a file inside the mod's settings folder.
---@param path string
---@return boolean ok, string|nil err
function FileIO.delete(path)
    if type(deleteFile) ~= "function" then
        return false, "deleteFile unavailable"
    end
    local ok, err = pcall(deleteFile, FileIO.collapseSlashes(path))
    if not ok then
        return false, tostring(err)
    end
    return true, nil
end
