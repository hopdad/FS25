-- Gathers frequent small reports into buckets and writes each bucket as one event (PLAN_REVIEW.md
-- F3): once its reports have been quiet for quietMs, once it is maxAgeMs old, or when told to (a
-- field change, a stop, a day rollover, a save). Time is real time, from the dt update() receives.

FarmLink = FarmLink or {}

local Gather = {}
Gather.__index = Gather
FarmLink.Gather = Gather

---@param write function write(bucket) turns a bucket into an event
---@param quietMs number
---@param maxAgeMs number
function Gather.new(write, quietMs, maxAgeMs)
    return setmetatable({ write = write, quietMs = quietMs, maxAgeMs = maxAgeMs, clockMs = 0, buckets = {}, order = {} }, Gather)
end

---The bucket for key, made with create() the first time; the report is then added by the caller.
function Gather:bucket(key, create)
    local bucket = self.buckets[key]
    if bucket == nil then
        bucket = create()
        bucket.key = key
        bucket.firstMs = self.clockMs
        self.buckets[key] = bucket
        self.order[#self.order + 1] = key
    end
    bucket.lastMs = self.clockMs
    return bucket
end

---Writes the buckets that match (all of them without a filter), oldest first.
function Gather:flush(match)
    local kept = {}
    for _, key in ipairs(self.order) do
        local bucket = self.buckets[key]
        if bucket ~= nil and (match == nil or match(bucket)) then
            self.buckets[key] = nil
            pcall(self.write, bucket)
        elseif bucket ~= nil then
            kept[#kept + 1] = key
        end
    end
    self.order = kept
end

---Advances the clock by dt and writes what has gone quiet or grown old.
function Gather:tick(dt)
    if type(dt) == "number" and dt > 0 then
        self.clockMs = self.clockMs + dt
    end
    local now = self.clockMs
    self:flush(function(bucket)
        return now - bucket.lastMs >= self.quietMs or now - bucket.firstMs >= self.maxAgeMs
    end)
end

function Gather:pending()
    return #self.order
end
