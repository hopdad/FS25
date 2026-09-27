# FarmLink for Farming Simulator 25

FarmLink turns every money, harvest, field-work and hired-worker event in an FS25 save into a durable
ledger. It serves that ledger in the game, on a phone over the LAN, and in a web app. It is
multiplayer-first: only the server writes the ledger.

| Tier | What the player installs | What they get |
| --- | --- | --- |
| Mod only | `FS25_FarmLink` | In-game analytics, CSV export, aggregates saved with the savegame |
| Mod + bridge | Plus the bridge executable | Live phone dashboard, worker stop alerts, remote worker commands, xlsx export |
| Mod + bridge + web | Plus a free account | Season analytics, history across saves, shared farm access |

## Status

P0 and P1 are built and tested outside the game, and wait on an in-game run. P2 has started.

**P0 (spike).** The mod loads, resolves its modSettings folder, keeps a saveId in the savegame and
writes `live_vehicle.json` every second. The bridge finds and validates those files, and a probe
records the runtime answers to the verify-first questions. [docs/P0_TEST.md](docs/P0_TEST.md) is
the 20-minute script that closes it.

**P1 (live).** The mod also writes the fleet (machines, hired workers, why workers stopped) and the
farm (money, silos, weather), and stops a worker when the bridge asks. The bridge serves a phone
page on the LAN behind a pairing token, with gauges, a worker board with Stop buttons, the fleet,
the farm and alerts. [docs/P1_TEST.md](docs/P1_TEST.md) is the 30-minute script that closes it.

**P2 (ledger), started.** The Supabase schema is written and tested on Postgres:
- row-level security for owners, members and viewers;
- the branch rule, so a reloaded older save never double-counts;
- the analytics views: field P&L, machine cost per hour, worker downtime and money reconciliation.

Golden fixtures pin each formula. The mod's event log and the bridge's sync come next;
[docs/LEDGER.md](docs/LEDGER.md) describes the ledger.

| Document | What it is |
| --- | --- |
| [docs/HANDOFF.md](docs/HANDOFF.md) | The product and technical spec, as handed off |
| [docs/PLAN_REVIEW.md](docs/PLAN_REVIEW.md) | Review of the spec: findings, adopted refinements, open decisions |
| [docs/VERIFY_FIRST.md](docs/VERIFY_FIRST.md) | FS25 API answers from real game code, with sources |
| [docs/P0_TEST.md](docs/P0_TEST.md) | The in-game test that closes P0 |
| [docs/P1_TEST.md](docs/P1_TEST.md) | The in-game test that closes P1 |
| [docs/LEDGER.md](docs/LEDGER.md) | The ledger (P2): which events count, the analytics formulas, access |

## How it fits together

The mod never touches the network; the bridge owns all networking.

```text
FS25 (server or single-player host)            the same PC
┌──────────────────────────────┐   files   ┌───────────────────────────┐
│ FS25_FarmLink mod            │ ────────▶ │ farmlink-bridge           │ ──▶ phone page (LAN)
│  writes modSettings/         │           │  reads, validates, serves │ ──▶ Supabase (P2)
│  FS25_FarmLink/<saveId>/     │ ◀──────── │  writes commands (XML)    │
└──────────────────────────────┘           └───────────────────────────┘
```

Every file format is defined once, in Zod, in `packages/schema`. The mod's Lua output is tested
against the exported JSON Schema.

## Layout

| Path | Contents | Phase |
| --- | --- | --- |
| `mod/FS25_FarmLink/` | The mod: `modDesc.xml`, `scripts/` (Lua 5.1), `l10n/` | P0 |
| `mod/spec/`, `mod/sim/` | busted specs, and a stand-in for the engine that runs the mod outside the game | P0 |
| `mod/tools/` | `package.mjs` builds `mod/build/FS25_FarmLink.zip`; `make_icon.py` draws the icon | P0 |
| `bridge/` | Node + TypeScript bridge, compiled to one executable with Bun | P0 |
| `packages/schema/` | Zod contracts for every file, and their JSON Schema in `json-schema/` | P0 |
| `packages/live-ui/` | The live views, shared by the phone page and (later) the web app | P1 |
| `supabase/` | Migrations, row-level security, analytics views, and their tests on Postgres | P2 |
| `web/` | Next.js web app | P4 |

## Development

You need Node 22+ and pnpm 10. Lua work needs Lua 5.1 with busted. Building the bridge executable
needs Bun. The SQL tests need Postgres 15 or later: a `DATABASE_URL`, or its binaries installed so
they can start a throwaway cluster.

```sh
pnpm install

pnpm check          # everything CI runs: lint, typecheck, TypeScript tests, Lua specs
pnpm test           # TypeScript tests, including the end-to-end tests
pnpm test:lua       # busted specs under Lua 5.1
pnpm format         # Biome, with fixes

pnpm --filter @farmlink/bridge run start --dir <folder>             # serve the phone page
pnpm --filter @farmlink/bridge run start --print --dir <folder>     # print live_vehicle.json frames
pnpm --filter @farmlink/bridge run doctor --dir <folder>            # paths, freshness, P0 and P1 checks
pnpm --filter @farmlink/live-ui run build                           # rebuild the page after changing it
pnpm --filter @farmlink/schema run json-schema                     # regenerate json-schema/ after a contract change

node mod/tools/package.mjs                                          # mod/build/FS25_FarmLink.zip
pnpm --filter @farmlink/bridge build:win                            # bridge/bin/farmlink-bridge.exe (needs Bun)
```

On Ubuntu, the Lua toolchain is `sudo apt-get install lua5.1 lua-busted lua-dkjson lua-filesystem`.
Elsewhere, install Lua 5.1 and run `luarocks install busted dkjson luafilesystem`.

To see the whole pipeline without the game, run the mod against the stand-in engine, then serve
what it wrote and open the printed link in a browser:

```sh
lua5.1 mod/sim/run.lua /tmp/fs25-profile 3
pnpm --filter @farmlink/bridge run doctor --dir /tmp/fs25-profile --observe 0
pnpm --filter @farmlink/bridge run start --dir /tmp/fs25-profile
```

The simulated game has stopped by then, so the page shows its last frames as **Game offline**.

CI (`.github/workflows/ci.yml`) runs the checks on every push, including the page in Chrome and a
smoke test of the compiled bridge. On success it uploads `FS25_FarmLink.zip` and
`farmlink-bridge.exe` as the `farmlink-p1` artifact.
