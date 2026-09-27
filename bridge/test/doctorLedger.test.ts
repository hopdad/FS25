import { describe, expect, it } from "vitest";
import { ledgerChecks } from "../src/doctorLedger";

function probe(ledger: unknown) {
  return { v: 1, generatedAt: "x", modVersion: "0.2.0.0", sections: { ledger } };
}

const quiet = {
  updates: { calls: 900, whilePaused: 0, gaps: [], maxGapMs: 40 },
  handle: { opened: true, flush: "function", firstWrite: "ok" },
  sales: { hooked: true, calls: 0, samples: [] },
  fuel: { hooked: true, calls: 0, liters: 0 },
  farmStats: { wrap: "wrapped", byStat: {} },
  messages: { counts: { DAY_CHANGED: { count: 0 } }, days: [] },
  prices: {
    atStart: {
      sellingPoints: 3,
      samples: [{ fillType: "WHEAT", station: "Mill", pricePerLiter: 0.4 }],
    },
  },
  money: { byType: {} },
};

const status = (checks: ReturnType<typeof ledgerChecks>) =>
  Object.fromEntries(checks.map((c) => [c.id, c.status]));

describe("--doctor's P2 checks", () => {
  it("asks for what the session has not shown yet", () => {
    const checks = ledgerChecks(probe(quiet), "one\n");
    expect(status(checks)).toEqual({
      pause: "pending",
      handle: "pending",
      sales: "pending",
      fuel: "pending",
      farmStats: "pending",
      day: "pending",
      prices: "pass",
      moneyContext: "pending",
      workListeners: "pending",
      finances: "pending",
      shopOrder: "pending",
      moneyTypes: "pending",
    });
    expect(checks.find((c) => c.id === "pause")?.detail).toBe(
      "pause the game for 20 s during the session",
    );
    expect(checks.every((c) => c.phase === "P2")).toBe(true);
  });

  it("reads a mod that keeps running while paused as a yes", () => {
    const checks = ledgerChecks(
      probe({ ...quiet, updates: { ...quiet.updates, whilePaused: 1200 } }),
      undefined,
    );
    expect(checks.find((c) => c.id === "pause")).toMatchObject({
      status: "pass",
      detail: "yes: 1200 updates ran while paused",
    });
  });

  it("fails when the kept-open handle could not be written", () => {
    const refused = ledgerChecks(
      probe({ ...quiet, handle: { opened: false, error: "denied" } }),
      undefined,
    );
    expect(refused.find((c) => c.id === "handle")).toMatchObject({
      status: "fail",
      detail: "io.open failed: denied",
    });
    const lost = ledgerChecks(
      probe({ ...quiet, handle: { opened: true, secondWrite: "closed file" } }),
      "one\n",
    );
    expect(lost.find((c) => c.id === "handle")?.status).toBe("fail");
  });

  it("reports the money context, the work listeners, the month's finances and a purchase", () => {
    const checks = ledgerChecks(
      probe({
        ...quiet,
        context: {
          hooks: {
            "AIJob.updateCost": "wrapped",
            "AIJob.stop": "wrapped",
            "SowingMachine.onEndWorkAreaProcessing": "wrapped",
          },
          calls: { wage: 40, sowing: 12 },
          byMoneyType: {
            AI: { wage: { calls: 5, total: -130 } },
            VEHICLE_REPAIR: { none: { calls: 1, total: -1840 } },
            OTHER: { none: { calls: 2, total: -4 } },
          },
          workedHa: { sowing: 1.25 },
        },
        finances: {
          order: ["DAY_CHANGED", "PERIOD_CHANGED"],
          snapshots: [
            { message: "DAY_CHANGED", current: -130, historyLength: 0 },
            { message: "PERIOD_CHANGED", current: 0, historyLength: 1, lastArchived: -130 },
          ],
        },
        shop: {
          bookings: [{ moneyType: "SHOP_VEHICLE_BUY", frame: 900, vehicles: 7 }],
          vehicleAdded: [{ frame: 912, vehicles: 8 }],
        },
      }),
      undefined,
    );
    const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
    expect(byId.moneyContext).toMatchObject({
      status: "pass",
      detail: "AI 5/5 in wage, VEHICLE_REPAIR 0/1 in repair",
    });
    expect(byId.workListeners).toMatchObject({
      status: "pass",
      detail: "SowingMachine ×12 (1.25 ha)",
    });
    expect(byId.finances?.detail).toBe(
      "order DAY_CHANGED → PERIOD_CHANGED; at the last DAY_CHANGED the month so far was -130 with 0 months archived; PERIOD_CHANGED left 0 and 1 archived (last -130)",
    );
    expect(byId.shopOrder?.detail).toBe(
      "SHOP_VEHICLE_BUY at frame 900 with 7 machines; VEHICLE_ADDED at frame 912 with 8",
    );
  });

  it("fails the work listeners when a hook could not be installed", () => {
    const checks = ledgerChecks(
      probe({ ...quiet, context: { hooks: { "Sprayer.onEndWorkAreaProcessing": "missing" } } }),
      undefined,
    );
    expect(checks.find((c) => c.id === "workListeners")).toMatchObject({
      status: "fail",
      detail: "not hooked: Sprayer.onEndWorkAreaProcessing",
    });
  });

  it("waits for a probe.json that carries the ledger section", () => {
    expect(ledgerChecks(undefined, undefined)).toMatchObject([
      { id: "ledger", status: "pending", phase: "P2" },
    ]);
  });
});
