-- The money context stack (docs/HANDOFF.md, "Money funnel"). A context producer runs the game function
-- that books money inside Context.run, and the money funnel reads the innermost context when the
-- booking arrives. Every producer FarmLink uses books synchronously inside the function it wraps
-- (VERIFY_FIRST.md, P2 questions), so the stack is scoped to that call instead of living on a timer:
-- a context never outlasts the call that set it, and cannot attach to an unrelated booking later.

FarmLink = FarmLink or {}

local Context = {}
FarmLink.Context = Context

local unpack = unpack or table.unpack
local stack = {}

local function pack(...)
    return { n = select("#", ...), ... }
end

---Calls fn(...) with entry as the innermost money context. Errors are raised again unchanged and
---results passed back untouched, so a wrapped game function behaves exactly as before.
---@param entry table { kind = "sale"|"fuel"|"wage"|"input"|"vehicle"|"shop", ... }
---@param fn function
function Context.run(entry, fn, ...)
    stack[#stack + 1] = entry
    local depth = #stack
    local r = pack(pcall(fn, ...))
    -- Drop this entry and anything a failed inner call left behind.
    for i = #stack, depth, -1 do
        stack[i] = nil
    end
    if not r[1] then
        error(r[2], 0)
    end
    return unpack(r, 2, r.n)
end

---The innermost context, or nil outside any producer.
---@return table|nil
function Context.current()
    return stack[#stack]
end

---Forgets every context. Called when a mission starts and ends.
function Context.reset()
    stack = {}
end
