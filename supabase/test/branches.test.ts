// The branch rule (PLAN_REVIEW.md F2): reloading an older savegame starts a new branch, the views
// count the active branch plus its ancestors up to each fork, and replaying a batch changes nothing.

import { randomUUID } from "node:crypto";
import type { EventEnvelope } from "@farmlink/schema";
import { beforeAll, describe, expect, it } from "vitest";
import { createSave, hasPostgres, insertEvents, useDatabase } from "./db";

const CALENDAR = { period: 4, dayInPeriod: 1, daysPerPeriod: 1 };

function events(saveId: string) {
  return (branchId: string, seq: number, realTs = "2026-09-20T10:00:00Z") =>
    <T extends EventEnvelope["type"]>(
      type: T,
      data: Extract<EventEnvelope, { type: T }>["data"],
    ): EventEnvelope =>
      ({
        v: 1,
        saveId,
        branchId,
        seq,
        day: 3,
        minute: seq,
        year: 1,
        realTs,
        farmId: 1,
        userId: null,
        type,
        data,
      }) as EventEnvelope;
}

const session = (fork?: { parentBranchId: string; forkSeq: number }) => ({
  modVersion: "0.3.0.0",
  gameVersion: "1.10.1.0",
  integrations: [],
  ...CALENDAR,
  ...fork,
});

const harvest = (liters: number) => ({
  fieldId: 1,
  farmlandId: 1,
  fillType: "WHEAT",
  liters,
  vehicleId: "combine1",
  isAI: false,
});

const sale = (liters: number, amount: number) => ({
  amount,
  moneyType: "SOLD_PRODUCTS",
  context: { kind: "sale" as const, stationId: "elevator", fillType: "WHEAT", liters },
});

describe.skipIf(!hasPostgres)("branches", () => {
  const db = useDatabase();
  let owner = "";
  let saveId = "";
  const A = randomUUID();
  const B = randomUUID();
  const C = randomUUID();

  const counted = () =>
    db.as(owner, (query) =>
      query<{ branch_id: string; seq: number }>(
        "select branch_id, seq from public.ledger_events where save_id = $1 order by seq, branch_id",
        [saveId],
      ),
    );
  const active = async () =>
    (
      await db.as(owner, (query) =>
        query<{ branch_id: string }>(
          "select branch_id from public.save_active_branch where save_id = $1",
          [saveId],
        ),
      )
    )[0]?.branch_id;
  const wheat = async () =>
    (
      await db.as(owner, (query) =>
        query<{ revenue: number; yields: { liters: number; pricePerLiter: number }[] }>(
          "select revenue, yields from public.field_season_pnl where save_id = $1 and field_id = 1",
          [saveId],
        ),
      )
    )[0];

  beforeAll(async () => {
    owner = await db.createUser();
    saveId = await db.as(owner, (query) => createSave(query));
  });

  it("counts every event of the first branch", async () => {
    const at = events(saveId);
    await db.as(owner, (query) =>
      insertEvents(query, [
        at(A, 1)("session", session()),
        at(A, 2)("harvest", harvest(1000)),
        at(A, 3)("money", sale(1000, 500)),
        // The player saved here (seq 3), played on, and later reloads that savegame.
        at(A, 4)("harvest", harvest(2000)),
        at(A, 5)("money", sale(2000, 1100)),
      ]),
    );
    expect(await active()).toBe(A);
    expect((await counted()).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(await wheat()).toMatchObject({ revenue: 1600, yields: [{ liters: 3000 }] });
  });

  it("forks at the savegame's seq when an older save is reloaded, and drops what came after", async () => {
    const at = events(saveId);
    const later = "2026-09-21T10:00:00Z";
    await db.as(owner, (query) =>
      insertEvents(query, [
        at(B, 4, later)("session", session({ parentBranchId: A, forkSeq: 3 })),
        at(B, 5, later)("harvest", harvest(1500)),
        at(B, 6, later)("money", sale(1500, 750)),
      ]),
    );
    expect(await active()).toBe(B);
    const lineage = await db.as(owner, (query) =>
      query(
        "select branch_id, max_seq, depth from public.save_lineage where save_id = $1 order by depth",
        [saveId],
      ),
    );
    expect(lineage).toEqual([
      { branch_id: B, max_seq: null, depth: 0 },
      { branch_id: A, max_seq: 3, depth: 1 },
    ]);
    expect(await counted()).toEqual([
      { branch_id: A, seq: 1 },
      { branch_id: A, seq: 2 },
      { branch_id: A, seq: 3 },
      { branch_id: B, seq: 4 },
      { branch_id: B, seq: 5 },
      { branch_id: B, seq: 6 },
    ]);
    // 1000 L sold for 500 and 1500 L for 750: 2500 L at 0.50. The abandoned 2000 L are gone.
    expect(await wheat()).toMatchObject({
      revenue: 1250,
      yields: [{ liters: 2500, pricePerLiter: 0.5 }],
    });
  });

  it("follows the fork points of every ancestor", async () => {
    const at = events(saveId);
    const latest = "2026-09-22T10:00:00Z";
    await db.as(owner, (query) =>
      insertEvents(query, [
        at(C, 6, latest)("session", session({ parentBranchId: B, forkSeq: 5 })),
        at(C, 7, latest)("money", sale(500, 300)),
      ]),
    );
    expect(await active()).toBe(C);
    expect(
      (await counted()).map(
        (e) => `${e.branch_id === A ? "A" : e.branch_id === B ? "B" : "C"}${e.seq}`,
      ),
    ).toEqual(["A1", "A2", "A3", "B4", "B5", "C6", "C7"]);
  });

  it("goes back to a branch when its latest save is loaded again", async () => {
    const at = events(saveId);
    await db.as(owner, (query) =>
      insertEvents(query, [at(A, 6, "2026-09-23T10:00:00Z")("session", session())]),
    );
    expect(await active()).toBe(A);
    expect((await counted()).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(await wheat()).toMatchObject({ revenue: 1600, yields: [{ liters: 3000 }] });
  });

  it("ignores a replayed batch, and a second fork claim for the same branch", async () => {
    const at = events(saveId);
    const replay = [
      at(B, 4, "2026-09-21T10:00:00Z")("session", session({ parentBranchId: A, forkSeq: 3 })),
      at(B, 5, "2026-09-21T10:00:00Z")("harvest", harvest(1500)),
    ];
    expect(await db.as(owner, (query) => insertEvents(query, replay))).toBe(0);
    // A later session on B that claims another fork point must not rewrite B's lineage.
    await db.as(owner, (query) =>
      insertEvents(query, [
        at(B, 8, "2026-09-19T10:00:00Z")("session", session({ parentBranchId: A, forkSeq: 1 })),
      ]),
    );
    const branches = await db.admin<{
      branch_id: string;
      parent_branch_id: string;
      fork_seq: number;
    }>(
      "select branch_id, parent_branch_id, fork_seq from public.save_branches where save_id = $1",
      [saveId],
    );
    expect(branches.find((b) => b.branch_id === B)).toMatchObject({
      parent_branch_id: A,
      fork_seq: 3,
    });
    // An older wall-clock time does not move B's last session back, and A stays active.
    expect(await active()).toBe(A);
  });

  it("reads field sizes from the active branch's latest snapshot, else its parent's", async () => {
    const other = await db.as(owner, (query) => createSave(query));
    const at = events(other);
    const root = randomUUID();
    const child = randomUUID();
    const fields = (areaHa: number) =>
      JSON.stringify({
        farms: [],
        fields: [{ fieldId: 1, farmlandId: 1, areaHa, ownerFarmId: 1 }],
      });
    await db.as(owner, async (query) => {
      await insertEvents(query, [at(root, 1)("session", session())]);
      await query(
        "insert into public.snapshots (save_id, branch_id, day, payload) values ($1, $2, 3, $3)",
        [other, root, fields(4)],
      );
      await query(
        "insert into public.snapshots (save_id, branch_id, day, payload) values ($1, $2, 9, $3)",
        [other, root, fields(5)],
      );
      await insertEvents(query, [
        at(
          child,
          2,
          "2026-09-21T10:00:00Z",
        )("session", session({ parentBranchId: root, forkSeq: 1 })),
      ]);
    });
    const area = async () =>
      (
        await db.as(owner, (query) =>
          query<{ area_ha: number; last_seen_day: number }>(
            "select area_ha, last_seen_day from public.fields where save_id = $1",
            [other],
          ),
        )
      )[0];
    expect(await area()).toEqual({ area_ha: 5, last_seen_day: 9 });
    await db.as(owner, (query) =>
      query(
        "insert into public.snapshots (save_id, branch_id, day, payload) values ($1, $2, 4, $3)",
        [other, child, fields(4.5)],
      ),
    );
    expect(await area()).toEqual({ area_ha: 4.5, last_seen_day: 4 });
  });

  it("creates the branch for a snapshot that arrives before the branch's first event", async () => {
    const other = await db.as(owner, (query) => createSave(query));
    const branch = randomUUID();
    await db.as(owner, (query) =>
      query(
        "insert into public.snapshots (save_id, branch_id, day, payload) values ($1, $2, 1, '{}')",
        [other, branch],
      ),
    );
    const rows = await db.admin("select branch_id from public.save_branches where save_id = $1", [
      other,
    ]);
    expect(rows).toEqual([{ branch_id: branch }]);
  });
});
