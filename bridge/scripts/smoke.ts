// Smoke test for a compiled bridge binary: starts it against a save folder with fresh files and
// checks what a phone needs from it. CI runs it on the Linux build, which Bun compiles from the same
// source as the Windows one.
//
//   pnpm --filter @farmlink/bridge run smoke bin/farmlink-bridge-linux

import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { frame, meta, SAVE_ID, tempRoot, tractor, writeSave } from "../test/fixtures";

const PORT = 18790;

async function until<T>(
  what: string,
  check: () => T | undefined | Promise<T | undefined>,
  ms = 10_000,
) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== undefined) return value;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function socketMessages(url: string, count: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const seen: string[] = [];
    const timer = setTimeout(() => reject(new Error(`only got ${seen.join(", ")}`)), 5000);
    socket.on("message", (data) => {
      seen.push((JSON.parse(String(data)) as { type: string }).type);
      if (seen.length >= count) {
        clearTimeout(timer);
        socket.close();
        resolve(seen);
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function refused(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url);
    socket.on("open", () => {
      socket.close();
      resolve(false);
    });
    socket.on("error", () => resolve(true));
  });
}

async function main(binary: string): Promise<void> {
  const root = tempRoot();
  const saveDir = writeSave(root, SAVE_ID, { "meta.json": meta() });
  const live = join(saveDir, "live_vehicle.json");
  let minute = 800;
  const game = setInterval(
    () => writeFileSync(live, JSON.stringify(frame(tractor, minute++))),
    300,
  );
  writeFileSync(live, JSON.stringify(frame(tractor, minute)));

  const args = [
    "--dir",
    root,
    "--state",
    tempRoot(),
    "--port",
    String(PORT),
    "--host",
    "127.0.0.1",
    "--no-qr",
  ];
  const child = spawn(resolve(binary), args, { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const exited = new Promise<number | null>((done) => child.on("exit", (code) => done(code)));

  try {
    const token = await until(
      "the pairing link",
      () => output.match(/\/\?t=([A-Za-z0-9_-]+)/)?.[1],
    );
    const base = `http://127.0.0.1:${PORT}`;

    const page = await (await fetch(`${base}/`)).text();
    if (!page.includes("<title>FarmLink Live</title>")) throw new Error("the page is not embedded");

    await until("the game to show as online", async () => {
      const response = await fetch(`${base}/api/status?t=${token}`);
      const body = (await response.json()) as { status: { saveId: string; gameOnline: boolean } };
      return body.status.saveId === SAVE_ID && body.status.gameOnline ? true : undefined;
    });

    const types = await socketMessages(`ws://127.0.0.1:${PORT}/ws?t=${token}`, 4);
    if (types.slice(0, 3).join() !== "hello,status,alerts") throw new Error(`socket sent ${types}`);
    if (!(await refused(`ws://127.0.0.1:${PORT}/ws?t=wrong`)))
      throw new Error("wrong token accepted");

    const abort = new AbortController();
    const posted = fetch(`${base}/api/commands`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ type: "ping", farmId: 1 }),
      signal: abort.signal,
    }).catch(() => undefined);
    await until("commands.xml", () =>
      existsSync(join(saveDir, "commands.xml")) ? true : undefined,
    );
    await until("bridge.xml", () => (existsSync(join(saveDir, "bridge.xml")) ? true : undefined));
    abort.abort();
    await posted;

    child.kill("SIGINT");
    const code = await Promise.race([exited, sleep(5000).then(() => "timeout")]);
    if (code !== 0) throw new Error(`exit after Ctrl+C: ${code}`);
    console.log(
      "smoke test passed: page, status, WebSocket, token check, commands, heartbeat, exit",
    );
  } catch (error) {
    child.kill("SIGKILL");
    console.error(output);
    throw error;
  } finally {
    clearInterval(game);
  }
}

const binary = process.argv.slice(2).find((arg) => arg !== "--");
if (!binary) {
  console.error("usage: tsx scripts/smoke.ts <compiled bridge binary>");
  process.exit(2);
}
main(binary).catch((error: unknown) => {
  console.error(`smoke test failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
