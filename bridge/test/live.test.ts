import { utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type LiveVehicle, LiveVehicle as LiveVehicleSchema } from "@farmlink/schema";
import { describe, expect, it } from "vitest";
import { LiveWatcher } from "../src/watch/live";
import { frame, tempRoot, tractor } from "./fixtures";

function setup(nowRef = { t: 0 }) {
  const file = join(tempRoot(), "live_vehicle.json");
  const frames: LiveVehicle[] = [];
  const invalid: string[] = [];
  const events: string[] = [];
  const watcher = new LiveWatcher({
    file,
    schema: LiveVehicleSchema,
    read: { retries: 1, delayMs: 1 },
    offlineAfterMs: 15000,
    now: () => nowRef.t,
    onFrame: (f) => frames.push(f),
    onInvalid: (e) => invalid.push(e),
    onOffline: () => events.push("offline"),
    onOnline: () => events.push("online"),
  });
  let stamp = 1_700_000_000;
  const write = (content: string) => {
    writeFileSync(file, content);
    // Distinct mtimes even when two writes land in the same millisecond.
    stamp += 1;
    utimesSync(file, stamp, stamp);
  };
  return { file, frames, invalid, events, watcher, write, nowRef };
}

describe("LiveWatcher", () => {
  it("delivers each new frame once", async () => {
    const { frames, watcher, write } = setup();
    await watcher.poll();
    expect(frames).toHaveLength(0);

    write(JSON.stringify(frame(tractor, 845)));
    await watcher.poll();
    await watcher.poll();
    expect(frames).toHaveLength(1);

    write(JSON.stringify(frame(tractor, 845))); // rewritten, same content
    await watcher.poll();
    expect(frames).toHaveLength(1);

    write(JSON.stringify(frame(null, 846)));
    await watcher.poll();
    expect(frames.map((f) => f.minute)).toEqual([845, 846]);
    expect(watcher.stats.frames).toBe(2);
  });

  it("counts and drops a frame that fails the schema, then recovers", async () => {
    const { frames, invalid, watcher, write } = setup();
    write(JSON.stringify(frame({ ...tractor, speedKmh: -1 })));
    await watcher.poll();
    await watcher.poll();
    expect(invalid).toEqual(["vehicle.speedKmh: Too small: expected number to be >=0"]);
    expect(watcher.stats.invalid).toBe(1);

    write(JSON.stringify(frame(tractor)));
    await watcher.poll();
    expect(frames).toHaveLength(1);
  });

  it("counts a torn read and picks the file up on the next poll", async () => {
    const { frames, watcher, write } = setup();
    write('{"v":1,"saveId":');
    await watcher.poll();
    expect(watcher.stats.tornReads).toBe(1);
    expect(frames).toHaveLength(0);

    write(JSON.stringify(frame(tractor)));
    await watcher.poll();
    expect(frames).toHaveLength(1);
  });

  it("reports the game offline after 15 s without a frame, and online when frames return", async () => {
    const { events, watcher, write, nowRef } = setup();
    write(JSON.stringify(frame(tractor, 1)));
    await watcher.poll();

    nowRef.t = 14_000;
    await watcher.poll();
    expect(events).toEqual([]);

    nowRef.t = 15_001;
    await watcher.poll();
    await watcher.poll();
    expect(events).toEqual(["offline"]);
    expect(watcher.isOffline).toBe(true);

    write(JSON.stringify(frame(tractor, 2)));
    await watcher.poll();
    expect(events).toEqual(["offline", "online"]);
  });
});
