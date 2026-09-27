# supabase

The ledger's Postgres schema for Supabase ([docs/LEDGER.md](../docs/LEDGER.md)).

- `migrations/`: the tables and row-level security, then the views. The views decide which events
  count after a reload, and compute the analytics: `field_season_pnl`, `vehicle_cost_per_hour`,
  `worker_downtime` and `money_reconciliation`.
- `test/`: runs the migrations on a real Postgres. It covers every role's access, the branch rule,
  the golden fixtures in `packages/schema/fixtures/ledger/`, and, with `SCALE_TEST=1`, a save of
  100,000 events.

```sh
pnpm --filter @farmlink/supabase test
```

The tests use `DATABASE_URL` when it is set, or start a throwaway cluster from the local Postgres
binaries, and are skipped without either (unless `REQUIRE_POSTGRES` is set). Nothing here touches a
Supabase project: `test/shim.sql` stands in for the roles, `auth.uid()` and default grants a project
provides.
