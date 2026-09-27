import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  Ack,
  BridgeHeartbeat,
  CONTRACTS,
  Command,
  EventEnvelope,
  ExportRequest,
  LiveFarm,
  LiveFleet,
  LiveVehicle,
  Meta,
} from "../src/index";
import { renderJsonSchemas } from "../src/jsonSchema";

const SAVE = "6f1c2d3e-4a5b-4c6d-8e7f-0123456789ab";
const BRANCH = "a02e7c1d-9b8a-4f6e-a5d4-c3b2a1908f7e";
const TS = "2026-09-26T11:04:05-04:00";

const envelope = (type: string, data: unknown, seq = 1042) => ({
  v: 1,
  saveId: SAVE,
  branchId: BRANCH,
  seq,
  day: 37,
  minute: 845,
  year: 2,
  realTs: TS,
  farmId: 1,
  userId: null,
  type,
  data,
});

const SESSION = "0d3c9a4e-7b1f-4e2a-9c8d-5f6e7a8b9c0d";
const header = { v: 1, saveId: SAVE, sessionId: SESSION, realTs: TS, day: 37, minute: 845 };

const tractor = {
  vehicleId: "vehicle7f3a",
  name: "Fendt 942 Vario",
  speedKmh: 14.2,
  rpm: 1450,
  gear: "D",
  fuelType: "DIESEL",
  fuelPct: 62.5,
  damagePct: 3.1,
  operatingHours: 412.7,
  position: { x: -312.4, y: 88.1, z: 1204.9, heading: 271.5 },
  isAI: false,
  fillUnits: [],
  implements: [
    {
      vehicleId: "vehicle91c0",
      name: "Amazone Cirrus 6003",
      fillUnits: [{ fillType: "WHEAT", level: 2100, capacity: 3600 }],
    },
  ],
};

describe("event envelope", () => {
  it("accepts the handoff's harvest example", () => {
    const line = envelope("harvest", {
      fieldId: 12,
      farmlandId: 12,
      fillType: "WHEAT",
      liters: 18450,
      vehicleId: "v14",
      isAI: true,
    });
    expect(EventEnvelope.parse(line).type).toBe("harvest");
  });

  it("accepts every v1 event type", () => {
    const samples = [
      envelope("money", {
        amount: 5120.5,
        moneyType: "SOLD_PRODUCTS",
        context: { kind: "sale", stationId: "placeable12", fillType: "WHEAT", liters: 18450 },
      }),
      envelope("money", {
        amount: -412.3,
        moneyType: "AI",
        context: { kind: "wage", jobId: "9", vehicleId: "v14" },
        count: 7,
      }),
      envelope("money", { amount: -12, moneyType: "OTHER", context: { kind: "none" } }),
      envelope("field_work", {
        fieldId: null,
        farmlandId: 31,
        workType: "seeding",
        areaHa: 4.2,
        inputFillType: "SEEDS",
        inputLiters: 610,
        vehicleId: "v14",
        isAI: false,
      }),
      envelope("vehicle_added", {
        vehicleId: "v20",
        storeItem: "data/vehicles/fendt/vario900/vario900.xml",
        name: "Fendt 942 Vario",
        price: 412000,
        leased: false,
      }),
      envelope("vehicle_removed", {
        vehicleId: "v20",
        reason: "sold",
        operatingHours: 88.5,
        salePrice: 301000,
      }),
      envelope("vehicle_removed", { vehicleId: "v21", reason: "returned", operatingHours: 6 }),
      envelope("vehicle_hours", { vehicleId: "v20", operatingHours: 90.25 }),
      envelope("worker_start", { jobId: "9", vehicleId: "v14", jobType: "FIELDWORK", fieldId: 12 }),
      envelope("worker_stop", {
        jobId: "9",
        vehicleId: "v14",
        reason: "ERROR_OUT_OF_FUEL",
        durationMin: 94.5,
        wagesTotal: 812.4,
      }),
      envelope("prices", {
        entries: [{ stationId: "placeable3", fillType: "WHEAT", pricePer1000L: 212.5 }],
      }),
      envelope("day_rollover", {
        balance: 1250000,
        loan: 0,
        financeByCategory: { harvestIncome: 5120.5, wagePayment: -812.4 },
        period: 4,
        dayInPeriod: 1,
        daysPerPeriod: 3,
      }),
      envelope("session", {
        modVersion: "0.1.0.0",
        gameVersion: "1.12.0.0",
        integrations: ["FS25_Courseplay"],
        period: 4,
        dayInPeriod: 1,
        daysPerPeriod: 3,
        parentBranchId: SAVE,
        forkSeq: 1000,
      }),
      envelope("money", {
        amount: -310.2,
        moneyType: "PURCHASE_SEEDS",
        context: { kind: "input", fillType: "SEEDS", liters: 450, fieldId: 12, vehicleId: "v14" },
      }),
      envelope("money", {
        amount: -1840,
        moneyType: "VEHICLE_REPAIR",
        context: { kind: "vehicle", vehicleId: "v14" },
      }),
      envelope("harvest", {
        fieldId: 12,
        farmlandId: 12,
        fillType: "WHEAT",
        liters: 9000,
        vehicleId: "v14",
        isAI: false,
        workedHours: 0.4,
      }),
      envelope("vehicle_hours", { vehicleId: "v20", operatingHours: 91, sellValue: 318000 }),
    ];
    for (const sample of samples) {
      const result = EventEnvelope.safeParse(sample);
      expect(result.error?.issues ?? [], sample.type).toEqual([]);
    }
  });

  it("rejects a seq of zero, a minute past the end of the day and an unknown type", () => {
    const base = envelope("vehicle_hours", { vehicleId: "v1", operatingHours: 1 });
    expect(EventEnvelope.safeParse({ ...base, seq: 0 }).success).toBe(false);
    expect(EventEnvelope.safeParse({ ...base, minute: 1440 }).success).toBe(false);
    expect(EventEnvelope.safeParse({ ...base, type: "speedometer" }).success).toBe(false);
  });

  it("rejects an offset without a colon, which is what strftime %z produces", () => {
    const line = envelope("vehicle_hours", { vehicleId: "v1", operatingHours: 1 });
    expect(EventEnvelope.safeParse({ ...line, realTs: "2026-09-26T11:04:05-0400" }).success).toBe(
      false,
    );
    expect(EventEnvelope.safeParse({ ...line, realTs: "2026-09-26T11:04:05" }).success).toBe(true);
  });

  it("rejects money whose context kind does not match its fields", () => {
    const line = envelope("money", {
      amount: -50,
      moneyType: "PURCHASE_FUEL",
      context: { kind: "fuel", stationId: "placeable1" },
    });
    expect(EventEnvelope.safeParse(line).success).toBe(false);
  });
});

describe("live channels", () => {
  it("accepts a vehicle frame and an on-foot frame", () => {
    expect(LiveVehicle.parse({ ...header, vehicle: tractor }).vehicle?.name).toBe(
      "Fendt 942 Vario",
    );
    expect(LiveVehicle.parse({ ...header, vehicle: null }).vehicle).toBeNull();
  });

  it("accepts an unlimited fill unit as a null capacity", () => {
    const combine = {
      ...tractor,
      fillUnits: [{ fillType: "WHEAT", level: 900, capacity: null }],
    };
    expect(LiveVehicle.safeParse({ ...header, vehicle: combine }).success).toBe(true);
  });

  it("rejects a fuel percentage above 100", () => {
    const frame = { ...header, vehicle: { ...tractor, fuelPct: 100.5 } };
    expect(LiveVehicle.safeParse(frame).success).toBe(false);
  });

  it("accepts fleet and farm frames", () => {
    const fleet = {
      ...header,
      fleet: {
        vehicles: [
          {
            vehicleId: "v14",
            name: "Claas Lexion 8900",
            farmId: 1,
            position: { x: 1, z: 2 },
            fuelPct: 8.5,
            damagePct: 0,
            controller: "ai",
            attachedTo: null,
          },
        ],
        jobs: [
          {
            jobId: "9",
            vehicleId: "v14",
            farmId: 1,
            jobType: "FIELDWORK",
            helper: "Alex",
            fieldId: 12,
            progressPct: null,
            tankFillPct: 91,
            startedAt: TS,
          },
        ],
        stops: [
          {
            stopId: 1,
            jobId: "8",
            vehicleId: "v15",
            farmId: 1,
            jobType: "FIELDWORK",
            helper: "Sam",
            reason: "ERROR_OUT_OF_FUEL",
            durationMin: 42.5,
            realTs: TS,
            day: 37,
            minute: 840,
          },
        ],
      },
    };
    const farm = {
      ...header,
      farm: {
        farms: [
          {
            farmId: 1,
            name: "Riverbend Farms",
            balance: 1250000,
            loan: 0,
            storage: [{ fillType: "WHEAT", liters: 180000 }],
            productions: [
              {
                id: "placeable7",
                name: "Grain Mill",
                stocks: [{ fillType: "FLOUR", liters: 3000 }],
              },
            ],
          },
        ],
        weather: {
          current: { type: "SUN", temperatureC: 21 },
          forecast: [{ day: 38, type: "RAIN", minC: 9, maxC: 17 }],
        },
      },
    };
    expect(LiveFleet.safeParse(fleet).error?.issues ?? []).toEqual([]);
    expect(LiveFarm.safeParse(farm).error?.issues ?? []).toEqual([]);
  });

  it("requires the session id that tells a restarted game apart", () => {
    const { sessionId: _, ...withoutSession } = header;
    expect(LiveVehicle.safeParse({ ...withoutSession, vehicle: null }).success).toBe(false);
  });
});

describe("meta", () => {
  const meta = {
    v: 1,
    modVersion: "0.1.0.0",
    gameVersion: "1.12.0.0",
    saveId: SAVE,
    branchId: BRANCH,
    schemaVersion: 1,
    lastSeq: 0,
    heads: {},
    heartbeat: TS,
    beat: 3,
    mode: "singleplayer",
    saveName: "Riverbend Springs",
    savegameIndex: 2,
  };

  it("accepts a P0 meta file with empty heads", () => {
    expect(Meta.parse(meta).heads).toEqual({});
  });

  it("requires branch heads to be keyed by UUID", () => {
    expect(Meta.safeParse({ ...meta, heads: { [BRANCH]: 12 } }).success).toBe(true);
    expect(Meta.safeParse({ ...meta, heads: { main: 12 } }).success).toBe(false);
  });
});

describe("command channel", () => {
  it("accepts the handoff's command and ack examples", () => {
    const command = {
      v: 1,
      id: 57,
      issuedAt: "2026-09-26T15:04:05Z",
      ttlSec: 30,
      farmId: 1,
      type: "worker.stop",
      args: { jobId: "j9" },
    };
    const ack = { v: 1, id: 57, status: "ok", message: null, at: "2026-09-26T15:04:06Z" };
    expect(Command.parse(command).type).toBe("worker.stop");
    expect(Ack.parse(ack).status).toBe("ok");
  });

  it("rejects worker.stop without a job id", () => {
    const command = {
      v: 1,
      id: 58,
      issuedAt: TS,
      ttlSec: 30,
      farmId: 1,
      type: "worker.stop",
      args: {},
    };
    expect(Command.safeParse(command).success).toBe(false);
  });

  it("accepts a bridge heartbeat and an export request", () => {
    expect(
      BridgeHeartbeat.safeParse({
        v: 1,
        bridgeVersion: "0.1.0",
        beat: 1,
        realTs: TS,
        features: ["xlsx"],
      }).success,
    ).toBe(true);
    expect(
      ExportRequest.safeParse({
        v: 1,
        id: "a1b2",
        requestedAt: TS,
        saveId: SAVE,
        saveName: "Riverbend Springs",
        day: 37,
        format: "xlsx",
      }).success,
    ).toBe(true);
  });
});

describe("JSON Schema export", () => {
  it("covers every contract", () => {
    expect(Object.keys(renderJsonSchemas()).sort()).toEqual(Object.keys(CONTRACTS).sort());
  });

  it("matches the committed json-schema/ files (run `pnpm json-schema` after changing a contract)", () => {
    for (const [name, text] of Object.entries(renderJsonSchemas())) {
      const committed = readFileSync(
        new URL(`../json-schema/${name}.schema.json`, import.meta.url),
        "utf8",
      );
      expect(committed, name).toBe(text);
    }
  });
});

describe("ledger golden fixtures", () => {
  it("hold only valid event lines, in seq order without gaps", async () => {
    const { ledgerFixtures } = await import("../fixtures/ledger");
    const fixtures = ledgerFixtures();
    expect(fixtures.map((f) => f.name)).toEqual([
      "field_season",
      "fleet",
      "reconciliation",
      "worker_downtime",
    ]);
    for (const fixture of fixtures) {
      expect(fixture.events.map((e) => e.seq)).toEqual(fixture.events.map((_, i) => i + 1));
      expect(Object.keys(fixture.expect).length, fixture.name).toBeGreaterThan(0);
    }
  });
});
