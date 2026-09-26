# P1 in-game test

P1 is built and tested without the game: the mod's Lua against a stand-in engine, the bridge, and
the phone page in a headless browser. Its three exit criteria need the real thing:

1. The phone follows the tractor you drive with under 1.5 s of delay.
2. A worker stop alert arrives with the right reason.
3. Stopping a worker from the phone works in single-player and in a multiplayer game you host.

**Time:** about 30 minutes. It can follow the [P0 script](P0_TEST.md) in the same session.
**Needs:** the PC with FS25, and a phone on the same Wi-Fi. A second player is optional.

## What the mod does in the game

It still only watches, with one exception. When you tap Stop on the phone (twice), it stops that
hired worker, exactly as the worker's stop button in the game does. It never starts, drives or buys
anything.

## 1. Get the files

From GitHub: **Actions** → **CI** → the latest green run on `claude/repo-structure-build-plan-10lbox`
→ **Artifacts** → `farmlink-p1`. It holds `FS25_FarmLink.zip` (the mod, version 0.2.0.0) and
`farmlink-bridge.exe` (version 0.2.0). Put the zip in
`Documents\My Games\FarmingSimulator2025\mods\`, replacing any older FarmLink zip.

## 2. Start the bridge and pair your phone

1. Double-click `farmlink-bridge.exe`. If SmartScreen warns about an unknown app, choose
   **More info**, then **Run anyway**.
2. If Windows Firewall asks, allow access on **private networks**. Without it the phone cannot
   connect.
3. The window shows a link such as `http://192.168.1.23:8790/?t=...` and a QR code. Scan the code
   with the phone's camera and open the link. If several links are listed, use the one that starts
   like your router's addresses (usually `192.168.`).
4. Bookmark the page or add it to the home screen. The link keeps working after the bridge restarts.
   `farmlink-bridge.exe --reset-token` makes a new link and locks out the old one.

Until you load a save, the page says **Waiting for the game**. Leave the bridge window open.

## 3. Single-player

Load a single-player career with FarmLink ticked, and keep the phone beside the screen.

1. **Following the tractor (criterion 1).** Get into a tractor. The phone's header turns green
   (**Live**) and shows your tractor. Pull away and brake: the speed gauge should follow the game's
   speedometer within about a second. Hitch an implement and check that it appears with its fill
   level. Note roughly how much delay you see.
2. **A stop alert (criterion 2).** Hire a worker on a job that ends by itself, and watch the phone.
   Any of these works:
   - A combine harvesting with no trailer to unload into: about 2 minutes before its tank is full
     you get **Tank almost full**, then **Worker stopped: … grain tank full**.
   - A seeder or sprayer that is nearly empty: **… ran out of seed, fertilizer or other material**.
   - Any job on a small field: **Worker finished: … job finished**.

   Check that the reason on the phone matches what happened in the game, and note it.
3. **Stopping from the phone (criterion 3, single-player).** Hire a worker on any field. On the
   phone, under **Workers**, tap **Stop**, then **Tap again to stop**. The worker should stop in the
   game within a couple of seconds, and the phone should say **Stopped**. No stop alert should pop up
   for it, since you stopped it yourself.
4. **Pausing.** Press Esc so the game pauses, and watch the phone for 20 seconds. Note whether the
   header switches to **Game offline**. This tells me whether the mod keeps running while the game is
   paused.
5. **Leaving.** Quit to the main menu. Within about 15 seconds the phone should show
   **Game offline** and a pop-up saying so.

## 4. Multiplayer that you host

1. From the main menu choose **Multiplayer**, create a game from a savegame, and tick FarmLink.
   A friend joining is welcome but not needed.
2. With the bridge still running, the phone switches to this save within a few seconds; the header
   shows its name.
3. Repeat the stop test: hire a worker, then stop it from the phone. It should stop in the game, and
   for anyone who joined.
4. If a friend joined on another farm, the header gets a farm picker. Their workers and alerts show
   only when their farm is picked.

## 5. Send back

1. While the game is still running and the bridge window is still open, open a terminal next to
   `farmlink-bridge.exe` and run:

   ```sh
   farmlink-bridge.exe --doctor --json > doctor-p1.json
   ```

   It only reads, so it runs alongside the open bridge. The report leaves out the pairing link.
2. `bridge.log` from `%APPDATA%\FarmLink\` (paste that path into the Explorer address bar).
3. The lines containing `[FarmLink]` from `Documents\My Games\FarmingSimulator2025\log.txt`, plus any
   Lua error lines near them.
4. Your notes: the delay you saw, the stop reason shown, and what the phone did while paused.

If something looks wrong on the phone, a screenshot helps.

## When something does not work

| What you see | What to check |
| --- | --- |
| The phone cannot open the page | Same Wi-Fi (not a guest network, which keeps devices apart)? Firewall allowed on private networks, and Windows set to treat your Wi-Fi as a **Private** network (Settings → Network → your network → Network profile type)? Try the other links listed in the bridge window |
| The QR code looks garbled | Type the link printed above it into the phone's browser |
| **Link out of date** | The link was reset with `--reset-token`: scan the new code |
| **Bridge not reachable** | The bridge window was closed, or the PC went to sleep |
| **Game offline** while you play | Run `--doctor`: it shows whether `live_vehicle.json` is still being written |
| Stop says **No answer from the game** | The game was paused or the mod is not running; `--doctor` shows whether the mod answered the command |

## How the exit criteria are judged

| Exit criterion | Passes when | Where it shows |
| --- | --- | --- |
| Phone follows the tractor within 1.5 s | The gauge follows the speedometer within about a second | Your note; the doctor's `live_vehicle.json updates cleanly` line |
| Stop alert with the right reason | The phone's reason matches the game | Your note; the doctor lists the stop reasons it saw |
| Stop from the phone, single-player and hosted multiplayer | The worker stops and the phone says **Stopped** | The doctor's `Commands reach the mod and come back` line, and `bridge.log` |
