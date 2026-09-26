-- A small XML document model with FS-style paths ("commands.command(2)#id"), backing the engine
-- stub's XMLFile. It parses what the bridge writes and what the mod saves: elements, attributes,
-- text, comments and the XML declaration. No DTDs, no namespaces.

local Xml = {}

local ENTITIES = { lt = "<", gt = ">", amp = "&", quot = '"', apos = "'" }

local function decode(text)
    return (text:gsub("&(#?x?)(%w+);", function(prefix, body)
        if prefix == "" then
            return ENTITIES[body]
        elseif prefix == "#" then
            return string.char(tonumber(body))
        else
            return string.char(tonumber(body, 16))
        end
    end))
end

local function encode(text, isAttribute)
    local out = text:gsub("&", "&amp;"):gsub("<", "&lt;"):gsub(">", "&gt;")
    if isAttribute then
        out = out:gsub('"', "&quot;")
    end
    return out
end

local function newNode(name)
    return { name = name, attributes = {}, attributeOrder = {}, children = {}, text = nil }
end

local function setAttribute(node, name, value)
    if node.attributes[name] == nil then
        node.attributeOrder[#node.attributeOrder + 1] = name
    end
    node.attributes[name] = value
end

-- Reads one start tag; i points just past "<". Returns name, attributes, order, selfClosing, next i.
local function parseTag(text, i)
    local name, j = text:match("^([%w_:%.%-]+)()", i)
    if name == nil then
        error("bad tag at byte " .. i, 0)
    end
    local node = newNode(name)
    while true do
        j = text:match("^%s*()", j)
        if text:sub(j, j + 1) == "/>" then
            return node, true, j + 2
        end
        if text:sub(j, j) == ">" then
            return node, false, j + 1
        end
        local attribute, quote, valueStart = text:match("^([%w_:%.%-]+)%s*=%s*([\"'])()", j)
        if attribute == nil then
            error("bad attribute in <" .. name .. "> at byte " .. j, 0)
        end
        local valueEnd = text:find(quote, valueStart, true)
        if valueEnd == nil then
            error("unterminated attribute in <" .. name .. ">", 0)
        end
        setAttribute(node, attribute, decode(text:sub(valueStart, valueEnd - 1)))
        j = valueEnd + 1
    end
end

---Parses a document; raises on malformed input.
function Xml.parse(text)
    local root = nil
    local stack = {}
    local i = 1
    if text:sub(1, 3) == "\239\187\191" then
        i = 4
    end
    while true do
        local lt = text:find("<", i, true)
        if lt == nil then
            break
        end
        if #stack > 0 and lt > i then
            local node = stack[#stack]
            node.text = (node.text or "") .. decode(text:sub(i, lt - 1))
        end
        if text:sub(lt, lt + 3) == "<!--" then
            local close = text:find("-->", lt + 4, true)
            if close == nil then
                error("unterminated comment", 0)
            end
            i = close + 3
        elseif text:sub(lt, lt + 1) == "<?" then
            local close = text:find("?>", lt + 2, true)
            if close == nil then
                error("unterminated declaration", 0)
            end
            i = close + 2
        elseif text:sub(lt, lt + 1) == "</" then
            local close = text:find(">", lt, true)
            if close == nil then
                error("unterminated end tag", 0)
            end
            local name = text:sub(lt + 2, close - 1):match("^%s*([%w_:%.%-]+)%s*$")
            local node = table.remove(stack)
            if node == nil or node.name ~= name then
                error("mismatched </" .. tostring(name) .. ">", 0)
            end
            i = close + 1
        else
            local node, selfClosing, nextI = parseTag(text, lt + 1)
            if #stack > 0 then
                local parent = stack[#stack]
                parent.children[#parent.children + 1] = node
            elseif root == nil then
                root = node
            else
                error("more than one root element", 0)
            end
            if not selfClosing then
                stack[#stack + 1] = node
            end
            i = nextI
        end
    end
    if #stack > 0 then
        error("unclosed <" .. stack[#stack].name .. ">", 0)
    end
    if root == nil then
        error("no root element", 0)
    end
    return root
end

local function splitPath(path)
    local elementPath, attribute = path:match("^([^#]*)#(.+)$")
    if elementPath == nil then
        elementPath = path
    end
    local segments = {}
    for segment in elementPath:gmatch("[^%.]+") do
        local name, index = segment:match("^(.-)%((%d+)%)$")
        if name ~= nil then
            segments[#segments + 1] = { name = name, index = tonumber(index) }
        else
            segments[#segments + 1] = { name = segment, index = 0 }
        end
    end
    return segments, attribute
end

---The node a path names (and the attribute part, if any). With create, missing elements are added.
function Xml.resolve(root, path, create)
    local segments, attribute = splitPath(path)
    if #segments == 0 or root == nil or segments[1].name ~= root.name then
        return nil, attribute
    end
    local node = root
    for s = 2, #segments do
        local segment = segments[s]
        local seen = -1
        local found = nil
        for _, child in ipairs(node.children) do
            if child.name == segment.name then
                seen = seen + 1
                if seen == segment.index then
                    found = child
                    break
                end
            end
        end
        if found == nil then
            if not create then
                return nil, attribute
            end
            while seen < segment.index do
                found = newNode(segment.name)
                node.children[#node.children + 1] = found
                seen = seen + 1
            end
        end
        node = found
    end
    return node, attribute
end

function Xml.get(root, path)
    local node, attribute = Xml.resolve(root, path, false)
    if node == nil then
        return nil
    end
    if attribute ~= nil then
        return node.attributes[attribute]
    end
    return node.text
end

function Xml.set(root, path, value)
    local node, attribute = Xml.resolve(root, path, true)
    if node == nil then
        error("path " .. path .. " does not start at the root element", 0)
    end
    if attribute ~= nil then
        setAttribute(node, attribute, value)
    else
        node.text = value
    end
end

function Xml.newRoot(name)
    return newNode(name)
end

local function serialize(node, indent, out)
    local parts = { indent, "<", node.name }
    for _, name in ipairs(node.attributeOrder) do
        parts[#parts + 1] = string.format(' %s="%s"', name, encode(node.attributes[name], true))
    end
    local hasText = node.text ~= nil and node.text:match("%S") ~= nil
    if #node.children == 0 and not hasText then
        parts[#parts + 1] = "/>"
        out[#out + 1] = table.concat(parts)
        return
    end
    if #node.children == 0 then
        parts[#parts + 1] = ">" .. encode(node.text, false) .. "</" .. node.name .. ">"
        out[#out + 1] = table.concat(parts)
        return
    end
    parts[#parts + 1] = ">"
    out[#out + 1] = table.concat(parts)
    for _, child in ipairs(node.children) do
        serialize(child, indent .. "    ", out)
    end
    out[#out + 1] = indent .. "</" .. node.name .. ">"
end

function Xml.serialize(root)
    local out = { '<?xml version="1.0" encoding="utf-8" standalone="no" ?>' }
    serialize(root, "", out)
    return table.concat(out, "\n") .. "\n"
end

return Xml
