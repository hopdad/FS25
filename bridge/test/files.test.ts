import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { LiveVehicle, Meta } from "@farmlink/schema";
import { describe, expect, it } from "vitest";
import { readJsonFile } from "../src/watch/files";
import { frame, meta, tempRoot, tractor } from "./fixtures";

describe("readJsonFile", () => {
  it("reads and validates a complete file in one attempt", async () => {
    const path = join(tempRoot(), "meta.json");
    writeFileSync(path, JSON.stringify(meta()));
    const result = await readJsonFile(path, Meta);
    expect(result).toMatchObject({ ok: true, attempts: 1 });
  });

  it("reports a missing file without retrying", async () => {
    const result = await readJsonFile(join(tempRoot(), "nope.json"), Meta);
    expect(result).toMatchObject({ ok: false, reason: "missing", attempts: 1 });
  });

  it("does not retry a complete file that fails the schema", async () => {
    const path = join(tempRoot(), "live_vehicle.json");
    writeFileSync(path, JSON.stringify(frame({ ...tractor, fuelPct: 140 })));
    const result = await readJsonFile(path, LiveVehicle, { delayMs: 1 });
    expect(result).toMatchObject({ ok: false, reason: "invalid", attempts: 1 });
    expect(!result.ok && result.error).toBe(
      "vehicle.fuelPct: Too big: expected number to be <=100",
    );
  });

  it("retries a file caught mid-write and succeeds once the write completes", async () => {
    const path = join(tempRoot(), "live_vehicle.json");
    const text = JSON.stringify(frame(tractor));
    writeFileSync(path, text.slice(0, 40));
    setTimeout(() => writeFileSync(path, text), 30);
    const result = await readJsonFile(path, LiveVehicle, { retries: 3, delayMs: 25 });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBeGreaterThan(1);
  });

  it("gives up on a file that stays torn after the retries", async () => {
    const path = join(tempRoot(), "live_vehicle.json");
    writeFileSync(path, "");
    const result = await readJsonFile(path, LiveVehicle, { retries: 3, delayMs: 1 });
    expect(result).toMatchObject({ ok: false, reason: "parse", attempts: 4 });
  });

  it("ignores a byte-order mark", async () => {
    const path = join(tempRoot(), "meta.json");
    writeFileSync(path, `﻿${JSON.stringify(meta())}`);
    expect((await readJsonFile(path, Meta)).ok).toBe(true);
  });
});
