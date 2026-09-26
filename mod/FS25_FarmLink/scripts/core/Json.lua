-- JSON encoder. There is no decoder: the FS25 sandbox only lets a mod write text files, so the mod
-- never reads JSON. Pure Lua 5.1 with no engine calls, so it runs under busted.
--
--   string     quoted; " \ and control characters escaped, other bytes (UTF-8) passed through
--   number     integral values below 2^53 without a decimal point, others as %.14g; NaN and the
--              infinities become null because JSON has no literal for them
--   boolean    true / false
--   Json.null  null. A Lua table cannot hold nil, so a field that must be present with a null
--              value uses this sentinel
--   table      an array when its keys are exactly 1..n, otherwise an object with its keys sorted so
--              the output is deterministic. An empty table encodes as [] unless wrapped in
--              Json.object()
--   anything else (function, userdata, thread) encodes as null

FarmLink = FarmLink or {}

local Json = {}
FarmLink.Json = Json

Json.MAX_DEPTH = 32

Json.null = setmetatable({}, {
    __tostring = function()
        return "null"
    end,
})

local OBJECT_MT = { __jsontype = "object" }
local ARRAY_MT = { __jsontype = "array" }

---Marks a table as a JSON object, so an empty one encodes as {} rather than [].
function Json.object(t)
    return setmetatable(t or {}, OBJECT_MT)
end

---Marks a table as a JSON array.
function Json.array(t)
    return setmetatable(t or {}, ARRAY_MT)
end

---The value, or Json.null when it is nil, for fields the contract requires even when empty.
function Json.orNull(value)
    if value == nil then
        return Json.null
    end
    return value
end

local format = string.format
local byte = string.byte
local gsub = string.gsub
local concat = table.concat
local sort = table.sort
local floor = math.floor
local huge = math.huge

local MAX_EXACT = 2 ^ 53

local ESCAPES = {
    ['"'] = '\\"',
    ["\\"] = "\\\\",
    ["\b"] = "\\b",
    ["\f"] = "\\f",
    ["\n"] = "\\n",
    ["\r"] = "\\r",
    ["\t"] = "\\t",
}

local function escapeChar(c)
    return ESCAPES[c] or format("\\u%04x", byte(c))
end

local function encodeString(s)
    return '"' .. gsub(s, '[%c"\\]', escapeChar) .. '"'
end

local function encodeNumber(n)
    if n ~= n or n == huge or n == -huge then
        return "null"
    end
    if n == floor(n) and n > -MAX_EXACT and n < MAX_EXACT then
        if n == 0 then
            return "0" -- never "-0"
        end
        -- %.0f rather than %d: Lua 5.1's %d goes through a C long, which is 32 bits on Windows.
        return format("%.0f", n)
    end
    return format("%.14g", n)
end

local function isArray(t)
    local mt = getmetatable(t)
    if mt ~= nil and mt.__jsontype ~= nil then
        return mt.__jsontype == "array"
    end
    local n = #t
    local count = 0
    for k in pairs(t) do
        if type(k) ~= "number" or k < 1 or k > n or k ~= floor(k) then
            return false
        end
        count = count + 1
    end
    return count == n
end

local encodeValue

local function encodeTable(t, buf, depth, seen)
    if depth > Json.MAX_DEPTH then
        error("Json.encode: nesting deeper than " .. Json.MAX_DEPTH, 0)
    end
    if seen[t] then
        error("Json.encode: table contains a cycle", 0)
    end
    seen[t] = true

    if isArray(t) then
        buf[#buf + 1] = "["
        for i = 1, #t do
            if i > 1 then
                buf[#buf + 1] = ","
            end
            encodeValue(t[i], buf, depth + 1, seen)
        end
        buf[#buf + 1] = "]"
    else
        local names = {}
        local byName = {}
        for k, v in pairs(t) do
            local kind = type(k)
            if kind ~= "string" and kind ~= "number" then
                error("Json.encode: object key of type " .. kind, 0)
            end
            local name = kind == "string" and k or encodeNumber(k)
            names[#names + 1] = name
            byName[name] = v
        end
        sort(names)

        buf[#buf + 1] = "{"
        for i, name in ipairs(names) do
            if i > 1 then
                buf[#buf + 1] = ","
            end
            buf[#buf + 1] = encodeString(name)
            buf[#buf + 1] = ":"
            encodeValue(byName[name], buf, depth + 1, seen)
        end
        buf[#buf + 1] = "}"
    end

    seen[t] = nil
end

encodeValue = function(value, buf, depth, seen)
    local kind = type(value)
    if value == Json.null or value == nil then
        buf[#buf + 1] = "null"
    elseif kind == "string" then
        buf[#buf + 1] = encodeString(value)
    elseif kind == "number" then
        buf[#buf + 1] = encodeNumber(value)
    elseif kind == "boolean" then
        buf[#buf + 1] = value and "true" or "false"
    elseif kind == "table" then
        encodeTable(value, buf, depth, seen)
    else
        buf[#buf + 1] = "null"
    end
end

---Encodes a value as compact JSON. Raises on a cycle or on nesting deeper than Json.MAX_DEPTH.
---@param value any
---@return string
function Json.encode(value)
    local buf = {}
    encodeValue(value, buf, 1, {})
    return concat(buf)
end
