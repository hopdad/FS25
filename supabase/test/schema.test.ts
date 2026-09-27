// The migrations as a whole: they apply to a Supabase-shaped database, every table has row-level
// security, every view runs as its caller, and the API roles get exactly the privileges intended.

import { describe, expect, it } from "vitest";
import { hasPostgres, useDatabase } from "./db";

describe.skipIf(!hasPostgres)("the ledger schema", () => {
  const db = useDatabase();

  it("turns on row-level security for every table in public", async () => {
    const tables = await db.admin<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class
       where relnamespace = 'public'::regnamespace and relkind = 'r' order by relname`,
    );
    expect(tables.map((t) => t.relname)).toEqual([
      "events",
      "save_branches",
      "save_members",
      "saves",
      "snapshots",
    ]);
    expect(tables.every((t) => t.relrowsecurity)).toBe(true);
  });

  it("makes every view run as its caller, so the tables' policies apply", async () => {
    const views = await db.admin<{ relname: string; reloptions: string[] | null }>(
      `select relname, reloptions from pg_class
       where relnamespace = 'public'::regnamespace and relkind = 'v' order by relname`,
    );
    expect(views.map((v) => v.relname)).toEqual([
      "field_season_pnl",
      "fields",
      "ledger_events",
      "money_reconciliation",
      "prices",
      "save_active_branch",
      "save_lineage",
      "vehicle_cost_per_hour",
      "vehicles",
      "worker_downtime",
    ]);
    for (const view of views) {
      expect(view.reloptions, view.relname).toContain("security_invoker=true");
    }
  });

  it("grants anon nothing at all", async () => {
    const grants = await db.admin<{ table_name: string; privilege_type: string }>(
      `select table_name, privilege_type from information_schema.role_table_grants
       where grantee = 'anon' and table_schema = 'public'`,
    );
    expect(grants).toEqual([]);
    const functions = await db.admin<{ proname: string }>(
      `select p.proname from pg_proc p
       where p.pronamespace = 'public'::regnamespace and has_function_privilege('anon', p.oid, 'execute')`,
    );
    expect(functions).toEqual([]);
  });

  it("keeps events append-only and views read-only for the signed-in", async () => {
    const grants = await db.admin<{ table_name: string; privileges: string }>(
      `select table_name, string_agg(privilege_type, ',' order by privilege_type) as privileges
       from information_schema.role_table_grants
       where grantee = 'authenticated' and table_schema = 'public'
       group by table_name order by table_name`,
    );
    const byTable = Object.fromEntries(grants.map((g) => [g.table_name, g.privileges]));
    expect(byTable).toMatchObject({
      events: "INSERT,SELECT",
      save_branches: "INSERT,SELECT,UPDATE",
      save_members: "DELETE,INSERT,SELECT,UPDATE",
      saves: "DELETE,INSERT,SELECT",
      snapshots: "INSERT,SELECT,UPDATE",
      field_season_pnl: "SELECT",
      ledger_events: "SELECT",
      money_reconciliation: "SELECT",
      vehicle_cost_per_hour: "SELECT",
      worker_downtime: "SELECT",
    });
    const saveColumns = await db.admin<{ column_name: string }>(
      `select column_name from information_schema.column_privileges
       where grantee = 'authenticated' and table_name = 'saves' and privilege_type = 'UPDATE'
       order by column_name`,
    );
    expect(saveColumns.map((c) => c.column_name)).toEqual([
      "last_synced_at",
      "map",
      "mod_version",
      "name",
    ]);
  });
});
