// What every SQL test file uses: its own database cloned from the migrated template, users in
// auth.users, and statements run the way PostgREST runs them for a signed-in user.

import { randomBytes, randomUUID } from "node:crypto";
import { type EventEnvelope, eventRow } from "@farmlink/schema";
import pg from "pg";
import { afterAll, beforeAll, inject } from "vitest";
import { databaseUrl } from "./cluster";

// numeric and bigint arrive as strings by default; every value in these tests fits a double.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value) => Number(value));
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));

const serverUrl = inject("postgresUrl");
export const hasPostgres = serverUrl !== null;

export type Query = <R extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values?: unknown[],
) => Promise<R[]>;

/** Who runs a statement: a user id (the `authenticated` role with that JWT subject) or anon. */
export type Caller = string | "anon";

export interface Db {
  /** This file's database, for a server of its own such as PostgREST. */
  url: string;
  /** Superuser: seeds users and reads past row-level security. */
  admin: Query;
  /** Runs `fn` in one transaction as `caller`, committed unless it throws. */
  as<T>(caller: Caller, fn: (query: Query) => Promise<T>): Promise<T>;
  /** A new row in auth.users. */
  createUser(): Promise<string>;
}

/** A fresh database for this test file, dropped afterwards. Call at the top of a `describe`. */
export function useDatabase(): Db {
  const name = `farmlink_test_${randomBytes(6).toString("hex")}`;
  let client: pg.Client | undefined;

  beforeAll(async () => {
    const url = serverUrl as string;
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    try {
      await admin.query(`create database ${name} template ${inject("templateDatabase")}`);
    } finally {
      await admin.end();
    }
    client = new pg.Client({ connectionString: databaseUrl(url, name) });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
    const admin = new pg.Client({ connectionString: serverUrl as string });
    await admin.connect();
    try {
      await admin.query(`drop database if exists ${name} with (force)`);
    } finally {
      await admin.end();
    }
  });

  const query: Query = async (text, values) => {
    if (!client) throw new Error("the test database is not ready");
    return (await client.query(text, values)).rows;
  };

  return {
    url: serverUrl === null ? "" : databaseUrl(serverUrl, name),
    admin: query,
    async as(caller, fn) {
      await query("begin");
      try {
        if (caller === "anon") {
          await query("set local role anon");
          await query(`select set_config('request.jwt.claims', '{"role":"anon"}', true)`);
        } else {
          await query("set local role authenticated");
          await query("select set_config('request.jwt.claims', $1, true)", [
            JSON.stringify({ sub: caller, role: "authenticated" }),
          ]);
        }
        const result = await fn(query);
        await query("commit");
        return result;
      } catch (error) {
        await query("rollback");
        throw error;
      }
    },
    async createUser() {
      const id = randomUUID();
      await query("insert into auth.users (id, email) values ($1, $2)", [id, `${id}@test.invalid`]);
      return id;
    },
  };
}

/** Inserts event lines the way the bridge syncs them: one statement, duplicates ignored. */
export async function insertEvents(query: Query, events: EventEnvelope[]): Promise<number> {
  const rows = await query<{ seq: number }>(
    `insert into public.events
     select * from jsonb_populate_recordset(null::public.events, $1::jsonb)
     on conflict (save_id, branch_id, seq) do nothing
     returning seq`,
    [JSON.stringify(events.map(eventRow))],
  );
  return rows.length;
}

/** Creates a save owned by the caller. */
export async function createSave(query: Query, id: string = randomUUID()): Promise<string> {
  await query(
    "insert into public.saves (id, name, map) values ($1, 'Riverbend', 'Riverbend Springs')",
    [id],
  );
  return id;
}
