local helper = require("helper")

describe("fleet and farm channels", function()
    local Engine
    local NULL = helper.NULL

    before_each(function()
        Engine = helper.freshMod()
    end)

    local function fleetFile()
        return helper.readJson(FarmLink.ctx.saveDir .. "live_fleet.json")
    end

    describe("live_fleet.json", function()
        it("lists farm machines with their controller and what they are attached to", function()
            Engine.loadMission({})
            local seeder = Engine.newVehicle({ uniqueId = "vehicle91c0", name = "Amazone Cirrus 6003" })
            local tractor = Engine.addVehicle(helper.tractor({ implements = { seeder }, entered = true }))
            Engine.addVehicle(Engine.newVehicle({ uniqueId = "pallet1", listed = false }))
            Engine.addVehicle(Engine.newVehicle({ uniqueId = "lent1", propertyState = 4, listed = false }))
            Engine.addVehicle(Engine.newVehicle({ uniqueId = "npc1", farmId = 0 }))
            assert.is_not_nil(tractor)
            Engine.run(0.1)

            local vehicles = fleetFile().fleet.vehicles
            local ids = {}
            for _, row in ipairs(vehicles) do
                ids[#ids + 1] = row.vehicleId
            end
            assert.are.same({ "vehicle7f3a", "vehicle91c0", "lent1" }, ids)
            assert.are.equal("player", vehicles[1].controller)
            assert.are.equal(62.5, vehicles[1].fuelPct)
            assert.are.equal(NULL, vehicles[1].attachedTo)
            assert.are.equal("vehicle7f3a", vehicles[2].attachedTo)
            assert.are.equal("player", vehicles[2].controller)
            assert.are.equal(NULL, vehicles[2].fuelPct)
        end)

        it("detects AutoDrive and Courseplay from their own state, read-only", function()
            Engine.loadMission({})
            local ad = Engine.addVehicle(helper.tractor({ uniqueId = "ad1" }))
            ad.ad = {
                stateModule = {
                    isActive = function()
                        return true
                    end,
                },
            }
            local cp = Engine.addVehicle(helper.tractor({ uniqueId = "cp1" }))
            cp.getIsCpActive = function()
                return true
            end
            local ai = Engine.addVehicle(helper.tractor({ uniqueId = "ai1", isAI = true }))
            assert.are.equal("autodrive", FarmLink.Fleet.controller(ad))
            assert.are.equal("courseplay", FarmLink.Fleet.controller(cp))
            assert.are.equal("ai", FarmLink.Fleet.controller(ai))
        end)

        it("writes at once when a worker starts or stops, and carries the stop ring", function()
            Engine.loadMission({})
            Engine.run(0.1)
            local vehicle = Engine.addVehicle(helper.tractor({ uniqueId = "vehicle14", x = 30, fillUnits = {
                { fillType = "WHEAT", level = 9000, capacity = 10000 },
            } }))
            local job = Engine.newJob(nil, vehicle, 1)
            Engine.startJob(job)
            Engine.run(0.05)

            local running = fleetFile().fleet.jobs
            assert.are.equal(1, #running)
            assert.are.equal("vehicle14", running[1].vehicleId)
            assert.are.equal(90, running[1].tankFillPct)
            assert.are.equal(12, running[1].fieldId)
            assert.are.equal(NULL, running[1].progressPct)

            Engine.stopJob(job, Engine.AIMessages.ERROR_UNLOADINGSTATION_FULL.new())
            Engine.run(0.05)
            local fleet = fleetFile().fleet
            assert.are.equal(0, #fleet.jobs)
            assert.are.equal("ERROR_UNLOADINGSTATION_FULL", fleet.stops[1].reason)
            assert.are.equal(1, fleet.stops[1].stopId)
        end)

        it("carries the mission's session id", function()
            Engine.loadMission({})
            Engine.run(0.1)
            local first = fleetFile().sessionId
            assert.is_true(FarmLink.Ids.isUuid(first))
            Engine.unloadMission()
            Engine.loadMission({ savegameDirectory = nil })
            Engine.run(0.1)
            assert.are_not.equal(first, fleetFile().sessionId)
        end)
    end)

    describe("live_farm.json", function()
        it("reports each real farm's money, silo stocks and productions, and the weather", function()
            Engine.loadMission({})
            g_farmManager:getFarmById(1).loan = 50000
            Engine.run(0.1)
            local frame = helper.readJson(FarmLink.ctx.saveDir .. "live_farm.json")
            local farms = frame.farm.farms
            assert.are.equal(1, #farms)
            assert.are.same({
                farmId = 1,
                name = "Riverbend Farms",
                balance = 100000,
                loan = 50000,
                storage = { { fillType = "WHEAT", liters = 180000.4 } },
                productions = {
                    { id = "placeable7", name = "Grain Mill", stocks = { { fillType = "FLOUR", liters = 3000 } } },
                },
            }, farms[1])
            assert.are.same({ type = "SUN", temperatureC = 21.3 }, frame.farm.weather.current)
            assert.are.equal(4, #frame.farm.weather.forecast)
            assert.are.same({ day = 38, type = "RAIN", minC = 9, maxC = 17 }, frame.farm.weather.forecast[1])
        end)

        it("leaves out the spectator and guided-tour farms the game hides", function()
            local isPlayerFarm = FarmLink.FarmCollector.isPlayerFarm
            assert.is_true(isPlayerFarm({ farmId = 1 }))
            assert.is_false(isPlayerFarm({ farmId = 0 }))
            assert.is_false(isPlayerFarm({ farmId = 14 }))
            assert.is_false(isPlayerFarm({ farmId = 3, isSpectator = true }))
            _G.FarmManager = { GUIDED_TOUR_FARM_ID = 15 }
            assert.is_true(isPlayerFarm({ farmId = 14 }))
            assert.is_false(isPlayerFarm({ farmId = 15 }))
            _G.FarmManager = nil
        end)

        it("still writes the file when the weather cannot be read", function()
            Engine.loadMission({})
            g_currentMission.environment.weather = nil
            Engine.run(0.1)
            local frame = helper.readJson(FarmLink.ctx.saveDir .. "live_farm.json")
            assert.are.equal(NULL, frame.farm.weather.current)
            assert.are.same({}, frame.farm.weather.forecast)
        end)
    end)
end)
