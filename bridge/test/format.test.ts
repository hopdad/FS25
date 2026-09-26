import { LiveVehicle } from "@farmlink/schema";
import { describe, expect, it } from "vitest";
import { formatVehicleFrame } from "../src/format";
import { frame, tractor } from "./fixtures";

describe("formatVehicleFrame", () => {
  it("prints one readable line per frame", () => {
    expect(formatVehicleFrame(LiveVehicle.parse(frame(tractor, 845)))).toBe(
      "day 37 14:05 | Fendt 942 Vario | 14.2 km/h | 1450 rpm | gear D | diesel 62.5% | damage 3.1% | 412.70 h | x 120.5 z -40.2 | WHEAT 900/unlimited | + Amazone Cirrus 6003 (SEEDS 2100/3600)",
    );
  });

  it("prints on foot when there is no vehicle", () => {
    expect(formatVehicleFrame(LiveVehicle.parse(frame(null, 5)))).toBe("day 37 00:05 | on foot");
  });

  it("leaves out what a vehicle without a motor cannot report", () => {
    const trailer = {
      ...tractor,
      rpm: null,
      gear: null,
      fuelType: null,
      fuelPct: null,
      damagePct: null,
      operatingHours: null,
      isAI: true,
      fillUnits: [],
      implements: [{ vehicleId: null, name: "Dolly", fillUnits: [] }],
    };
    expect(formatVehicleFrame(LiveVehicle.parse(frame(trailer)))).toBe(
      "day 37 14:05 | Fendt 942 Vario | 14.2 km/h | no motor | x 120.5 z -40.2 | AI | + Dolly",
    );
  });
});
