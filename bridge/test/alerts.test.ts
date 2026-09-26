import { type Alert, LiveFleet } from "@farmlink/schema";
import { describe, expect, it } from "vitest";
import { AlertEngine, describeReason, tankEtaSeconds } from "../src/live/alerts";
import { aiJob, combineRow, fleetFrame, SESSION_ID, stopEntry, tractorRow } from "./fixtures";

// TS in the fixtures is 15:04:05Z; "now" is 55 s later.
const NOW = Date.parse("2026-09-26T15:05:00Z");
const OTHER_SESSION = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

function fleet(parts: Parameters<typeof fleetFrame>[0], sessionId = SESSION_ID) {
  return LiveFleet.parse(fleetFrame(parts, sessionId));
}

const kinds = (alerts: Alert[]) => alerts.map((a) => a.kind);

describe("worker stop alerts", () => {
  it("alerts on a worker that ran out of fuel, in words", () => {
    const engine = new AlertEngine();
    const alerts = engine.onFleet(fleet({ stops: [stopEntry(1, "ERROR_OUT_OF_FUEL")] }), NOW);
    expect(alerts).toEqual([
      {
        id: `stop:${SESSION_ID}:1`,
        kind: "worker_stop",
        severity: "critical",
        title: "Worker stopped",
        message: "Alex on Claas Lexion 8900: out of fuel",
        vehicleId: "vehicle55aa",
        jobId: "9",
        farmId: 1,
        at: "2026-09-26T15:05:00.000Z",
      },
    ]);
  });

  it("alerts once per stop, and never for a worker the player stopped", () => {
    const engine = new AlertEngine();
    const first = fleet({ stops: [stopEntry(1, "SUCCESS_STOPPED_BY_USER")] });
    expect(engine.onFleet(first, NOW)).toEqual([]);
    const second = fleet({
      stops: [stopEntry(1, "SUCCESS_STOPPED_BY_USER"), stopEntry(2, "SUCCESS_FINISHED_JOB")],
    });
    const alerts = engine.onFleet(second, NOW + 5000);
    expect(alerts).toMatchObject([
      {
        kind: "worker_stop",
        severity: "info",
        title: "Worker finished",
        message: "Alex on Claas Lexion 8900: job finished",
      },
    ]);
    expect(engine.onFleet(second, NOW + 10_000)).toEqual([]);
  });

  it("skips stops that were already old when the bridge first saw the session", () => {
    const engine = new AlertEngine();
    const old = stopEntry(1, "ERROR_OUT_OF_FUEL", "2026-09-26T10:50:00-04:00");
    expect(engine.onFleet(fleet({ stops: [old] }), NOW)).toEqual([]);
    // Once the session is known, every new stop counts, whatever its timestamp says.
    const late = stopEntry(2, "ERROR_OUT_OF_MONEY", "2026-09-26T10:50:00-04:00");
    expect(kinds(engine.onFleet(fleet({ stops: [old, late] }), NOW + 5000))).toEqual([
      "worker_stop",
    ]);
  });

  it("starts over when the game starts a new session", () => {
    const engine = new AlertEngine();
    const stops = [stopEntry(1, "ERROR_OUT_OF_FUEL")];
    expect(kinds(engine.onFleet(fleet({ stops }), NOW))).toEqual(["worker_stop"]);
    const alerts = engine.onFleet(fleet({ stops }, OTHER_SESSION), NOW + 5000);
    expect(alerts.map((a) => a.id)).toEqual([`stop:${OTHER_SESSION}:1`]);
  });

  it("names the job type when the vehicle is gone", () => {
    const engine = new AlertEngine();
    const alerts = engine.onFleet(
      fleet({ vehicles: [tractorRow], stops: [stopEntry(1, "ERROR_VEHICLE_BROKEN")] }),
      NOW,
    );
    expect(alerts[0]?.message).toBe("Alex on fieldwork job: vehicle broken down");
  });

  it("describes reasons the game may add later from their names", () => {
    expect(describeReason("ERROR_GRAINTANK_IS_FULL")).toBe("grain tank full");
    expect(describeReason("ERROR_TRAILER_TOO_SMALL")).toBe("trailer too small");
    expect(describeReason("SUCCESS_FIELD_DONE")).toBe("field done");
  });
});

describe("fuel alerts", () => {
  const withFuel = (fuelPct: number, controller = "ai") =>
    fleet({ vehicles: [{ ...combineRow, fuelPct, controller }, tractorRow] });

  it("alerts once when a vehicle the AI drives drops under 10 %, and again after refuelling", () => {
    const engine = new AlertEngine();
    expect(engine.onFleet(withFuel(11), NOW)).toEqual([]);
    const alerts = engine.onFleet(withFuel(9.4), NOW + 5000);
    expect(alerts).toMatchObject([
      {
        kind: "fuel_low",
        severity: "warning",
        message: "Claas Lexion 8900: 9 % fuel left",
        vehicleId: "vehicle55aa",
        farmId: 1,
      },
    ]);
    expect(engine.onFleet(withFuel(8), NOW + 10_000)).toEqual([]);
    expect(engine.onFleet(withFuel(12), NOW + 15_000)).toEqual([]);
    expect(engine.onFleet(withFuel(9), NOW + 20_000)).toEqual([]);
    expect(engine.onFleet(withFuel(60), NOW + 25_000)).toEqual([]);
    expect(kinds(engine.onFleet(withFuel(9), NOW + 30_000))).toEqual(["fuel_low"]);
  });

  it("names the worker when a job drives the vehicle", () => {
    const engine = new AlertEngine();
    const frame = fleet({
      vehicles: [{ ...combineRow, fuelPct: 5, controller: "idle" }],
      jobs: [aiJob({ tankFillPct: null })],
    });
    expect(engine.onFleet(frame, NOW)[0]).toMatchObject({
      message: "Claas Lexion 8900: 5 % fuel left, driven by Alex",
      jobId: "1",
    });
  });

  it("leaves vehicles the player drives, or that are parked, to the player", () => {
    const engine = new AlertEngine();
    expect(engine.onFleet(withFuel(3, "player"), NOW)).toEqual([]);
    expect(engine.onFleet(withFuel(3, "idle"), NOW + 5000)).toEqual([]);
    expect(kinds(engine.onFleet(withFuel(3, "courseplay"), NOW + 10_000))).toEqual(["fuel_low"]);
  });
});

describe("tank alerts", () => {
  const withTank = (tankFillPct: number | null) => fleet({ jobs: [aiJob({ tankFillPct })] });

  it("estimates the time to full from the recent fill rate", () => {
    const samples = [0, 5, 10, 15].map((s) => ({ t: s * 1000, pct: 60 + s }));
    expect(tankEtaSeconds(samples)).toBeCloseTo(25, 6);
    expect(tankEtaSeconds(samples.slice(0, 2))).toBeUndefined();
    expect(tankEtaSeconds(samples.map((s) => ({ ...s, pct: 60 })))).toBeUndefined();
    expect(tankEtaSeconds(samples.map((s) => ({ ...s, pct: 100 - s.pct })))).toBeUndefined();
  });

  it("alerts when the tank will be full within 2 minutes, once per fill", () => {
    const engine = new AlertEngine();
    const raised: Alert[] = [];
    // 0.1 % per second: 2 minutes before full is 88 %.
    let pct = 80;
    for (let second = 0; second <= 120; second += 5, pct += 0.5) {
      const alerts = engine.onFleet(withTank(pct), NOW + second * 1000);
      if (alerts.length > 0) expect(pct).toBeGreaterThanOrEqual(88);
      raised.push(...alerts);
    }
    expect(raised).toHaveLength(1);
    expect(raised[0]?.message).toMatch(
      /^Alex on Claas Lexion 8900: 8[89] % full, full in about 2 min$/,
    );
    expect(raised[0]).toMatchObject({
      kind: "tank_full_soon",
      title: "Tank almost full",
      jobId: "1",
      farmId: 1,
    });

    // Unloaded, then filling fast: a new alert for the new fill.
    expect(engine.onFleet(withTank(10), NOW + 125_000)).toEqual([]);
    const again: Alert[] = [];
    for (let i = 1; i <= 6; i++)
      again.push(...engine.onFleet(withTank(10 + i * 15), NOW + 125_000 + i * 5000));
    expect(kinds(again)).toEqual(["tank_full_soon"]);
    expect(again[0]?.message).toMatch(/full in less than a minute/);
  });

  it("stays quiet for a tank that is not filling, is already full or reports no level", () => {
    const engine = new AlertEngine();
    for (let i = 0; i < 10; i++) {
      expect(engine.onFleet(withTank(95), NOW + i * 5000)).toEqual([]);
    }
    const other = new AlertEngine();
    for (let i = 0; i < 10; i++) {
      expect(other.onFleet(withTank(100), NOW + i * 5000)).toEqual([]);
      expect(other.onFleet(withTank(null), NOW + i * 5000 + 1)).toEqual([]);
    }
  });
});

describe("game offline alerts", () => {
  it("alerts once per outage, and only after the game was online", () => {
    const engine = new AlertEngine();
    expect(engine.onOffline(NOW)).toEqual([]);
    engine.markOnline();
    expect(engine.onOffline(NOW)).toMatchObject([
      { kind: "game_offline", severity: "warning", vehicleId: null, jobId: null, farmId: null },
    ]);
    expect(engine.onOffline(NOW + 1000)).toEqual([]);
    engine.markOnline();
    expect(kinds(engine.onOffline(NOW + 2000))).toEqual(["game_offline"]);
  });
});
