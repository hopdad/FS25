import type {
  Alert,
  BridgeStatus,
  LiveFarm,
  LiveFleet,
  LiveVehicle,
  ServerMessage,
} from "@farmlink/schema";
import { initialState, type LiveState, reduce } from "../src/store";

export const SAVE_ID = "6f1c2d3e-4a5b-4c6d-8e7f-0123456789ab";
export const SESSION_ID = "0d3c9a4e-7b1f-4e2a-9c8d-5f6e7a8b9c0d";
export const TS = "2026-09-26T11:04:05-04:00";
export const NOW = Date.parse("2026-09-26T15:05:00Z");

const header = { v: 1 as const, saveId: SAVE_ID, sessionId: SESSION_ID, realTs: TS, day: 37 };

export const status: BridgeStatus = {
  bridgeVersion: "0.2.0",
  gameOnline: true,
  saveId: SAVE_ID,
  saveName: "Riverbend Springs",
  mode: "host",
  modVersion: "0.2.0.0",
  gameVersion: "1.12.0.0",
};

export const vehicle: LiveVehicle = {
  ...header,
  minute: 845,
  vehicle: {
    vehicleId: "vehicle7f3a",
    name: "Fendt 942 Vario",
    speedKmh: 14.2,
    rpm: 1450,
    gear: "D",
    fuelType: "DIESEL",
    fuelPct: 8,
    damagePct: 3.1,
    operatingHours: 412.7,
    position: { x: 120.5, z: -40.2, heading: 90 },
    isAI: false,
    fillUnits: [],
    implements: [
      {
        vehicleId: "vehicle91c0",
        name: "Amazone Cirrus 6003",
        fillUnits: [{ fillType: "SEEDS", level: 2100, capacity: 3600 }],
      },
    ],
  },
};

export const fleet: LiveFleet = {
  ...header,
  minute: 846,
  fleet: {
    vehicles: [
      {
        vehicleId: "vehicle7f3a",
        name: "Fendt 942 Vario",
        farmId: 1,
        position: { x: 120.5, z: -40.2 },
        fuelPct: 8,
        damagePct: 3.1,
        controller: "player",
        attachedTo: null,
      },
      {
        vehicleId: "vehicle91c0",
        name: "Amazone Cirrus 6003",
        farmId: 1,
        position: { x: 118, z: -40.2 },
        fuelPct: null,
        damagePct: null,
        controller: "player",
        attachedTo: "vehicle7f3a",
      },
      {
        vehicleId: "vehicle55aa",
        name: "Claas Lexion 8900",
        farmId: 1,
        position: { x: 60, z: 12 },
        fuelPct: 44,
        damagePct: 0,
        controller: "ai",
        attachedTo: null,
      },
      {
        vehicleId: "vehicle0b0b",
        name: "John Deere 6R 150",
        farmId: 2,
        position: { x: -300, z: 80 },
        fuelPct: 90,
        damagePct: 12,
        controller: "idle",
        attachedTo: null,
      },
    ],
    jobs: [
      {
        jobId: "3",
        vehicleId: "vehicle55aa",
        farmId: 1,
        jobType: "FIELDWORK",
        helper: "Alex",
        fieldId: 12,
        progressPct: null,
        tankFillPct: 86,
        startedAt: "2026-09-26T10:30:00-04:00",
      },
    ],
    stops: [
      {
        stopId: 1,
        jobId: "1",
        vehicleId: "vehicle0b0b",
        farmId: 2,
        jobType: "FIELDWORK",
        helper: "Kim",
        reason: "ERROR_OUT_OF_MONEY",
        durationMin: 30,
        realTs: "2026-09-26T10:40:00-04:00",
        day: 37,
        minute: 700,
      },
      {
        stopId: 2,
        jobId: "2",
        vehicleId: "vehicle7f3a",
        farmId: 1,
        jobType: "FIELDWORK",
        helper: "Sam",
        reason: "ERROR_OUT_OF_FUEL",
        durationMin: 125,
        realTs: "2026-09-26T11:02:00-04:00",
        day: 37,
        minute: 840,
      },
    ],
  },
};

export const farm: LiveFarm = {
  ...header,
  minute: 840,
  farm: {
    farms: [
      {
        farmId: 2,
        name: "Hillside",
        balance: -5000,
        loan: 20000,
        storage: [],
        productions: [],
      },
      {
        farmId: 1,
        name: "Riverbend Farms",
        balance: 1250000,
        loan: 0,
        storage: [
          { fillType: "WHEAT", liters: 180000 },
          { fillType: "LIQUIDFERTILIZER", liters: 4200 },
        ],
        productions: [],
      },
    ],
    weather: {
      current: { type: "PARTIALLY_CLOUDY", temperatureC: 21.3 },
      forecast: [{ day: 38, type: "RAIN", minC: 9, maxC: 17 }],
    },
  },
};

export function alert(id: string, overrides: Partial<Alert> = {}): Alert {
  return {
    id,
    kind: "worker_stop",
    severity: "critical",
    title: "Worker stopped",
    message: "Sam on Fendt 942 Vario: out of fuel",
    vehicleId: "vehicle7f3a",
    jobId: "2",
    farmId: 1,
    at: "2026-09-26T15:02:01.000Z",
    ...overrides,
  };
}

/** A state built the way the page builds it: from the bridge's messages. */
export function stateFrom(messages: ServerMessage[], at = NOW): LiveState {
  let state = reduce(initialState(), { type: "connection", connection: "open" });
  for (const message of messages) state = reduce(state, { type: "message", message, at });
  return state;
}

export function fullState(): LiveState {
  return stateFrom([
    { type: "hello", bridgeVersion: "0.2.0" },
    { type: "status", status },
    { type: "alerts", alerts: [alert("stop:x:2")] },
    { type: "channel", channel: "vehicle", data: vehicle },
    { type: "channel", channel: "fleet", data: fleet },
    { type: "channel", channel: "farm", data: farm },
  ]);
}
