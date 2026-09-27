-- Module registry. Every module call runs under pcall, so a FarmLink failure never reaches the game or
-- the save. Three consecutive failures of one module disable it for the rest of the mission.
--
-- A module is a table with a unique `name`, an `authority` of "server" (default: runs only where the
-- ledger lives) or "any", and any of these functions:
--   init(ctx)            mission start, after the ledger identity is known
--   update(dt, ctx)      every frame; dt is real milliseconds
--   beforeSave(ctx, info) the career is being saved: flush anything still being collected
--   checkpoint(ctx)      then the event log writes it and records its seq (the event log only)
--   onSave(ctx, info)    after the career save wrote the savegame
--   shutdown(ctx)        mission end

FarmLink = FarmLink or {}

local Registry = {}
Registry.__index = Registry
FarmLink.Registry = Registry

Registry.MAX_CONSECUTIVE_ERRORS = 3
-- Error lines logged per module per mission before the rest are suppressed.
Registry.MAX_LOGGED_ERRORS = 10

---@param log table|nil defaults to FarmLink.Log
function Registry.new(log)
    local self = setmetatable({}, Registry)
    self.log = log or FarmLink.Log
    self.modules = {}
    self:reset()
    return self
end

---Adds a module once; adding the same name again is a no-op.
function Registry:add(module)
    assert(type(module) == "table" and type(module.name) == "string", "a module needs a name")
    for _, existing in ipairs(self.modules) do
        if existing.name == module.name then
            return
        end
    end
    self.modules[#self.modules + 1] = module
end

---Forgets all error state. Called at the start of every mission.
function Registry:reset()
    self.streak = {}
    self.totals = {}
    self.disabled = {}
end

---@return boolean
function Registry:isActive(module, isAuthority)
    if self.disabled[module.name] then
        return false
    end
    local authority = module.authority or "server"
    return authority == "any" or isAuthority == true
end

---Calls method on every active module that has it, in registration order.
---@param method string
---@param isAuthority boolean whether this instance is the server (or single-player host)
function Registry:call(method, isAuthority, ...)
    for _, module in ipairs(self.modules) do
        local fn = module[method]
        if type(fn) == "function" and self:isActive(module, isAuthority) then
            local ok, err = pcall(fn, ...)
            if ok then
                self.streak[module.name] = 0
            else
                self:recordFailure(module, method, err)
            end
        end
    end
end

function Registry:recordFailure(module, method, err)
    local name = module.name
    local total = (self.totals[name] or 0) + 1
    local streak = (self.streak[name] or 0) + 1
    self.totals[name] = total
    self.streak[name] = streak

    if total <= Registry.MAX_LOGGED_ERRORS then
        self.log.error("%s.%s failed: %s", name, method, tostring(err))
        if total == Registry.MAX_LOGGED_ERRORS then
            self.log.error("%s: further errors this mission are not logged", name)
        end
    end
    if streak >= Registry.MAX_CONSECUTIVE_ERRORS then
        self.disabled[name] = true
        self.log.error("%s disabled for this mission after %d consecutive errors", name, streak)
    end
end

---Error totals per module name, for meta.json.
---@return table<string, integer>
function Registry:errorTotals()
    local out = {}
    for name, total in pairs(self.totals) do
        out[name] = total
    end
    return out
end

---Names of disabled modules, sorted.
---@return string[]
function Registry:disabledNames()
    local out = {}
    for name in pairs(self.disabled) do
        out[#out + 1] = name
    end
    table.sort(out)
    return out
end
