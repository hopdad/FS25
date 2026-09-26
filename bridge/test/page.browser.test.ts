// The phone page in a real browser, served by the real bridge: the page shows the live data, pops
// up a fresh alert, and a two-tap Stop reaches commands.xml and shows the mod's answer. Skipped
// when no Chromium or Chrome is installed; GitHub's runners have Chrome.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseCommandsXml } from "@farmlink/schema";
import { type Browser, chromium, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Io, main } from "../src/cli";
import { localIsoWithOffset } from "../src/time";
import {
  aiJob,
  farmFrame,
  fleetFrame,
  frame,
  meta,
  SAVE_ID,
  stopEntry,
  tempRoot,
  tractor,
  writeSave,
} from "./fixtures";

function findChromium(): string | undefined {
  const candidates = [
    process.env.CHROMIUM_PATH,
    "/opt/pw-browsers/chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  return candidates.find((path): path is string => path !== undefined && existsSync(path));
}

const executablePath = findChromium();
if (!executablePath && process.env.REQUIRE_BROWSER) {
  throw new Error("REQUIRE_BROWSER is set, but no Chromium or Chrome was found");
}

interface Bridge {
  port: number;
  token: string;
  stop: () => Promise<number>;
}

/** Runs the bridge's serve mode in this process, as `farmlink-bridge` would. */
async function startBridge(root: string, stateDir: string, port = 0): Promise<Bridge> {
  let stop: () => void = () => {};
  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
  });
  const io: Io = { out: () => {}, err: () => {}, stopSignal: () => stopped };
  let running: Promise<number> = Promise.resolve(0);
  const info = await new Promise<{ port: number; token: string }>((resolve) => {
    running = main(
      [
        "--dir",
        root,
        "--state",
        stateDir,
        "--port",
        String(port),
        "--host",
        "127.0.0.1",
        "--no-qr",
      ],
      io,
      { platform: "linux", home: "/nonexistent", env: {} },
      { onListening: resolve },
    );
  });
  return {
    ...info,
    stop: () => {
      stop();
      return running;
    },
  };
}

describe.skipIf(!executablePath)("the phone page in a browser", { timeout: 30_000 }, () => {
  let browser: Browser;
  let root: string;
  let stateDir: string;
  let saveDir: string;
  let base: string;
  let token: string;
  let bridge: Bridge;
  let game: NodeJS.Timeout;

  beforeAll(async () => {
    root = tempRoot();
    stateDir = tempRoot();
    saveDir = writeSave(root, SAVE_ID, {
      "meta.json": meta(),
      "live_fleet.json": fleetFrame({
        jobs: [aiJob({ jobId: "7", tankFillPct: 55 })],
        stops: [stopEntry(1, "ERROR_OUT_OF_FUEL", localIsoWithOffset())],
      }),
      "live_farm.json": farmFrame(),
    });
    // The game: a fresh vehicle frame every 300 ms keeps it online.
    let minute = 845;
    const tick = () =>
      writeFileSync(
        join(saveDir, "live_vehicle.json"),
        JSON.stringify(frame(tractor, minute++ % 1440)),
      );
    tick();
    game = setInterval(tick, 300);

    bridge = await startBridge(root, stateDir);
    base = `http://127.0.0.1:${bridge.port}`;
    token = bridge.token;
    browser = await chromium.launch({ executablePath });
  });

  afterAll(async () => {
    clearInterval(game);
    await browser?.close();
    await bridge.stop();
  });

  async function open(link: string): Promise<{ page: Page; errors: string[] }> {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.goto(link);
    return { page, errors };
  }

  it("shows the game live, with the fresh worker stop popped up", async () => {
    const { page, errors } = await open(`${base}/?t=${token}`);
    await page.getByText("Live", { exact: true }).waitFor();
    await page.getByRole("heading", { name: "Fendt 942 Vario" }).waitFor();
    await page
      .locator(".toast.critical", { hasText: "Alex on Claas Lexion 8900: out of fuel" })
      .waitFor();
    expect(await page.locator(".job").count()).toBe(1);
    expect(await page.title()).toBe("FarmLink · Riverbend Springs");
    expect(errors).toEqual([]);
  });

  it("stops a worker with two taps and shows the game's answer", async () => {
    const { page, errors } = await open(`${base}/?t=${token}`);
    const stop = page.locator(".job button.stop");
    await stop.waitFor();
    await page.getByText("Live", { exact: true }).waitFor();
    await stop.click();
    await page.getByRole("button", { name: "Tap again to stop" }).click();
    await page.getByRole("button", { name: "Stopping…" }).waitFor();

    const commandsPath = join(saveDir, "commands.xml");
    await expect.poll(() => existsSync(commandsPath)).toBe(true);
    const file = parseCommandsXml(readFileSync(commandsPath, "utf8"));
    const command = file.commands.at(-1);
    expect(command).toMatchObject({ type: "worker.stop", farmId: 1, args: { jobId: "7" } });

    // Answer the way the mod does.
    writeFileSync(
      join(saveDir, "acks.json"),
      JSON.stringify({
        v: 1,
        epoch: file.epoch,
        watermark: command?.id,
        acks: [{ v: 1, id: command?.id, status: "ok", message: null, at: localIsoWithOffset() }],
      }),
    );
    await page.locator(".answer.ok", { hasText: "Stopped" }).waitFor();
    expect(errors).toEqual([]);
  });

  it("waits out a bridge restart and reconnects by itself", async () => {
    const { page, errors } = await open(`${base}/?t=${token}`);
    await page.getByText("Live", { exact: true }).waitFor();
    expect(await bridge.stop()).toBe(0);
    await page.getByText("Bridge not reachable").waitFor();

    bridge = await startBridge(root, stateDir, bridge.port);
    await page.getByText("Live", { exact: true }).waitFor({ timeout: 15_000 });
    // The WebSocket failing while the bridge was down is expected noise, nothing else is.
    expect(errors.filter((e) => !e.includes("WebSocket") && !e.includes("Failed to load"))).toEqual(
      [],
    );
  });

  it("tells a phone with an old link to scan the new code", async () => {
    const { page } = await open(`${base}/?t=not-the-token`);
    await page.getByText("Link out of date").waitFor();
    await page.getByText("scan the QR code").waitFor();
  });
});
