// The golden fixtures through the SQL views: each fixture's events go in as its save's owner, and
// each view must hold exactly the rows the fixture expects.

import { type LedgerFixture, ledgerFixtures } from "@farmlink/schema/fixtures";
import { beforeAll, describe, expect, it } from "vitest";
import { createSave, hasPostgres, insertEvents, type Query, useDatabase } from "./db";

/** The columns that identify a row of each view within one save. */
const KEYS: Record<string, string[]> = {
  field_season_pnl: ["farm_id", "season", "field_id"],
  vehicle_cost_per_hour: ["vehicle_id"],
  worker_downtime: ["season", "farm_id", "reason"],
  money_reconciliation: ["farm_id", "from_day", "to_day"],
  prices: ["day", "station_id", "fill_type"],
};

/** Deep equality where numbers only have to agree to 6 decimals. */
function expectClose(actual: unknown, expected: unknown, label: string): void {
  if (typeof expected === "number") {
    expect(typeof actual, label).toBe("number");
    expect(actual as number, label).toBeCloseTo(expected, 6);
  } else if (Array.isArray(expected)) {
    expect(Array.isArray(actual), label).toBe(true);
    expect((actual as unknown[]).length, `${label} length`).toBe(expected.length);
    expected.forEach((item, index) => {
      expectClose((actual as unknown[])[index], item, `${label}[${index}]`);
    });
  } else if (expected !== null && typeof expected === "object") {
    expect(actual, label).toBeTypeOf("object");
    for (const [key, value] of Object.entries(expected)) {
      expectClose((actual as Record<string, unknown>)?.[key], value, `${label}.${key}`);
    }
  } else {
    expect(actual, label).toEqual(expected);
  }
}

async function loadFixture(query: Query, fixture: LedgerFixture): Promise<void> {
  await createSave(query, fixture.saveId);
  expect(await insertEvents(query, fixture.events)).toBe(fixture.events.length);
  for (const snapshot of fixture.snapshots) {
    await query(
      "insert into public.snapshots (save_id, branch_id, day, payload) values ($1, $2, $3, $4)",
      [fixture.saveId, fixture.branchId, snapshot.day, JSON.stringify(snapshot.payload)],
    );
  }
}

const fixtures = hasPostgres ? ledgerFixtures() : [];

describe.skipIf(!hasPostgres)("the analytics views against the golden fixtures", () => {
  const db = useDatabase();
  let owner = "";

  beforeAll(async () => {
    owner = await db.createUser();
    for (const fixture of fixtures) {
      await db.as(owner, (query) => loadFixture(query, fixture));
    }
  });

  for (const fixture of fixtures) {
    describe(fixture.name, () => {
      for (const [view, rows] of Object.entries(fixture.expect)) {
        it(`${view} holds the expected rows`, async () => {
          const keys = KEYS[view];
          if (!keys) throw new Error(`no key columns for view ${view}`);
          const actual = await db.as(owner, (query) =>
            query(`select * from public.${view} where save_id = $1`, [fixture.saveId]),
          );
          const describeRow = (row: Record<string, unknown>) =>
            keys.map((key) => `${key}=${String(row[key])}`).join(" ");
          expect(actual.map(describeRow).sort()).toEqual(rows.map(describeRow).sort());
          for (const row of rows) {
            const match = actual.find((candidate) =>
              keys.every((key) => candidate[key] === row[key]),
            );
            expectClose(match, row, `${view} ${describeRow(row)}`);
          }
        });
      }
    });
  }
});
