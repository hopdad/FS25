-- Identifiers: version 4 UUID strings for saveId and branchId. saveId is a global key in Supabase,
-- so it mixes several entropy sources through the engine's getMD5 (PLAN_REVIEW.md, risks).

FarmLink = FarmLink or {}

local Ids = {}
FarmLink.Ids = Ids

local counter = 0

local function entropy()
    counter = counter + 1
    local parts = { tostring({}), tostring(counter), tostring(math.random()) }
    if type(getTime) == "function" then
        local ok, t = pcall(getTime)
        if ok then
            parts[#parts + 1] = tostring(t)
        end
    end
    if type(getDate) == "function" then
        local ok, d = pcall(getDate, "%Y%m%d%H%M%S")
        if ok then
            parts[#parts + 1] = tostring(d)
        end
    end
    local ms = FarmLink.Clock.preciseMs()
    if ms ~= nil then
        parts[#parts + 1] = string.format("%.6f", ms)
    end
    return table.concat(parts, "|")
end

-- 32 lowercase hex characters: the engine's MD5 of the seed, or math.random where there is no
-- getMD5 (outside the game).
local function hex32(seed)
    if type(getMD5) == "function" then
        local ok, md5 = pcall(getMD5, seed)
        if ok and type(md5) == "string" and #md5 >= 32 and string.match(md5, "^%x+$") ~= nil then
            return string.lower(string.sub(md5, 1, 32))
        end
    end
    local out = {}
    for i = 1, 32 do
        out[i] = string.format("%x", math.random(0, 15))
    end
    return table.concat(out)
end

local VARIANT = { "8", "9", "a", "b" }

---@return string a random version 4 UUID
function Ids.uuid4()
    local h = hex32(entropy())
    local variant = VARIANT[tonumber(string.sub(h, 17, 17), 16) % 4 + 1]
    return string.sub(h, 1, 8)
        .. "-"
        .. string.sub(h, 9, 12)
        .. "-4"
        .. string.sub(h, 14, 16)
        .. "-"
        .. variant
        .. string.sub(h, 18, 20)
        .. "-"
        .. string.sub(h, 21, 32)
end

local UUID = "^%x%x%x%x%x%x%x%x%-%x%x%x%x%-[1-8]%x%x%x%-[89abAB]%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x$"

---@param value any
---@return boolean
function Ids.isUuid(value)
    return type(value) == "string" and string.match(value, UUID) ~= nil
end
