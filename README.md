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

**P0 (spike): built and tested outside the game; waiting on the in-game run.**

- The mod loads, resolves its modSettings folder, keeps a saveId in the savegame and writes
  `live_vehicle.json` every second.
- The bridge finds those files, validates each frame and prints it.
- A probe records the runtime answers to the verify-first questions.

The P0 exit criteria need a real game session; [docs/P0_TEST.md](docs/P0_TEST.md) is the 20-minute
script for it.

| Document | What it is |
| --- | --- |
| [docs/HANDOFF.md](docs/HANDOFF.md) | The product and technical spec, as handed off |
| [docs/PLAN_REVIEW.md](docs/PLAN_REVIEW.md) | Review of the spec: findings, adopted refinements, open decisions |
| [docs/VERIFY_FIRST.md](docs/VERIFY_FIRST.md) | FS25 API answers from real game code, with sources |
| [docs/P0_TEST.md](docs/P0_TEST.md) | The in-game test that closes P0 |

## How it fits together

The mod never touches the network; the bridge owns all networking.

```text
FS25 (server or single-player host)            the same PC
┌──────────────────────────────┐   files   ┌───────────────────────────┐
│ FS25_FarmLink mod            │ ────────▶ │ farmlink-bridge           │ ──▶ phone (LAN, P1)
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
| `packages/live-ui/` | React components shared by the phone page and the web app | P1 |
| `supabase/` | Migrations, row-level security, analytics views | P2 |
| `web/` | Next.js web app | P4 |

## Development

You need Node 22+ and pnpm 10. Lua work needs Lua 5.1 with busted. Building the bridge executable
needs Bun.

```sh
pnpm install

pnpm check          # everything CI runs: lint, typecheck, TypeScript tests, Lua specs
pnpm test           # TypeScript tests, including the Lua-to-schema end-to-end test
pnpm test:lua       # busted specs under Lua 5.1
pnpm format         # Biome, with fixes

pnpm --filter @farmlink/bridge run start --dir <folder>    # follow live_vehicle.json
pnpm --filter @farmlink/bridge run doctor --dir <folder>   # paths, freshness, P0 checklist
pnpm --filter @farmlink/schema run json-schema            # regenerate json-schema/ after a contract change

node mod/tools/package.mjs                                 # mod/build/FS25_FarmLink.zip
pnpm --filter @farmlink/bridge build:win                   # bridge/bin/farmlink-bridge.exe
```

On Ubuntu, the Lua toolchain is `sudo apt-get install lua5.1 lua-busted lua-dkjson lua-filesystem`.
Elsewhere, install Lua 5.1 and run `luarocks install busted dkjson luafilesystem`.

To see the whole P0 pipeline without the game:

```sh
lua5.1 mod/sim/run.lua /tmp/fs25-profile 3
pnpm --filter @farmlink/bridge run doctor --dir /tmp/fs25-profile --observe 0
```

CI (`.github/workflows/ci.yml`) runs the checks on every push. On success it uploads
`FS25_FarmLink.zip` and `farmlink-bridge.exe` as the `farmlink-p0` artifact.
