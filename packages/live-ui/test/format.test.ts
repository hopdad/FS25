import { describe, expect, it } from "vitest";
import {
  fillTypeLabel,
  formatAgo,
  formatDuration,
  formatMoney,
  formatPct,
  gameClock,
  jobTypeLabel,
  weatherLabel,
} from "../src/format";

describe("formatting", () => {
  it("shows the game clock", () => {
    expect(gameClock(37, 845)).toBe("Day 37 · 14:05");
    expect(gameClock(1, 0)).toBe("Day 1 · 00:00");
  });

  it("shows money and percentages", () => {
    expect(formatMoney(1250000)).toBe("1,250,000");
    expect(formatMoney(-5000.4)).toBe("−5,000");
    expect(formatPct(62.5)).toBe("63 %");
    expect(formatPct(null)).toBe("—");
  });

  it("shows durations and ages", () => {
    expect(formatDuration(42)).toBe("42 min");
    expect(formatDuration(125)).toBe("2 h 05 min");
    expect(formatAgo(0, 30_000)).toBe("just now");
    expect(formatAgo(0, 5 * 60_000)).toBe("5 min ago");
    expect(formatAgo(0, 3 * 3_600_000)).toBe("3 h ago");
    expect(formatAgo(0, 50 * 3_600_000)).toBe("2 d ago");
  });

  it("names fill types, jobs and weather in words", () => {
    expect(fillTypeLabel("WHEAT")).toBe("Wheat");
    expect(fillTypeLabel("LIQUIDFERTILIZER")).toBe("Liquid fertilizer");
    expect(fillTypeLabel("SOME_MOD_CROP")).toBe("Some mod crop");
    expect(jobTypeLabel("FIELDWORK")).toBe("Field work");
    expect(jobTypeLabel("LOAD_AND_DELIVER")).toBe("Load and deliver");
    expect(weatherLabel("PARTIALLY_CLOUDY")).toBe("Partly cloudy");
  });
});
