# P0 in-game test

P0 cannot finish without the game. Everything that can run without it is built and tested in CI.
This session in FS25 checks the three exit criteria and fills in the runtime half of
[VERIFY_FIRST.md](VERIFY_FIRST.md).

**Time:** about 25 minutes. **Needs:** a Windows PC (or Mac) with FS25 installed and updated.
Multiplayer is not part of P0.

## What the mod does during the test

It only observes. It writes JSON files under `modSettings/FS25_FarmLink/` and `farmLink.xml` in the
savegame folder, and changes nothing in the game. (The P1 build can also stop a hired worker when
you tap Stop on the phone; nothing in this script does that.) The P0 probe wraps `addMoney`, appends to
`Farm.changeBalance` and registers over `Combine.addCutterArea` to count calls. Each hook calls the
game's own function first and returns its result untouched. If anything in FarmLink fails, it logs the
error to `log.txt` and switches that part off.

## 1. Get the files

From GitHub: **Actions** → **CI** → the latest green run on `claude/repo-structure-build-plan-10lbox`
→ **Artifacts** → `farmlink-p1`. It contains:

- `mod/build/FS25_FarmLink.zip`: the mod.
- `bridge/bin/farmlink-bridge.exe`: the bridge for Windows.

The P1 build includes everything this script needs, so the same files serve the
[P1 script](P1_TEST.md) afterwards. The older `farmlink-p0` artifact works for this script too; the
one difference is noted in step 2.

Or build them from a clone:

```sh
pnpm install
node mod/tools/package.mjs                   # mod/build/FS25_FarmLink.zip
pnpm --filter @farmlink/bridge build:win     # bridge/bin/farmlink-bridge.exe (needs Bun)
```

## 2. Install the mod

Copy `FS25_FarmLink.zip` into `Documents\My Games\FarmingSimulator2025\mods\`. If Windows keeps your
Documents folder in OneDrive, it is `OneDrive\Documents\My Games\...` instead.

## 3. Play this script

Start FS25, load a single-player career (or start a new one) and tick **FarmLink** in the mod
selection. Then:

1. **Drive.** Get into a tractor and drive for a minute. This produces `live_vehicle.json`.
2. **Start the bridge.** While still driving, open a terminal next to `farmlink-bridge.exe` and run
   `farmlink-bridge.exe --print` (with the older `farmlink-p0` build, run it with no arguments). It
   should print one line per second with speed, rpm, fuel and your implements. Windows may show a
   SmartScreen warning because the file is unsigned: choose **More info**, then **Run anyway**.
   Leave it running.
3. **Move some money.** Buy fuel at a gas station, and sell something at a selling point. Both,
   if you can: the ledger (P2) books them differently.
4. **Hire a worker.** Start a helper on a field, let it work for a minute or two, then stop it
   yourself. If you can, also let one run out of fuel or fill its tank; different stop reasons help.
5. **Harvest (optional).** If you have a combine and a ripe field, harvest for about 30 seconds.
   Without this, item 5 stays at TODO, but the field lookup is still checked.
6. **Field work (optional).** Sow, spray, cultivate or plow for about 30 seconds.
7. **Pause.** Press Esc, wait 20 seconds, and carry on.
8. **A new day (optional).** Sleep, or fast-forward until the clock passes midnight.
9. **Machines and a new month (optional).** Repair any machine. Buy a cheap machine or tool in
   the shop, and a minute later sell it again. If the game setting that lets helpers buy seed is
   on, hire one to sow for a minute. If the month is about to end, sleep through its last day.
10. **Save.** Press Esc and save the game.
11. **Run the doctor.** Get back into a vehicle, stop the bridge with Ctrl+C and run:

   ```sh
   farmlink-bridge.exe --doctor
   farmlink-bridge.exe --doctor --json > doctor.json
   ```

   The first command prints a checklist. The second saves the same report for me.

## 4. Send back

1. `doctor.json`
2. `Documents\My Games\FarmingSimulator2025\modSettings\FS25_FarmLink\_probe\probe.json`
3. The lines containing `[FarmLink]` from `Documents\My Games\FarmingSimulator2025\log.txt`, plus
   any Lua error lines near them.

## How the exit criteria are judged

| Exit criterion | Doctor line | Passes when |
| --- | --- | --- |
| File updates cleanly in SP | `live_vehicle.json updates cleanly` | About one frame per second over 5 s, with no torn or invalid reads |
| Frame-time cost under 0.5 ms per write | `Live write costs under 0.5 ms` | The average in `meta.json` is below 0.5 ms (it refreshes on every save) |
| Verify-first items 1 to 6 answered | `1.` to `6.` | Each shows PASS; the answers go into VERIFY_FIRST.md |

Items 4 to 6 need the actions in step 3. A TODO on them means the action was not seen during the
session, not that something is broken.

The same session also answers what the ledger (P2) needs to know: whether the mod keeps running
while the game is paused; how sales, fuel, wages, repairs, field work and purchases reach the game's
books; and what a new day and a new month look like. The doctor lists those under "P2 questions";
steps 3, 4 and 6 to 9 feed them, and a TODO there again only means the action did not happen.

## If something goes wrong

| Symptom | Check |
| --- | --- |
| No `modSettings\FS25_FarmLink` folder | FarmLink is not ticked for this savegame, or it failed to load. Search `log.txt` for `FarmLink`. |
| The bridge says it is waiting for the game | Point it at your profile folder: `farmlink-bridge.exe --dir "C:\Users\<you>\Documents\My Games\FarmingSimulator2025"` |
| The bridge prints `dropped an invalid frame` | Copy those lines; they name the field the mod wrote wrongly. |
| The doctor says the game is not running while it is | The game may pause or throttle when its window loses focus. Run the game in windowed mode and the terminal beside it, then run the doctor again. |
| The game shows a FarmLink error | Copy the lines around it from `log.txt`. FarmLink switches the failing part off, and the save is not affected. |

## After P0 passes

The findings go into VERIFY_FIRST.md, the probe is switched off (`Probe.ENABLED = false`), and P1
starts: the fleet and farm channels, the WebSocket phone page with a pairing token, worker stop
alerts, and the command channel with `worker.stop`.
