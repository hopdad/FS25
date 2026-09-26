local helper = require("helper")

describe("VehicleCollector", function()
    local Collector
    local Engine
    local NULL = helper.NULL

    before_each(function()
        Engine = helper.freshMod()
        Collector = FarmLink.VehicleCollector
    end)

    local function snapshot(vehicle)
        return helper.decode(FarmLink.Json.encode(Collector.snapshot(vehicle)))
    end

    it("reads a running tractor with a seeder attached", function()
        local state = snapshot(helper.tractor())
        assert.are.same({
            vehicleId = "vehicle7f3a",
            name = "Fendt 942 Vario",
            speedKmh = 14.3,
            rpm = 1450,
            gear = "D",
            fuelType = "DIESEL",
            fuelPct = 62.5,
            damagePct = 3.1,
            operatingHours = 412.7,
            position = { x = 120.46, y = 88.1, z = -40.2, heading = 90 },
            isAI = false,
            fillUnits = {},
            implements = {
                {
                    vehicleId = "vehicle91c0",
                    name = "Amazone Cirrus 6003",
                    fillUnits = { { fillType = "SEEDS", level = 2100, capacity = 3600 } },
                },
            },
        }, state)
    end)

    it("measures heading clockwise from north (-z)", function()
        assert.are.equal(0, snapshot(helper.tractor({ dirX = 0, dirZ = -1 })).position.heading)
        assert.are.equal(180, snapshot(helper.tractor({ dirX = 0, dirZ = 1 })).position.heading)
        assert.are.equal(270, snapshot(helper.tractor({ dirX = -1, dirZ = 0 })).position.heading)
    end)

    it("reports 0 rpm when the engine is off, even if the motor holds a stale value", function()
        assert.are.equal(0, snapshot(helper.tractor({ motorState = 1 })).rpm)
    end)

    it("leaves fuel and air out of the fill units and maps an unlimited capacity to null", function()
        local combine = Engine.newVehicle({
            uniqueId = "vehicle55",
            fuel = { fillType = "DIESEL", level = 50, capacity = 1000 },
            fillUnits = {
                { fillType = "WHEAT", level = 9000.04, capacity = 12500 },
                { fillType = "AIR", level = 10, capacity = 10 },
                { fillType = "BARLEY", level = 5, capacity = math.huge },
                { fillType = "WHEAT", level = 1, capacity = 1, showOnInfoHud = false },
                { fillType = "UNKNOWN", level = -0.2, capacity = 100 },
            },
        })
        assert.are.same({
            { fillType = "WHEAT", level = 9000, capacity = 12500 },
            { fillType = "BARLEY", level = 5, capacity = NULL },
            { fillType = NULL, level = 0, capacity = 100 },
        }, snapshot(combine).fillUnits)
    end)

    it("uses null for everything a vehicle without a motor cannot answer", function()
        local trailer = Engine.newVehicle({ uniqueId = "vehicle9", name = "Krampe Bandit" })
        local state = snapshot(trailer)
        assert.are.equal(NULL, state.rpm)
        assert.are.equal(NULL, state.gear)
        assert.are.equal(NULL, state.fuelType)
        assert.are.equal(NULL, state.fuelPct)
        assert.are.equal(NULL, state.damagePct)
        assert.are.equal(NULL, state.operatingHours)
    end)

    it("survives a getter that throws", function()
        local tractor = helper.tractor()
        tractor.getDamageAmount = function()
            error("renamed in a patch")
        end
        tractor.getFullName = function()
            error("broken mod")
        end
        local state = snapshot(tractor)
        assert.are.equal(NULL, state.damagePct)
        assert.are.equal("tractor", state.name)
        assert.are.equal(62.5, state.fuelPct)
    end)

    it("flattens implements attached to implements", function()
        local trailer2 = Engine.newVehicle({ uniqueId = "t2", name = "Second trailer" })
        local trailer1 = Engine.newVehicle({ uniqueId = "t1", name = "First trailer", implements = { trailer2 } })
        local state = snapshot(helper.tractor({ implements = { trailer1 } }))
        assert.are.equal(2, #state.implements)
        assert.are.equal("t1", state.implements[1].vehicleId)
        assert.are.equal("t2", state.implements[2].vehicleId)
    end)

    it("writes a frame with vehicle null while the player is on foot", function()
        Engine.loadMission({})
        local frame = helper.decode(FarmLink.Json.encode(Collector.frame(FarmLink.ctx)))
        assert.are.equal(NULL, frame.vehicle)
        assert.are.equal(FarmLink.ctx.ledger.saveId, frame.saveId)
        assert.are.equal(1, frame.v)
        assert.are.equal(37, frame.day)
        assert.are.equal(845, frame.minute)
    end)
end)
