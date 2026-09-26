local helper = require("helper")

describe("Json.encode", function()
    local Json

    before_each(function()
        helper.freshMod()
        Json = FarmLink.Json
    end)

    it("runs on Lua 5.1, the engine's dialect", function()
        assert.are.equal("Lua 5.1", _VERSION)
    end)

    it("encodes scalars", function()
        assert.are.equal('"hi"', Json.encode("hi"))
        assert.are.equal("42", Json.encode(42))
        assert.are.equal("-3", Json.encode(-3))
        assert.are.equal("1.5", Json.encode(1.5))
        assert.are.equal("0.1", Json.encode(0.1))
        assert.are.equal("true", Json.encode(true))
        assert.are.equal("false", Json.encode(false))
        assert.are.equal("null", Json.encode(Json.null))
        assert.are.equal("null", Json.encode(nil))
    end)

    it("never writes -0", function()
        assert.are.equal("0", Json.encode(-0.0))
    end)

    it("writes integers above 32 bits exactly", function()
        assert.are.equal("3000000000", Json.encode(3e9))
        assert.are.equal("-4294967297", Json.encode(-4294967297))
        assert.are.equal("9007199254740991", Json.encode(2 ^ 53 - 1))
    end)

    it("turns NaN and infinities into null", function()
        assert.are.equal("null", Json.encode(0 / 0))
        assert.are.equal("null", Json.encode(math.huge))
        assert.are.equal("[null]", Json.encode({ -math.huge }))
    end)

    it("escapes quotes, backslashes and control characters and passes UTF-8 through", function()
        assert.are.equal('"a\\"b\\\\c\\nd\\t\\u0001"', Json.encode('a"b\\c\nd\t\1'))
        assert.are.equal('"Größe 4,5 m"', Json.encode("Größe 4,5 m"))
    end)

    it("encodes sequences as arrays and objects with sorted keys", function()
        assert.are.equal("[1,2,3]", Json.encode({ 1, 2, 3 }))
        assert.are.equal('{"a":1,"b":2,"c":3}', Json.encode({ c = 3, a = 1, b = 2 }))
    end)

    it("encodes an empty table as [] unless it is marked as an object", function()
        assert.are.equal("[]", Json.encode({}))
        assert.are.equal("{}", Json.encode(Json.object({})))
        assert.are.equal("[]", Json.encode(Json.array({})))
    end)

    it("encodes a table with gaps or mixed keys as an object", function()
        assert.are.equal('{"1":"a","3":"c"}', Json.encode({ [1] = "a", [3] = "c" }))
        assert.are.equal('{"1":"a","x":true}', Json.encode({ "a", x = true }))
    end)

    it("keeps null members that Json.orNull fills in", function()
        assert.are.equal('{"a":null,"b":2}', Json.encode({ a = Json.orNull(nil), b = Json.orNull(2) }))
    end)

    it("encodes functions and other non-data values as null", function()
        assert.are.equal('{"f":null}', Json.encode({ f = print }))
    end)

    it("round-trips nested data through an independent parser", function()
        local value = {
            name = "Fendt 942 \"Vario\"",
            speed = 14.25,
            tags = { "a", "b" },
            nested = { deep = { deeper = { true, false, 3 } } },
            empty = Json.object({}),
        }
        local decoded = helper.decode(Json.encode(value))
        assert.are.same({
            name = 'Fendt 942 "Vario"',
            speed = 14.25,
            tags = { "a", "b" },
            nested = { deep = { deeper = { true, false, 3 } } },
            empty = {},
        }, decoded)
    end)

    it("refuses a cycle", function()
        local t = {}
        t.self = t
        assert.has_error(function()
            Json.encode(t)
        end, "Json.encode: table contains a cycle")
    end)

    it("refuses nesting past MAX_DEPTH", function()
        local root = {}
        local node = root
        for _ = 1, Json.MAX_DEPTH + 1 do
            node.child = {}
            node = node.child
        end
        assert.has_error(function()
            Json.encode(root)
        end)
    end)

    it("allows the same table twice when it is not a cycle", function()
        local shared = { 1 }
        assert.are.equal('{"a":[1],"b":[1]}', Json.encode({ a = shared, b = shared }))
    end)
end)
