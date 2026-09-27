// Row-level security: who can read and write a save. The owner shares it with a member (who can
// sync, as when they host the game) and a viewer (read-only); a stranger and anon see nothing.

import { randomUUID } from "node:crypto";
import type { EventEnvelope } from "@farmlink/schema";
import { beforeAll, describe, expect, it } from "vitest";
import { createSave, hasPostgres, insertEvents, type Query, useDatabase } from "./db";

const RLS = /row-level security/;
const DENIED = /permission denied/;

describe.skipIf(!hasPostgres)("row-level security", () => {
  const db = useDatabase();
  let owner = "";
  let member = "";
  let viewer = "";
  let stranger = "";
  let saveId = "";
  const branchId = randomUUID();
  let nextSeq = 1;

  const event = (seq = nextSeq++): EventEnvelope => ({
    v: 1,
    saveId,
    branchId,
    seq,
    day: 1,
    minute: 60,
    year: 1,
    realTs: "2026-09-27T09:00:00Z",
    farmId: 1,
    userId: null,
    type: "money",
    data: { amount: -100, moneyType: "PURCHASE_FUEL", context: { kind: "none" } },
  });

  const count = (caller: string, sql: string) =>
    db.as(caller, async (query) => (await query<{ n: number }>(sql, [saveId]))[0]?.n);

  beforeAll(async () => {
    owner = await db.createUser();
    member = await db.createUser();
    viewer = await db.createUser();
    stranger = await db.createUser();
    saveId = await db.as(owner, async (query) => {
      const id = await createSave(query);
      await query(
        "insert into public.save_members (save_id, user_id, role) values ($1, $2, 'member'), ($1, $3, 'viewer')",
        [id, member, viewer],
      );
      return id;
    });
    await db.as(owner, (query) => insertEvents(query, [event()]));
  });

  describe("reading", () => {
    it("shows the save, its events and its analytics to the owner, a member and a viewer", async () => {
      for (const caller of [owner, member, viewer]) {
        expect(await count(caller, "select count(*) as n from public.saves where id = $1")).toBe(1);
        expect(
          await count(caller, "select count(*) as n from public.events where save_id = $1"),
        ).toBe(1);
        expect(
          await count(caller, "select count(*) as n from public.ledger_events where save_id = $1"),
        ).toBe(1);
        expect(
          await count(caller, "select count(*) as n from public.save_members where save_id = $1"),
        ).toBe(2);
      }
    });

    it("shows a stranger nothing, through the tables or the views", async () => {
      for (const table of [
        "saves where id = $1",
        "save_members where save_id = $1",
        "save_branches where save_id = $1",
        "events where save_id = $1",
        "snapshots where save_id = $1",
        "ledger_events where save_id = $1",
        "save_active_branch where save_id = $1",
        "money_reconciliation where save_id = $1",
      ]) {
        expect(await count(stranger, `select count(*) as n from public.${table}`), table).toBe(0);
      }
    });

    it("lets anon read nothing at all", async () => {
      await expect(
        count("anon", "select count(*) as n from public.events where save_id = $1"),
      ).rejects.toThrow(DENIED);
      await expect(
        count("anon", "select count(*) as n from public.field_season_pnl where save_id = $1"),
      ).rejects.toThrow(DENIED);
      await expect(
        db.as("anon", (query) => query("select * from public.my_saves()")),
      ).rejects.toThrow(DENIED);
    });

    it("lists each caller's saves with their role", async () => {
      const roles = async (caller: string) =>
        db.as(caller, (query) =>
          query<{ role: string }>("select role from public.my_saves() where save_id = $1", [
            saveId,
          ]),
        );
      expect(await roles(owner)).toEqual([{ role: "owner" }]);
      expect(await roles(member)).toEqual([{ role: "member" }]);
      expect(await roles(viewer)).toEqual([{ role: "viewer" }]);
      expect(await roles(stranger)).toEqual([]);
    });
  });

  describe("writing events", () => {
    it("lets the owner and a member sync events", async () => {
      expect(await db.as(member, (query) => insertEvents(query, [event()]))).toBe(1);
      expect(await db.as(owner, (query) => insertEvents(query, [event()]))).toBe(1);
    });

    it("refuses events from a viewer or a stranger, even on a new branch", async () => {
      await expect(db.as(viewer, (query) => insertEvents(query, [event()]))).rejects.toThrow(RLS);
      await expect(db.as(stranger, (query) => insertEvents(query, [event()]))).rejects.toThrow(RLS);
      const forged = { ...event(), branchId: randomUUID() };
      await expect(db.as(stranger, (query) => insertEvents(query, [forged]))).rejects.toThrow(RLS);
      expect(
        await count(owner, "select count(*) as n from public.save_branches where save_id = $1"),
      ).toBe(1);
    });

    it("never lets anyone change or delete an event", async () => {
      await expect(
        db.as(owner, (query) =>
          query("update public.events set data = '{}' where save_id = $1", [saveId]),
        ),
      ).rejects.toThrow(DENIED);
      await expect(
        db.as(owner, (query) => query("delete from public.events where save_id = $1", [saveId])),
      ).rejects.toThrow(DENIED);
    });

    it("lets a member keep snapshots current, and not a viewer", async () => {
      const upsert = (query: Query, day: number) =>
        query(
          `insert into public.snapshots (save_id, branch_id, day, payload) values ($1, $2, $3, '{}')
           on conflict (save_id, branch_id, day) do update set payload = excluded.payload`,
          [saveId, branchId, day],
        );
      await db.as(member, (query) => upsert(query, 1));
      await db.as(member, (query) => upsert(query, 1));
      await expect(db.as(viewer, (query) => upsert(query, 2))).rejects.toThrow(RLS);
    });
  });

  describe("the save itself", () => {
    it("lets a stranger create their own save, but not one in someone else's name", async () => {
      await expect(
        db.as(stranger, (query) =>
          query("insert into public.saves (id, owner_id) values ($1, $2)", [randomUUID(), owner]),
        ),
      ).rejects.toThrow(RLS);
      const own = randomUUID();
      await db.as(stranger, (query) => createSave(query, own));
      const rows = await db.admin("select owner_id from public.saves where id = $1", [own]);
      expect(rows).toEqual([{ owner_id: stranger }]);
    });

    it("lets the owner create a save with an upsert, as the bridge does, and ignore a taken id", async () => {
      const upsert = (id: string) => (query: Query) =>
        query("insert into public.saves (id, name) values ($1, 'x') on conflict (id) do nothing", [
          id,
        ]);
      const own = randomUUID();
      await db.as(stranger, upsert(own));
      await db.as(stranger, upsert(own));
      await db.as(stranger, upsert(saveId));
      const rows = await db.admin("select id, owner_id from public.saves where id = any($1)", [
        [own, saveId],
      ]);
      expect(rows).toEqual(
        expect.arrayContaining([
          { id: own, owner_id: stranger },
          { id: saveId, owner_id: owner },
        ]),
      );
    });

    it("refuses a save whose id is already taken by another player", async () => {
      await expect(db.as(stranger, (query) => createSave(query, saveId))).rejects.toThrow(
        /duplicate key|row-level security/,
      );
    });

    it("lets the owner and a member update the sync fields, and nobody move the owner", async () => {
      const touch = (query: Query) =>
        query("update public.saves set last_synced_at = now() where id = $1 returning id", [
          saveId,
        ]);
      expect(await db.as(owner, touch)).toHaveLength(1);
      expect(await db.as(member, touch)).toHaveLength(1);
      expect(await db.as(viewer, touch)).toHaveLength(0);
      expect(await db.as(stranger, touch)).toHaveLength(0);
      await expect(
        db.as(owner, (query) =>
          query("update public.saves set owner_id = $2 where id = $1", [saveId, stranger]),
        ),
      ).rejects.toThrow(DENIED);
    });

    it("lets only the owner delete the save", async () => {
      const remove = (query: Query) =>
        query("delete from public.saves where id = $1 returning id", [saveId]);
      expect(await db.as(member, remove)).toHaveLength(0);
      expect(await db.as(viewer, remove)).toHaveLength(0);
      expect(await db.as(stranger, remove)).toHaveLength(0);
    });
  });

  describe("sharing", () => {
    it("lets only the owner add members", async () => {
      const someone = await db.createUser();
      const add = (query: Query) =>
        query(
          "insert into public.save_members (save_id, user_id, role) values ($1, $2, 'viewer')",
          [saveId, someone],
        );
      await expect(db.as(member, add)).rejects.toThrow(RLS);
      await expect(db.as(viewer, add)).rejects.toThrow(RLS);
      await expect(db.as(stranger, add)).rejects.toThrow(RLS);
      await db.as(owner, add);
      expect(
        await count(someone, "select count(*) as n from public.events where save_id = $1"),
      ).toBeGreaterThan(0);
    });

    it("stops a member promoting themselves", async () => {
      const promoted = await db.as(viewer, (query) =>
        query(
          "update public.save_members set role = 'member' where save_id = $1 returning user_id",
          [saveId],
        ),
      );
      expect(promoted).toHaveLength(0);
    });

    it("lets a member leave, and then they see nothing", async () => {
      await db.as(viewer, (query) =>
        query("delete from public.save_members where save_id = $1 and user_id = $2", [
          saveId,
          viewer,
        ]),
      );
      expect(
        await count(viewer, "select count(*) as n from public.events where save_id = $1"),
      ).toBe(0);
    });
  });
});
