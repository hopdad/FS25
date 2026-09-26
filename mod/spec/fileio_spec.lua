local helper = require("helper")

describe("FileIO", function()
    local FileIO
    local Engine

    before_each(function()
        Engine = helper.freshMod()
        FileIO = FarmLink.FileIO
    end)

    it("normalizes Windows paths and doubled slashes, keeping a UNC prefix", function()
        assert.are.equal(
            "C:/Users/me/Documents/My Games/FarmingSimulator2025/",
            FileIO.normalizeDir("C:\\Users\\me\\Documents//My Games\\FarmingSimulator2025")
        )
        assert.are.equal("//server/share/modSettings/", FileIO.normalizeDir("\\\\server\\share\\modSettings\\"))
        assert.are.equal("/a/b/c.txt", FileIO.collapseSlashes("/a//b///c.txt"))
    end)

    it("resolves the settings folder from g_modSettingsDirectory", function()
        local dir, source = FileIO.resolveBaseDir("FS25_FarmLink")
        assert.are.equal(Engine.profileDir .. "modSettings/FS25_FarmLink/", dir)
        assert.are.equal("g_modSettingsDirectory", source)
    end)

    it("falls back to getUserProfileAppPath when the global is not set yet", function()
        helper.freshMod({ noModSettingsGlobal = true })
        local dir, source = FarmLink.FileIO.resolveBaseDir("FS25_FarmLink")
        assert.are.equal(Engine.profileDir .. "modSettings/FS25_FarmLink/", dir)
        assert.are.equal("getUserProfileAppPath", source)
    end)

    it("returns nil when there is no way to find the folder", function()
        _G.g_modSettingsDirectory = nil
        _G.getUserProfileAppPath = nil
        assert.is_nil(FileIO.resolveBaseDir("FS25_FarmLink"))
    end)

    it("creates nested folders and writes files", function()
        local base = Engine.profileDir .. "modSettings/FS25_FarmLink/"
        assert.is_true(FileIO.ensureDir(base, "abc/events"))
        local ok, err = FileIO.writeText(base .. "abc/events/1.txt", "hello")
        assert.is_true(ok, err)
        assert.are.equal("hello", Engine.readFile(base .. "abc/events/1.txt"))
        assert.is_true(FileIO.exists(base .. "abc/events/1.txt"))
    end)

    it("reports a failed write instead of raising", function()
        local ok, err = FileIO.writeText(Engine.profileDir .. "missing/folder/x.json", "{}")
        assert.is_false(ok)
        assert.is_string(err)
    end)

    it("falls back to the engine's createFile when io is unavailable", function()
        local written = {}
        local savedIo = io
        _G.createFile = function(path, access)
            assert.are.equal(FileAccess.WRITE, access)
            written.path = path
            return 7
        end
        _G.fileWrite = function(handle, text)
            assert.are.equal(7, handle)
            written.text = text
        end
        _G.delete = function(handle)
            written.closed = handle
        end
        _G.FileAccess = { WRITE = 2 }
        _G.io = nil
        local ok = FileIO.writeText("/x/y.json", "{}")
        _G.io = savedIo
        assert.is_true(ok)
        assert.are.same({ path = "/x/y.json", text = "{}", closed = 7 }, written)
    end)

    it("deletes through a path with doubled slashes, which the engine would refuse", function()
        local base = Engine.profileDir .. "modSettings/FS25_FarmLink/"
        FileIO.ensureDir(base)
        FileIO.writeText(base .. "old.json", "{}")
        assert.is_true(FileIO.delete(Engine.profileDir .. "modSettings//FS25_FarmLink//old.json"))
        assert.is_false(FileIO.exists(base .. "old.json"))
    end)
end)
