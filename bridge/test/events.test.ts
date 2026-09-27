import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EventEnvelope } from "@farmlink/schema";
import { describe, expect, it } from "vitest";
import { eventChecks } from "../src/doctorEvents";
import { EventLogReader, sortEventFiles } from "../src/events/reader";
import { SequenceCheck } from "../src/events/sequence";
import { EventLogWatcher } from "../src/events/watcher";
import { BRANCH_ID, meta, SAVE_ID, tempRoot } from "./fixtures";

const FORK_ID = "3e5f7a9b-1c2d-4e6f-b8a0-7b9c0d1e2f3a";

function event(seq: number, overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    v: 1,
    saveId: SAVE_ID,
    branchId: BRANCH_ID,
    seq,
    day: 37,
    minute: 845,
    year: 2,
    realTs: "2026-09-26T11:04:05-04:00",
    farmId: 1,
    userId: null,
    type: "money",
    data: {
      amount: -26.4,
      moneyType: "AI",
      context: { kind: "wage", jobId: "9", vehicleId: "v14" },
    },
    ...overrides,
  } as EventEnvelope;
}

function session(seq: number, fork?: { parentBranchId: string; forkSeq: number }): EventEnvelope {
  return event(seq, {
    type: "session",
    farmId: 0,
    branchId: fork ? FORK_ID : BRANCH_ID,
    data: {
      modVersion: "0.3.0.0",
      gameVersion: "1.12.0.0",
      integrations: [],
      period: 4,
      dayInPeriod: 1,
      daysPerPeriod: 3,
      ...fork,
    },
  } as Partial<EventEnvelope>);
}

const line = (e: EventEnvelope) => `${JSON.stringify(e)}\n`;

function saveFolder(): { saveDir: string; eventsDir: string } {
  const saveDir = tempRoot();
  const eventsDir = join(saveDir, "events");
  mkdirSync(eventsDir);
  return { saveDir, eventsDir };
}

describe("EventLogReader", () => {
  it("returns each complete line once, and keeps a line caught mid-write for the next read", async () => {
    const { saveDir, eventsDir } = saveFolder();
    const file = join(eventsDir, "37.ndjson");
    const second = JSON.stringify(event(2));
    writeFileSync(file, line(session(1)) + second.slice(0, 40));
    const reader = new EventLogReader(saveDir);

    const first = await reader.read();
    expect(first.map((l) => (l.ok ? l.event.seq : l.error))).toEqual([1]);

    appendFileSync(file, `${second.slice(40)}\n`);
    const next = await reader.read();
    expect(next).toMatchObject([{ ok: true, file: "37.ndjson", line: 2, event: { seq: 2 } }]);
    expect(await reader.read()).toEqual([]);
  });

  it("reads files in the order they were written: by day, then segment", async () => {
    expect(
      sortEventFiles([
        "38.ndjson",
        "37-0d3c9a4e-2.ndjson",
        "notes.txt",
        "37-0d3c9a4e-1.ndjson",
        "5.ndjson",
      ]),
    ).toEqual(["5.ndjson", "37-0d3c9a4e-1.ndjson", "37-0d3c9a4e-2.ndjson", "38.ndjson"]);

    const { saveDir, eventsDir } = saveFolder();
    writeFileSync(join(eventsDir, "38.ndjson"), line(event(3, { day: 38 })));
    writeFileSync(join(eventsDir, "37.ndjson"), line(session(1)) + line(event(2)));
    const lines = await new EventLogReader(saveDir).read();
    expect(lines.map((l) => (l.ok ? l.event.seq : 0))).toEqual([1, 2, 3]);
  });

  it("reports a line that is not JSON or breaks the contract, with its file and line", async () => {
    const { saveDir, eventsDir } = saveFolder();
    const bad = { ...event(3), minute: 2000 };
    writeFileSync(
      join(eventsDir, "37.ndjson"),
      `${line(session(1))}{"seq": 2,\r\n${JSON.stringify(bad)}\r\n`,
    );
    const lines = await new EventLogReader(saveDir).read();
    expect(lines[0]).toMatchObject({ ok: true });
    expect(lines[1]).toMatchObject({ ok: false, file: "37.ndjson", line: 2 });
    expect(lines[1]?.ok === false && lines[1].error).toMatch(/^not JSON/);
    expect(lines[2]).toMatchObject({
      ok: false,
      line: 3,
      error: expect.stringMatching(/^minute:/),
    });
  });

  it("returns nothing while there is no events folder", async () => {
    expect(await new EventLogReader(tempRoot()).read()).toEqual([]);
  });
});

describe("SequenceCheck", () => {
  it("expects a root branch to start at 1 and run on without holes", () => {
    const check = new SequenceCheck();
    expect(check.add(session(1))).toBeUndefined();
    expect(check.add(event(2))).toBeUndefined();
    expect(check.add(event(5))).toEqual({ branchId: BRANCH_ID, after: 2, next: 5, missing: 2 });
    expect(check.add(event(5))).toBe("duplicate");
    expect(check.summary).toEqual([
      { branchId: BRANCH_ID, first: 1, last: 5, events: 3, parentBranchId: null, forkSeq: null },
    ]);
    expect(check.duplicates).toBe(1);
  });

  it("expects a forked branch to start right after its fork seq", () => {
    const check = new SequenceCheck();
    for (const seq of [1, 2, 3, 4]) check.add(seq === 1 ? session(1) : event(seq));
    expect(check.add(session(3, { parentBranchId: BRANCH_ID, forkSeq: 2 }))).toBeUndefined();
    expect(check.add(event(4, { branchId: FORK_ID }))).toBeUndefined();
    expect(check.gaps).toEqual([]);

    const late = new SequenceCheck();
    expect(late.add(session(6, { parentBranchId: BRANCH_ID, forkSeq: 2 }))).toEqual({
      branchId: FORK_ID,
      after: 2,
      next: 6,
      missing: 3,
    });
  });

  it("takes a branch first seen part way through as it comes", () => {
    const check = new SequenceCheck();
    expect(check.add(event(40))).toBeUndefined();
    expect(check.add(event(41))).toBeUndefined();
    expect(check.gaps).toEqual([]);
  });
});

describe("EventLogWatcher", () => {
  it("passes on new valid events once, and logs gaps and invalid lines", async () => {
    const { saveDir, eventsDir } = saveFolder();
    const file = join(eventsDir, "37.ndjson");
    writeFileSync(file, line(session(1)) + line(event(2)));
    const logged: string[] = [];
    const received: number[] = [];
    const watcher = new EventLogWatcher({
      saveDir,
      log: (message) => logged.push(message),
      onEvents: (events) => received.push(...events.map((e) => e.seq)),
    });
    await watcher.poll();
    appendFileSync(file, `${line(event(5))}not json\n${line(event(5))}`);
    await watcher.poll();

    expect(received).toEqual([1, 2, 5]);
    expect(watcher.stats).toEqual({ events: 3, invalid: 1 });
    expect(logged).toEqual([
      `event log gap on branch ${BRANCH_ID}: seq 3 to 4 never written`,
      expect.stringMatching(/^skipped an invalid event line, 37\.ndjson line 4: not JSON/),
    ]);
  });
});

describe("the event log check in --doctor", () => {
  it("passes a clean log and names the current branch's seq", async () => {
    const { saveDir, eventsDir } = saveFolder();
    writeFileSync(join(eventsDir, "37.ndjson"), line(session(1)) + line(event(2)));
    const [check] = await eventChecks(saveDir, meta({ lastSeq: 2 }) as never);
    expect(check).toMatchObject({ id: "events", status: "pass", phase: "P2" });
    expect(check?.detail).toBe(
      `2 lines in 1 file on 1 branch; current branch ${BRANCH_ID.slice(0, 8)} at seq 2 (meta.json: 2); no gaps`,
    );
  });

  it("fails on a gap or an invalid line", async () => {
    const { saveDir, eventsDir } = saveFolder();
    writeFileSync(join(eventsDir, "37.ndjson"), `${line(session(1))}${line(event(4))}oops\n`);
    const [check] = await eventChecks(saveDir, undefined);
    expect(check?.status).toBe("fail");
    expect(check?.detail).toContain("1 invalid: 37.ndjson:3 not JSON");
    expect(check?.detail).toContain(`1 gaps (${BRANCH_ID.slice(0, 8)} 2-3)`);
  });

  it("waits for a mod build that writes the log", async () => {
    const [check] = await eventChecks(tempRoot(), undefined);
    expect(check?.status).toBe("pending");
  });
});
