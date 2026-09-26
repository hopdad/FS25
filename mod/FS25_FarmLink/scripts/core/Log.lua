-- Log lines with a fixed prefix. Uses the engine's Logging when it exists, so lines land in log.txt
-- with the game's own severity tags; falls back to print outside the game.

FarmLink = FarmLink or {}

local Log = {}
FarmLink.Log = Log

Log.PREFIX = "[FarmLink] "
Log.debugEnabled = false

local ENGINE_FUNCTION = { info = "info", warning = "warning", error = "error", debug = "info" }

local function emit(level, fmt, ...)
    local ok, message = pcall(string.format, fmt, ...)
    if not ok then
        message = tostring(fmt)
    end
    local line = Log.PREFIX .. message

    local engine = Logging
    if type(engine) == "table" and type(engine[ENGINE_FUNCTION[level]]) == "function" then
        -- Logging.* runs string.format on its first argument; pass the finished line as data.
        engine[ENGINE_FUNCTION[level]]("%s", line)
    else
        print(level:upper() .. ": " .. line)
    end
end

function Log.info(fmt, ...)
    emit("info", fmt, ...)
end

function Log.warning(fmt, ...)
    emit("warning", fmt, ...)
end

function Log.error(fmt, ...)
    emit("error", fmt, ...)
end

function Log.debug(fmt, ...)
    if Log.debugEnabled then
        emit("debug", fmt, ...)
    end
end
