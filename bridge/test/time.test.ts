import { afterEach, describe, expect, it } from "vitest";
import { localIsoWithOffset, parseGameTimestamp } from "../src/time";

const originalTz = process.env.TZ;

afterEach(() => {
  process.env.TZ = originalTz;
});

describe("localIsoWithOffset", () => {
  it("writes local wall-clock time with the zone's offset", () => {
    process.env.TZ = "America/New_York";
    expect(localIsoWithOffset(new Date("2026-09-26T15:04:05.678Z"))).toBe(
      "2026-09-26T11:04:05-04:00",
    );
    process.env.TZ = "Asia/Kolkata";
    expect(localIsoWithOffset(new Date("2026-09-26T15:04:05Z"))).toBe("2026-09-26T20:34:05+05:30");
    process.env.TZ = "UTC";
    expect(localIsoWithOffset(new Date("2026-01-02T03:04:05Z"))).toBe("2026-01-02T03:04:05+00:00");
  });

  it("reads back as the same instant, to the second", () => {
    const now = new Date("2026-09-26T15:04:05.999Z");
    expect(parseGameTimestamp(localIsoWithOffset(now))).toBe(Date.parse("2026-09-26T15:04:05Z"));
  });
});

describe("parseGameTimestamp", () => {
  it("reads the forms the mod writes and rejects anything else", () => {
    expect(parseGameTimestamp("2026-09-26T11:04:05-04:00")).toBe(
      Date.parse("2026-09-26T15:04:05Z"),
    );
    process.env.TZ = "America/New_York";
    // No offset: the game could not tell it, and local time on this machine is meant.
    expect(parseGameTimestamp("2026-09-26T11:04:05")).toBe(Date.parse("2026-09-26T15:04:05Z"));
    expect(parseGameTimestamp("yesterday")).toBeUndefined();
  });
});
