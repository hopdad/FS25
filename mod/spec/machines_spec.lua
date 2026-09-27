local helper = require("helper")
local lfs = require("lfs")

describe("the farm's machines", function()
    local Engine

    before_each(function()
        Engine = helper.freshMod()
    end)

    local function events(dir)
        dir = dir or FarmLink.ctx.saveDir .. "events/"
        local out = {}
        for name in lfs.dir(dir) do
            if name:match("%.ndjson$") then
                for line in Engine.readFile(dir .. name):gmatch("[^\n]+") do
                    out[#out + 1] = helper.decode(line)
                end
            end
        end
        table.sort(out, function(a, b)
            return a.seq < b.seq
        end)
        return out
    end

    local function machineEvents(dir)
        local out = {}
        for _, event in ipairs(events(dir)) do
            if event.type:match("^vehicle_") then
                out[#out + 1] = event
            end
        end
        return out
    end

    local function summary(dir)
        local out = {}
        for i, event in ipairs(machineEvents(dir)) do
            out[i] = { event.type, event.data.vehicleId }
        end
        return out
    end

    local function machine(id, opts)
        local o = { uniqueId = id, name = "Machine " .. id, operatingTimeMs = 0, implements = {} }
        for key, value in pairs(opts or {}) do
            o[key] = value
        end
        return Engine.newVehicle(o)
    end

    -- A tractor with its seeder, and a combine: the fleet a savegame loads with.
    local function fleet()
        local tractor = Engine.addVehicle(helper.tractor({ sellPrice = 180000 }))
        local combine = Engine.addVehicle(machine("combine1", { operatingTimeMs = 400 * 3600000, sellPrice = 250000 }))
        return tractor, combine
    end

    it("takes stock at the first poll: baseline hours for every machine it has not seen", function()
        Engine.loadMission({})
        fleet()
        -- Not the farm's machines: contract equipment, a pallet, and machines of farms without players.
        Engine.addVehicle(machine("lent1", { propertyState = 4 }))
        Engine.addVehicle(machine("pallet1", { listed = false }))
        Engine.addVehicle(machine("tour1", { farmId = 14 }))
        Engine.addVehicle(machine("spectator1", { farmId = 0 }))
        Engine.run(2.1, 100)

        local log = machineEvents()
        assert.are.same({
            { "vehicle_hours", "combine1" },
            { "vehicle_hours", "vehicle7f3a" },
            { "vehicle_hours", "vehicle91c0" },
        }, summary())
        assert.are.equal(1, log[1].farmId)
        assert.are.same({ vehicleId = "combine1", operatingHours = 400, sellValue = 250000 }, log[1].data)
        assert.are.same({ vehicleId = "vehicle7f3a", operatingHours = 412.7, sellValue = 180000 }, log[2].data)

        -- Nothing more until something changes.
        Engine.run(20, 100)
        assert.are.equal(3, #machineEvents())
    end)

    it("takes stock once the mission has started and the savegame's machines have loaded", function()
        Engine.loadMission({ isMissionStarted = false })
        g_currentMission.vehicleSystem.vehiclesToLoad = 1
        fleet()
        Engine.run(5, 100)
        assert.are.equal(0, #machineEvents())
        g_currentMission.isMissionStarted = true
        Engine.run(3, 100)
        assert.are.equal(0, #machineEvents())
        g_currentMission.vehicleSystem.vehiclesToLoad = 0
        Engine.run(3.1, 100)
        assert.are.equal(3, #machineEvents())
    end)

    it("writes a machine bought in the shop with the price booked for it", function()
        Engine.loadMission({})
        fleet()
        Engine.run(2.1, 100)
        Engine.buyVehicle(machine("vehicle3c1d", { name = "Kubota M7", price = 99000 }), 112500)
        Engine.run(2.1, 100)
        Engine.buyVehicle(machine("used1", { name = "Used Baler", operatingTimeMs = 250 * 3600000 }), 20000)
        Engine.run(3.1, 100)

        local added = machineEvents()
        assert.are.equal(5, #added)
        assert.are.equal("vehicle_added", added[4].type)
        assert.are.same({
            vehicleId = "vehicle3c1d",
            storeItem = "data/vehicles/vehicle3c1d.xml",
            name = "Kubota M7",
            price = 112500,
            leased = false,
        }, added[4].data)
        assert.are.equal(250, added[5].data.operatingHours)
        assert.are.equal(20000, added[5].data.price)
    end)

    it("waits for a booking that comes after the machine, and uses the store price if none comes", function()
        Engine.loadMission({})
        Engine.run(2.1, 100)
        Engine.addVehicle(machine("late1", { price = 70000 }))
        Engine.run(2.1, 100)
        assert.are.equal(0, #machineEvents())
        g_currentMission:addMoney(-68000, 1, MoneyType.SHOP_VEHICLE_BUY, true)
        Engine.run(3.1, 100)
        assert.are.equal(68000, machineEvents()[1].data.price)

        Engine.addVehicle(machine("free1", { price = 15000 }))
        Engine.run(8, 100)
        assert.are.equal(1, #machineEvents())
        Engine.run(6, 100)
        local free = machineEvents()[2]
        assert.are.equal("free1", free.data.vehicleId)
        assert.are.equal(15000, free.data.price)
    end)

    it("gives machines bought together their store prices, since they share one booking", function()
        Engine.loadMission({})
        Engine.run(2.1, 100)
        Engine.addVehicle(machine("rake1", { price = 22000 }))
        Engine.addVehicle(machine("tedder1", { price = 30000 }))
        g_currentMission:addMoney(-52000, 1, MoneyType.SHOP_VEHICLE_BUY, true)
        Engine.run(14, 100)
        local prices = {}
        for _, event in ipairs(machineEvents()) do
            prices[event.data.vehicleId] = event.data.price
        end
        assert.are.same({ rake1 = 22000, tedder1 = 30000 }, prices)
    end)

    it("writes a lease with the fee paid up front", function()
        Engine.loadMission({})
        Engine.run(2.1, 100)
        Engine.leaseVehicle(machine("mower1", { price = 60000 }), 2500)
        Engine.run(3.1, 100)
        local lease = machineEvents()[1]
        assert.are.same({ price = 2500, leased = true }, { price = lease.data.price, leased = lease.data.leased })

        -- Without a booking, what the game charges up front for that store price.
        local unbooked = machine("mower2", { price = 60000 })
        unbooked.propertyState = VehiclePropertyState.LEASED
        Engine.addVehicle(unbooked)
        Engine.run(14, 100)
        assert.are.equal(2400, machineEvents()[2].data.price)
    end)

    it("writes a sale with what it brought, whichever the game books first", function()
        Engine.loadMission({})
        local tractor, combine = fleet()
        Engine.run(2.1, 100)
        tractor.operatingTime = tractor.operatingTime + 2 * 3600000
        Engine.run(2.1, 100)
        Engine.sellVehicle(tractor, 150000)
        Engine.run(2.1, 100)
        g_currentMission:addMoney(240000, 1, MoneyType.SHOP_VEHICLE_SELL, true)
        Engine.removeVehicle(combine)
        Engine.run(3.1, 100)

        local log = machineEvents()
        assert.are.same({ "vehicle_removed", "vehicle_removed" }, { log[4].type, log[5].type })
        assert.are.same(
            { vehicleId = "vehicle7f3a", reason = "sold", operatingHours = 414.7, salePrice = 150000 },
            log[4].data
        )
        assert.are.same(
            { vehicleId = "combine1", reason = "sold", operatingHours = 400, salePrice = 240000 },
            log[5].data
        )
    end)

    it("waits before writing a machine gone without a sale; a leased one is given back", function()
        Engine.loadMission({})
        local _, combine = fleet()
        Engine.run(2.1, 100)
        local mower = Engine.leaseVehicle(machine("mower1"), 2500)
        Engine.run(2.1, 100)
        Engine.removeVehicle(combine)
        Engine.run(3.1, 100)
        assert.are.equal(4, #machineEvents())
        Engine.run(11, 100)
        assert.are.equal(5, #machineEvents())
        Engine.removeVehicle(mower)
        Engine.run(14, 100)

        local log = machineEvents()
        assert.are.same({ vehicleId = "combine1", reason = "deleted", operatingHours = 400 }, log[5].data)
        assert.are.same({ vehicleId = "mower1", reason = "returned", operatingHours = 0 }, log[6].data)
    end)

    it("does not take a machine reset to the shop for a sale and a purchase", function()
        Engine.loadMission({})
        local tractor = fleet()
        Engine.run(2.1, 100)
        -- The game deletes the machine and loads it again under the same id.
        Engine.removeVehicle(tractor)
        Engine.run(4.1, 100)
        local list = g_currentMission.vehicleSystem.vehicles
        list[#list + 1] = tractor
        Engine.run(20, 100)
        assert.are.equal(3, #machineEvents())
    end)

    it("writes the hours of every machine that worked, before the day's rollover", function()
        Engine.loadMission({})
        local tractor = fleet()
        Engine.run(2.1, 100)
        tractor.operatingTime = tractor.operatingTime + 1.5 * 3600000
        Engine.newDay()
        Engine.run(1.1)

        local log = events()
        local hours, rollover = {}, nil
        for _, event in ipairs(log) do
            if event.type == "vehicle_hours" then
                hours[#hours + 1] = event
            elseif event.type == "day_rollover" then
                rollover = event
            end
        end
        assert.are.equal(4, #hours)
        assert.are.same({ vehicleId = "vehicle7f3a", operatingHours = 414.2, sellValue = 180000 }, hours[4].data)
        assert.is_true(hours[4].seq < rollover.seq)

        Engine.newDay()
        Engine.run(1.1)
        assert.are.equal(4, #machineEvents())
    end)

    it("keeps the machines it knows in the savegame, and settles what waits before the save", function()
        Engine.loadMission({})
        local tractor, combine = fleet()
        Engine.run(2.1, 100)
        Engine.buyVehicle(machine("vehicle3c1d", { operatingTimeMs = 0 }), 112500)
        Engine.run(2.1, 100)
        tractor.operatingTime = tractor.operatingTime + 3600000
        Engine.removeVehicle(combine)
        Engine.saveCareer()

        local directory = g_currentMission.missionInfo.savegameDirectory
        local saved = FarmLink.Persistence.load(directory)
        assert.are.same({
            vehicle3c1d = { writtenMs = 0, farmId = 1 },
            vehicle7f3a = { writtenMs = math.floor(412.7 * 3600000 + 0.5), farmId = 1 },
            vehicle91c0 = { writtenMs = 0, farmId = 1 },
        }, saved.machines)
        local log = machineEvents()
        assert.are.equal("vehicle_removed", log[#log].type)
        assert.is_true(log[#log].seq <= saved.seq)

        -- The save loads again: the machines it knows are not new, and the tractor's hour is written
        -- at the next rollover.
        local dir = FarmLink.ctx.saveDir .. "events/"
        Engine.unloadMission()
        Engine.loadMission({ savegameDirectory = directory })
        tractor.operatingTime = 413.7 * 3600000
        Engine.addVehicle(tractor)
        Engine.addVehicle(machine("vehicle3c1d"))
        Engine.run(2.1, 100)
        Engine.newDay()
        Engine.run(1.1)
        local after = {}
        for _, event in ipairs(machineEvents(dir)) do
            if event.seq > saved.seq then
                after[#after + 1] = { event.type, event.data.vehicleId, event.data.operatingHours }
            end
        end
        assert.are.same({ { "vehicle_hours", "vehicle7f3a", 413.7 } }, after)
    end)
end)
