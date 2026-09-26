import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SAVE_ID = "6f1c2d3e-4a5b-4c6d-8e7f-0123456789ab";
export const BRANCH_ID = "a02e7c1d-9b8a-4f6e-a5d4-c3b2a1908f7e";

export function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "farmlink-"));
}

export function meta(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    modVersion: "0.1.0.0",
    gameVersion: "1.12.0.0",
    saveId: SAVE_ID,
    branchId: BRANCH_ID,
    schemaVersion: 1,
    lastSeq: 0,
    heads: {},
    heartbeat: "2026-09-26T11:04:05-04:00",
    beat: 1,
    mode: "singleplayer",
    saveName: "Riverbend Springs",
    savegameIndex: 1,
    ...overrides,
  };
}

export function frame(vehicle: unknown = null, minute = 845) {
  return {
    v: 1,
    saveId: SAVE_ID,
    realTs: "2026-09-26T11:04:05-04:00",
    day: 37,
    minute,
    vehicle,
  };
}

export const tractor = {
  vehicleId: "vehicle7f3a",
  name: "Fendt 942 Vario",
  speedKmh: 14.2,
  rpm: 1450,
  gear: "D",
  fuelType: "DIESEL",
  fuelPct: 62.5,
  damagePct: 3.1,
  operatingHours: 412.7,
  position: { x: 120.5, y: 88.1, z: -40.2, heading: 90 },
  isAI: false,
  fillUnits: [{ fillType: "WHEAT", level: 900, capacity: null }],
  implements: [
    {
      vehicleId: "vehicle91c0",
      name: "Amazone Cirrus 6003",
      fillUnits: [{ fillType: "SEEDS", level: 2100, capacity: 3600 }],
    },
  ],
};

/** Writes a save folder the way the mod lays it out and returns its path. */
export function writeSave(root: string, saveId = SAVE_ID, files: Record<string, unknown> = {}) {
  const dir = join(root, saveId);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof content === "string" ? content : JSON.stringify(content));
  }
  return dir;
}
