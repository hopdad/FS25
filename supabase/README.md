# supabase

The ledger's Postgres schema for Supabase ([docs/LEDGER.md](../docs/LEDGER.md)).

- `migrations/`: the tables and row-level security, then the views. The views decide which events
  count after a reload, and compute the analytics: `field_season_pnl`, `vehicle_cost_per_hour`,
  `worker_downtime` and `money_reconciliation`.
- `test/`: runs the migrations on a real Postgres. It covers every role's access, the branch rule,
  the golden fixtures in `packages/schema/fixtures/ledger/`, and, with `SCALE_TEST=1`, a save of
  100,000 events. `sync.test.ts` runs the bridge's sync through a real PostgREST, as it runs on
  Supabase.

```sh
pnpm --filter @farmlink/supabase test
```

The tests use `DATABASE_URL` when it is set, or start a throwaway cluster from the local Postgres
binaries, and are skipped without either (unless `REQUIRE_POSTGRES` is set). The sync test also needs
the `postgrest` binary, from `POSTGREST_BIN` or `PATH`, and is skipped without it (unless
`REQUIRE_POSTGREST` is set). Nothing here touches a Supabase project: `test/shim.sql` stands in for
the roles, `auth.uid()` and default grants a project provides.

## Setting up a project

Nothing in this repository creates one. Once a Supabase project exists:

1. Apply `migrations/` in order: `supabase db push`, or paste each file into the SQL editor.
2. **Authentication → Emails → Magic Link**: add the code to the template, for example
   `<p>Your FarmLink code: {{ .Token }}</p>`. The bridge signs in with that 6-digit code typed into
   its console (PLAN_REVIEW.md F6); a link alone cannot reach it.
3. Give the bridge the project's URL and anon key (the anon key is public by design; row-level
   security does the guarding). Either set `FARMLINK_SUPABASE_URL` and `FARMLINK_SUPABASE_ANON_KEY`,
   or write `supabase.json` in the bridge's state folder (`%APPDATA%\FarmLink` on Windows):

   ```json
   { "url": "https://<project>.supabase.co", "anonKey": "<anon key>" }
   ```

4. Run `farmlink-bridge --sign-in you@example.com` once and type the code from the email. The
   session is kept in `auth.json` next to it, readable by your user only; `--sign-out` removes it.
