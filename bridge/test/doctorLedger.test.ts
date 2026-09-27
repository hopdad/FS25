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

  it("waits for a probe.json that carries the ledger section", () => {
    expect(ledgerChecks(undefined, undefined)).toMatchObject([
      { id: "ledger", status: "pending", phase: "P2" },
    ]);
  });
});
