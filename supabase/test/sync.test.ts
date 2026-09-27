// The bridge's Supabase sync against the real thing: its engine and REST client, through PostgREST,
// into the migrated schema, as signed-in users. Row-level security, the conflict targets and the
// branch triggers all run as they do on Supabase.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RestClient,
  type SaveInfo,
  SupabaseTransport,
  SyncCursorStore,
  SyncEngine,
} from "@farmlink/bridge/sync";
import type { EventEnvelope, LiveFarm } from "@farmlink/schema";
import { loadLedgerFixture } from "@farmlink/schema/fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasPostgres, useDatabase } from "./db";
import { findPostgrest, type Postgrest, startPostgrest } from "./postgrest";

const bin = hasPostgres ? findPostgrest() : undefined;

describe.skipIf(!bin)("the bridge's sync through PostgREST", () => {
  const db = useDatabase();
  let api: Postgrest;
  let owner = "";
  let other = "";

  beforeAll(async () => {
    api = await startPostgrest(bin as string, db.url);
    owner = await db.createUser();
    other = await db.createUser();
  });

  afterAll(() => api?.stop());

  function engine(userId: string, saveId: string, logs: string[] = []) {
    const transport = new SupabaseTransport(
      new RestClient({ url: api.url, accessToken: async () => api.token(userId) }),
    );
    const cursor = new SyncCursorStore(mkdtempSync(join(tmpdir(), "farmlink-sync-")));
    const sync = new SyncEngine({
      saveId,
      transport,
      cursor,
      batchSize: 7,
      log: (line) => logs.push(line),
    });
    const info: SaveInfo = { saveId, name: "Riverbend", map: null, modVersion: "0.2.0.0" };
    sync.setSave(info);
    return { sync, cursor };
  }

  const count = async (saveId: string) =>
    Number(
      (
        await db.admin<{ n: number }>(
          "select count(*)::int as n from public.events where save_id = $1",
          [saveId],
        )
      )[0]?.n,
    );

  it("creates the save, writes every line once, and keeps a snapshot per day", async () => {
    const fixture = loadLedgerFixture("field_season.json");
    const { sync, cursor } = engine(owner, fixture.saveId);
    sync.push(fixture.events);
    const [snapshot] = fixture.snapshots;
    const frame = (payload: unknown) =>
      ({ saveId: fixture.saveId, day: snapshot?.day, farm: payload }) as unknown as LiveFarm;
    sync.offerSnapshot(frame(snapshot?.payload), fixture.branchId);
    await sync.tick({ flush: true });

    expect(sync.status()).toMatchObject({ state: "synced", role: "owner", lastError: null });
    expect(await count(fixture.saveId)).toBe(fixture.events.length);
    expect(cursor.synced(fixture.saveId, fixture.branchId)).toBe(fixture.events.length);
    const [save] = await db.admin(
      "select owner_id, name, mod_version, last_synced_at from public.saves where id = $1",
      [fixture.saveId],
    );
    expect(save).toMatchObject({ owner_id: owner, name: "Riverbend", mod_version: "0.2.0.0" });
    expect(save?.last_synced_at).not.toBeNull();

    // The same lines again, as after a lost sync-state.json: nothing changes.
    const again = engine(owner, fixture.saveId);
    again.sync.push(fixture.events);
    await again.sync.tick({ flush: true });
    expect(again.sync.status().lastError).toBeNull();
    expect(await count(fixture.saveId)).toBe(fixture.events.length);

    // The views see what the fixture expects: the fields from the snapshot, and field P&L.
    const fields = await db.as(owner, (query) =>
      query("select field_id from public.fields where save_id = $1 order by field_id", [
        fixture.saveId,
      ]),
    );
    expect(fields.map((row) => row.field_id)).toEqual([3, 4, 5, 7]);
    const pnl = await db.as(owner, (query) =>
      query("select field_id, season from public.field_season_pnl where save_id = $1", [
        fixture.saveId,
      ]),
    );
    expect(pnl).toHaveLength(fixture.expect.field_season_pnl?.length ?? -1);

    // A later snapshot of the same day replaces the day's payload.
    const replacement = engine(owner, fixture.saveId);
    replacement.sync.offerSnapshot(
      frame({ farms: [], weather: { current: null, forecast: [] } }),
      fixture.branchId,
    );
    await replacement.sync.tick();
    const snapshots = await db.admin("select payload from public.snapshots where save_id = $1", [
      fixture.saveId,
    ]);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.payload).toEqual({ farms: [], weather: { current: null, forecast: [] } });
  });

  it("refuses another account's save, and lets a member sync it but not a viewer", async () => {
    const fixture = loadLedgerFixture("fleet.json");
    const first = fixture.events.slice(0, 10);
    const rest = fixture.events.slice(10);
    const mine = engine(owner, fixture.saveId);
    mine.sync.push(first);
    await mine.sync.tick({ flush: true });
    expect(await count(fixture.saveId)).toBe(10);

    const logs: string[] = [];
    const theirs = engine(other, fixture.saveId, logs);
    theirs.sync.push(rest);
    await theirs.sync.tick({ flush: true });
    expect(theirs.sync.status()).toMatchObject({
      state: "blocked",
      lastError: `save ${fixture.saveId} belongs to another account`,
    });
    expect(await count(fixture.saveId)).toBe(10);
    expect(logs[0]).toContain("belongs to another account; next attempt in 300 s");

    await db.as(owner, (query) =>
      query("insert into public.save_members (save_id, user_id, role) values ($1, $2, 'viewer')", [
        fixture.saveId,
        other,
      ]),
    );
    const viewer = engine(other, fixture.saveId);
    viewer.sync.push(rest);
    await viewer.sync.tick({ flush: true });
    expect(viewer.sync.status().lastError).toBe(
      `you can only view save ${fixture.saveId}; its owner can make you a member`,
    );

    await db.as(owner, (query) =>
      query("update public.save_members set role = 'member' where save_id = $1 and user_id = $2", [
        fixture.saveId,
        other,
      ]),
    );
    const member = engine(other, fixture.saveId);
    member.sync.push(fixture.events);
    await member.sync.tick({ flush: true });
    expect(member.sync.status()).toMatchObject({ state: "synced", role: "member" });
    expect(await count(fixture.saveId)).toBe(fixture.events.length);
  });

  it("records a line the database refuses, and writes the others", async () => {
    const fixture = loadLedgerFixture("worker_downtime.json");
    // Past the schema's checks (the watcher would have dropped it); the table refuses it too.
    const broken = fixture.events.map((event, index) =>
      index === 4 ? ({ ...event, minute: 1500 } as EventEnvelope) : event,
    );
    const logs: string[] = [];
    const { sync, cursor } = engine(owner, fixture.saveId, logs);
    sync.push(broken);
    await sync.tick({ flush: true });
    expect(sync.status()).toMatchObject({ state: "synced", rejected: 1 });
    expect(await count(fixture.saveId)).toBe(fixture.events.length - 1);
    expect(cursor.save(fixture.saveId).rejected).toEqual([
      expect.objectContaining({ seq: broken[4]?.seq, error: expect.stringContaining("23514") }),
    ]);
    expect(logs.some((line) => line.startsWith("sync: Supabase refused 1 event line(s)"))).toBe(
      true,
    );
  });
});
