import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope, EventRow, LiveFarm } from "@farmlink/schema";
import { describe, expect, it } from "vitest";
import { SyncCursorStore } from "../src/sync/cursor";
import { SyncEngine } from "../src/sync/engine";
import { classify, RestClient, SyncError } from "../src/sync/rest";
import type { SaveInfo, SaveRole, SnapshotRow, SyncTransport } from "../src/sync/transport";

const SAVE = "5b8f3c2a-1d4e-4f6a-9b7c-2e1d0f9a8b7c";
const BRANCH = "0c7e5a9d-3b2f-4e1a-8d6c-9f0e1a2b3c4d";
const FORK = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const INFO: SaveInfo = {
  saveId: SAVE,
  name: "Riverbend Springs",
  map: null,
  modVersion: "0.2.0.0",
};

function money(seq: number, branchId = BRANCH): EventEnvelope {
  return {
    v: 1,
    saveId: SAVE,
    branchId,
    seq,
    realTs: "2026-09-27T10:00:00Z",
    day: 12,
    minute: 600,
    year: 1,
    farmId: 1,
    userId: null,
    type: "money",
    data: { amount: -10, moneyType: "OTHER", context: { kind: "none" } },
  } as EventEnvelope;
}

const range = (from: number, to: number, branchId = BRANCH) =>
  Array.from({ length: to - from + 1 }, (_, i) => money(from + i, branchId));

class FakeTransport implements SyncTransport {
  readonly rows = new Map<string, EventRow>();
  readonly calls: string[] = [];
  readonly failures: SyncError[] = [];
  readonly refuse = new Set<number>();
  readonly snapshots: SnapshotRow[] = [];
  readonly marks: Date[] = [];
  role: SaveRole | SyncError = "owner";

  async ensureSave(_save: SaveInfo): Promise<SaveRole> {
    this.calls.push("ensure");
    if (this.role instanceof SyncError) throw this.role;
    return this.role;
  }

  async insertEvents(rows: readonly EventRow[]): Promise<void> {
    this.calls.push(`insert ${rows.length}`);
    const failure = this.failures.shift();
    if (failure) throw failure;
    const refused = rows.find((row) => this.refuse.has(row.seq));
    if (refused) {
      throw new SyncError(`HTTP 400 23514: bad line ${refused.seq}`, "rejected", 400, "23514");
    }
    for (const row of rows) this.rows.set(`${row.branch_id}:${row.seq}`, row);
  }

  async upsertSnapshot(row: SnapshotRow): Promise<void> {
    this.calls.push(`snapshot ${row.day}`);
    this.snapshots.push(row);
  }

  async markSynced(_save: SaveInfo, at: Date): Promise<void> {
    this.marks.push(at);
  }

  seqs(branchId = BRANCH): number[] {
    return [...this.rows.values()]
      .filter((row) => row.branch_id === branchId)
      .map((row) => row.seq)
      .sort((a, b) => a - b);
  }
}

function setup(dir = mkdtempSync(join(tmpdir(), "farmlink-sync-"))) {
  const clock = { now: 1_000_000 };
  const transport = new FakeTransport();
  const cursor = new SyncCursorStore(dir);
  const lines: string[] = [];
  const engine = new SyncEngine({
    saveId: SAVE,
    transport,
    cursor,
    now: () => clock.now,
    log: (line) => lines.push(line),
  });
  return { dir, clock, transport, cursor, engine, lines };
}

describe("the Supabase sync", () => {
  it("writes nothing before the save's meta.json has been read", async () => {
    const { clock, transport, engine } = setup();
    engine.push(range(1, 3));
    clock.now += 6000;
    await engine.tick();
    expect(transport.calls).toEqual([]);
    expect(engine.status().state).toBe("waiting");

    engine.setSave(INFO);
    await engine.tick();
    expect(transport.calls).toEqual(["ensure", "insert 3"]);
    expect(engine.status()).toMatchObject({ state: "synced", role: "owner", queued: 0 });
  });

  it("writes batches of 200 at once, and a smaller one after 5 s", async () => {
    const { clock, transport, engine, cursor } = setup();
    engine.setSave(INFO);
    engine.push(range(1, 450));
    await engine.tick();
    expect(transport.calls).toEqual(["ensure", "insert 200", "insert 200"]);
    expect(cursor.synced(SAVE, BRANCH)).toBe(400);

    clock.now += 4000;
    await engine.tick();
    expect(transport.calls).toHaveLength(3);
    clock.now += 1000;
    await engine.tick();
    expect(transport.calls.at(-1)).toBe("insert 50");
    expect(transport.seqs()).toEqual(range(1, 450).map((e) => e.seq));
  });

  it("moves the cursor only after a confirmed write, and resumes from it", async () => {
    const { dir, clock, transport, engine, cursor } = setup();
    engine.setSave(INFO);
    transport.failures.push(new SyncError("fetch failed", "network"));
    engine.push(range(1, 10));
    await engine.tick({ flush: true });
    expect(cursor.synced(SAVE, BRANCH)).toBe(0);
    expect(engine.status()).toMatchObject({ state: "retrying", queued: 10, retryInMs: 1000 });

    clock.now += 1000;
    await engine.tick({ flush: true });
    expect(cursor.synced(SAVE, BRANCH)).toBe(10);

    // The next run reads the event files from the start: only what is new goes out.
    const next = setup(dir);
    next.engine.setSave(INFO);
    next.engine.push([...range(1, 15), ...range(1, 4, FORK)]);
    await next.engine.tick({ flush: true });
    expect(next.transport.seqs()).toEqual([11, 12, 13, 14, 15]);
    expect(next.transport.seqs(FORK)).toEqual([1, 2, 3, 4]);
    expect(next.cursor.save(SAVE).branches).toEqual({ [BRANCH]: 15, [FORK]: 4 });
  });

  it("backs off from 1 s to 5 min, and logs a failure once", async () => {
    const { clock, transport, engine, lines } = setup();
    engine.setSave(INFO);
    engine.push(range(1, 5));
    const waits: (number | null)[] = [];
    for (let i = 0; i < 11; i += 1) {
      transport.failures.push(new SyncError("HTTP 503: unavailable", "server", 503));
      await engine.tick({ flush: true });
      waits.push(engine.status().retryInMs);
      clock.now += engine.status().retryInMs ?? 0;
    }
    expect(waits.map((ms) => (ms ?? 0) / 1000)).toEqual([
      1, 2, 4, 8, 16, 32, 64, 128, 256, 300, 300,
    ]);
    expect(lines.filter((line) => line.includes("unavailable"))).toHaveLength(1);

    // Waiting out the backoff is enough; an early tick does nothing.
    await engine.tick({ flush: true });
    expect(transport.seqs()).toEqual([1, 2, 3, 4, 5]);
    expect(engine.status()).toMatchObject({ state: "synced", lastError: null, retryInMs: null });
    expect(lines.at(-1)).toBe("sync: writing to Supabase again");
  });

  it("finds the lines Supabase refuses, records them and writes the rest", async () => {
    const { transport, engine, cursor, lines } = setup();
    engine.setSave(INFO);
    transport.refuse.add(5);
    engine.push(range(1, 8));
    await engine.tick({ flush: true });
    expect(transport.seqs()).toEqual([1, 2, 3, 4, 6, 7, 8]);
    expect(cursor.synced(SAVE, BRANCH)).toBe(8);
    expect(cursor.save(SAVE).rejected).toEqual([
      { branchId: BRANCH, seq: 5, error: "HTTP 400 23514: bad line 5" },
    ]);
    expect(engine.status().rejected).toBe(1);
    expect(lines).toContain(
      "sync: Supabase refused 1 event line(s), seq 5: HTTP 400 23514: bad line 5",
    );
  });

  it("stops at a save it may not write, and asks again after 5 min", async () => {
    const { clock, transport, engine } = setup();
    transport.role = new SyncError(`save ${SAVE} belongs to another account`, "forbidden");
    engine.setSave(INFO);
    engine.push(range(1, 2));
    await engine.tick({ flush: true });
    expect(engine.status()).toMatchObject({
      state: "blocked",
      lastError: `save ${SAVE} belongs to another account`,
      retryInMs: 300_000,
    });

    transport.role = "member";
    clock.now += 300_000;
    await engine.tick({ flush: true });
    expect(transport.seqs()).toEqual([1, 2]);
    expect(engine.status()).toMatchObject({ state: "synced", role: "member" });
  });

  it("writes the first live_farm.json frame of each game day as that day's snapshot", async () => {
    const { dir, transport, engine } = setup();
    engine.setSave(INFO);
    const frame = (day: number) =>
      ({
        saveId: SAVE,
        day,
        farm: { farms: [], weather: { current: null, forecast: [] } },
      }) as unknown as LiveFarm;
    engine.offerSnapshot(frame(40), BRANCH);
    await engine.tick();
    engine.offerSnapshot(frame(40), BRANCH);
    await engine.tick();
    engine.offerSnapshot(frame(41), BRANCH);
    await engine.tick();
    expect(transport.calls.filter((c) => c.startsWith("snapshot"))).toEqual([
      "snapshot 40",
      "snapshot 41",
    ]);
    expect(transport.snapshots[0]).toMatchObject({ save_id: SAVE, branch_id: BRANCH, day: 40 });

    const next = setup(dir);
    next.engine.setSave(INFO);
    next.engine.offerSnapshot(frame(41), BRANCH);
    await next.engine.tick();
    expect(next.transport.snapshots).toEqual([]);
  });

  it("sends what is queued when it stops, and marks the save synced at most once a minute", async () => {
    const { clock, transport, engine } = setup();
    engine.setSave(INFO);
    engine.push(range(1, 3));
    await engine.tick();
    expect(transport.marks).toHaveLength(1);
    clock.now += 6000;
    engine.push(range(4, 5));
    await engine.tick();
    expect(transport.marks).toHaveLength(1);
    engine.push(range(6, 6));
    await engine.stop();
    expect(transport.seqs()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(transport.marks).toHaveLength(2);
  });
});

describe("the PostgREST client", () => {
  function fakeFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
    const requests: { url: string; init: RequestInit }[] = [];
    const fn = (async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return respond(url, init);
    }) as unknown as typeof fetch;
    return { fn, requests };
  }

  it("inserts with the conflict target, the resolution and the caller's token", async () => {
    const { fn, requests } = fakeFetch(() => new Response(null, { status: 201 }));
    const rest = new RestClient({
      url: "https://example.supabase.co/rest/v1/",
      apiKey: "anon-key",
      accessToken: async () => "user-jwt",
      fetch: fn,
    });
    await rest.insert("events", [{ seq: 1 }], {
      onConflict: "save_id,branch_id,seq",
      resolution: "ignore-duplicates",
    });
    expect(requests[0]?.url).toBe(
      "https://example.supabase.co/rest/v1/events?on_conflict=save_id%2Cbranch_id%2Cseq",
    );
    expect(requests[0]?.init.method).toBe("POST");
    expect(requests[0]?.init.headers).toMatchObject({
      apikey: "anon-key",
      Authorization: "Bearer user-jwt",
      Prefer: "resolution=ignore-duplicates,return=minimal",
      "Content-Type": "application/json",
    });
    expect(requests[0]?.init.body).toBe('[{"seq":1}]');
  });

  it("tells the token's owner about a 401, and says what each failure means", async () => {
    let refused = 0;
    const { fn } = fakeFetch(
      () =>
        new Response(JSON.stringify({ code: "PGRST303", message: "JWT expired" }), { status: 401 }),
    );
    const rest = new RestClient({
      url: "http://localhost:3000",
      accessToken: async () => "old",
      onUnauthorized: () => {
        refused += 1;
      },
      fetch: fn,
    });
    await expect(rest.rpc("my_saves")).rejects.toMatchObject({ kind: "auth", status: 401 });
    expect(refused).toBe(1);

    expect(
      classify(403, { code: "42501", message: "new row violates row-level security policy" }),
    ).toMatchObject({ kind: "forbidden", retryable: false });
    expect(classify(404, { code: "PGRST205", message: "no table" }).kind).toBe("config");
    expect(classify(400, { code: "PGRST204", message: "no column year" }).kind).toBe("config");
    expect(classify(400, { code: "23514", message: "violates check constraint" }).kind).toBe(
      "rejected",
    );
    expect(classify(503, undefined)).toMatchObject({ kind: "server", retryable: true });
    expect(classify(429, undefined).kind).toBe("server");
  });

  it("reports a request that gets no answer as a network failure", async () => {
    const { fn } = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    const rest = new RestClient({
      url: "http://localhost:1",
      accessToken: async () => "t",
      fetch: fn,
    });
    await expect(rest.select("saves", { select: "id" })).rejects.toMatchObject({
      kind: "network",
      message: "GET saves: fetch failed",
    });

    const slow = fakeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const impatient = new RestClient({
      url: "http://localhost:1",
      accessToken: async () => "t",
      fetch: slow.fn,
      timeoutMs: 20,
    });
    await expect(impatient.rpc("my_saves")).rejects.toMatchObject({
      kind: "network",
      message: "POST rpc/my_saves: timed out",
    });
  });
});
