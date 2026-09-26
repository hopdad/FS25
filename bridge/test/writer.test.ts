import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type AckRing, parseCommandsXml } from "@farmlink/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CommandNumbering, CommandWriter } from "../src/commands/writer";
import { localIsoWithOffset } from "../src/time";
import { TS, tempRoot } from "./fixtures";

const EPOCH = "3b7e1c2a-9d4f-4a6b-8c1e-2f3a4b5c6d7e";
const NOW = new Date("2026-09-26T15:04:05Z");
const stop = { type: "worker.stop" as const, farmId: 1, args: { jobId: "9" } };

function numbering(start = 1): CommandNumbering & { readonly next: number } {
  let next = start;
  return {
    commandEpoch: EPOCH,
    nextCommandId: () => next++,
    skipPast: (id: number) => {
      if (id < next) return false;
      next = id + 1;
      return true;
    },
    get next() {
      return next;
    },
  };
}

function recorder(failFirst = 0) {
  const writes: string[] = [];
  let failures = failFirst;
  return {
    writes,
    write: async (_path: string, text: string) => {
      if (failures > 0) {
        failures--;
        throw new Error("EPERM: operation not permitted");
      }
      writes.push(text);
    },
    ids: (index = writes.length - 1) =>
      parseCommandsXml(writes[index] ?? "").commands.map((c) => c.id),
  };
}

function acks(
  watermark: number,
  ...answers: Array<[number, "ok" | "rejected" | "expired" | "error", string | null]>
): AckRing {
  return {
    v: 1,
    epoch: EPOCH,
    watermark,
    acks: answers.map(([id, status, message]) => ({ v: 1, id, status, message, at: TS })),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("CommandWriter", () => {
  it("writes the command to commands.xml and resolves with the mod's ack", async () => {
    const dir = tempRoot();
    const writer = new CommandWriter({ saveDir: dir, numbering: numbering(), now: () => NOW });
    const answer = writer.send(stop);

    const path = join(dir, "commands.xml");
    await vi.waitFor(() => expect(readFileSync(path, "utf8")).toContain("worker.stop"));
    expect(parseCommandsXml(readFileSync(path, "utf8"))).toEqual({
      v: 1,
      epoch: EPOCH,
      commands: [
        {
          v: 1,
          id: 1,
          type: "worker.stop",
          farmId: 1,
          issuedAt: localIsoWithOffset(NOW),
          ttlSec: 30,
          args: { jobId: "9" },
        },
      ],
    });

    writer.onAcks(acks(1, [1, "ok", null]));
    expect(await answer).toEqual({ id: 1, status: "ok", message: null });
    expect(writer.pendingCount).toBe(0);
  });

  it("passes the mod's refusal through unchanged", async () => {
    const out = recorder();
    const writer = new CommandWriter({
      saveDir: tempRoot(),
      numbering: numbering(),
      write: out.write,
    });
    const answer = writer.send(stop);
    await vi.waitFor(() => expect(out.writes).toHaveLength(1));
    writer.onAcks(acks(1, [1, "rejected", "job 9 belongs to farm 2"]));
    expect(await answer).toEqual({ id: 1, status: "rejected", message: "job 9 belongs to farm 2" });
  });

  it("keeps the most recent commands in the file, and writes a burst once", async () => {
    const out = recorder();
    const writer = new CommandWriter({
      saveDir: tempRoot(),
      numbering: numbering(),
      write: out.write,
    });
    const answers = Array.from({ length: 22 }, () => writer.send({ type: "ping", farmId: 1 }));

    await vi.waitFor(() => expect(out.writes).toHaveLength(1));
    expect(out.ids()).toEqual(Array.from({ length: 20 }, (_, i) => i + 3));
    // The first two left the ring before any write carried them.
    expect(await answers[0]).toMatchObject({ id: 1, status: "error" });
    expect(await answers[1]).toMatchObject({ id: 2, status: "error" });

    writer.onAcks(
      acks(
        22,
        ...Array.from({ length: 20 }, (_, i) => [i + 3, "ok", null] as [number, "ok", null]),
      ),
    );
    expect(await answers[21]).toEqual({ id: 22, status: "ok", message: null });
  });

  it("answers expired when the game never acks", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const out = recorder();
    const writer = new CommandWriter({
      saveDir: tempRoot(),
      numbering: numbering(),
      write: out.write,
      ttlSec: 30,
      graceMs: 2000,
    });
    const answer = writer.send(stop);
    await vi.advanceTimersByTimeAsync(31_999);
    expect(writer.pendingCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await answer).toEqual({
      id: 1,
      status: "expired",
      message: "no answer from the game within 30 s",
    });
  });

  it("reports a failed write and never delivers that command later", async () => {
    const out = recorder(1);
    const writer = new CommandWriter({
      saveDir: tempRoot(),
      numbering: numbering(),
      write: out.write,
    });
    const failed = await writer.send(stop);
    expect(failed).toMatchObject({ id: 1, status: "error" });
    expect(failed.message).toMatch(/could not write commands.xml: EPERM/);

    void writer.send({ type: "ping", farmId: 1 });
    await vi.waitFor(() => expect(out.writes).toHaveLength(1));
    expect(out.ids()).toEqual([2]);
  });

  it("ignores acks that answer another bridge installation", async () => {
    const out = recorder();
    const writer = new CommandWriter({
      saveDir: tempRoot(),
      numbering: numbering(),
      write: out.write,
    });
    void writer.send(stop);
    await vi.waitFor(() => expect(out.writes).toHaveLength(1));
    writer.onAcks({ ...acks(1, [1, "ok", null]), epoch: "11111111-2222-4333-8444-555555555555" });
    expect(writer.pendingCount).toBe(1);
    writer.close();
  });

  it("catches the numbering up with the mod's watermark", () => {
    const ids = numbering(5);
    const writer = new CommandWriter({
      saveDir: tempRoot(),
      numbering: ids,
      write: async () => {},
    });
    writer.onAcks(acks(57));
    expect(ids.next).toBe(58);
  });

  it("answers a command whose ack the ring already dropped", async () => {
    const out = recorder();
    const writer = new CommandWriter({
      saveDir: tempRoot(),
      numbering: numbering(),
      write: out.write,
    });
    const answer = writer.send(stop);
    await vi.waitFor(() => expect(out.writes).toHaveLength(1));
    writer.onAcks(acks(3, [2, "ok", null], [3, "ok", null]));
    expect(await answer).toMatchObject({ id: 1, status: "error" });
  });

  it("answers everything pending on close and refuses what comes after", async () => {
    const out = recorder();
    const writer = new CommandWriter({
      saveDir: tempRoot(),
      numbering: numbering(),
      write: out.write,
    });
    const answer = writer.send(stop);
    writer.close("the game loaded another save");
    expect(await answer).toEqual({
      id: 1,
      status: "error",
      message: "the game loaded another save",
    });
    expect(await writer.send(stop)).toEqual({
      id: null,
      status: "rejected",
      message: "the save was closed",
    });
  });
});
