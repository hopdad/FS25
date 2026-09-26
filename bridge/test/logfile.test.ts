import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileLogger } from "../src/logfile";
import { tempRoot } from "./fixtures";

describe("fileLogger", () => {
  it("appends timestamped lines", () => {
    const path = join(tempRoot(), "bridge.log");
    const log = fileLogger(path, () => new Date("2026-09-26T15:04:05.000Z"));
    log("following save 6f1c2d3e");
    log("alert: Worker stopped");
    expect(readFileSync(path, "utf8")).toBe(
      "2026-09-26T15:04:05.000Z following save 6f1c2d3e\n2026-09-26T15:04:05.000Z alert: Worker stopped\n",
    );
  });

  it("moves a full log aside instead of growing forever", () => {
    const path = join(tempRoot(), "bridge.log");
    writeFileSync(path, "x".repeat(1_100_000));
    fileLogger(path)("fresh start");
    expect(readFileSync(`${path}.1`, "utf8")).toHaveLength(1_100_000);
    expect(readFileSync(path, "utf8")).toMatch(/fresh start\n$/);
  });

  it("never throws, even when it cannot write", () => {
    const path = join(tempRoot(), "missing-folder", "bridge.log");
    expect(() => fileLogger(path)("lost")).not.toThrow();
    expect(existsSync(path)).toBe(false);
  });
});
