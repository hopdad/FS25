import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type Io, main } from "../src/cli";
import type { Environment } from "../src/config";
import { BRIDGE_VERSION } from "../src/version";
import { frame, meta, tempRoot, tractor, writeSave } from "./fixtures";

const environment: Environment = { platform: "linux", home: "/nonexistent", env: {} };

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  let stop: () => void = () => {};
  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
  });
  const io: Io = { out: (l) => out.push(l), err: (l) => err.push(l), stopSignal: () => stopped };
  return { out, err, io, stop };
}

describe("farmlink-bridge", () => {
  it("prints its version", async () => {
    const { out, io } = capture();
    expect(await main(["--version"], io, environment)).toBe(0);
    expect(out).toEqual([BRIDGE_VERSION]);
  });

  it('accepts the "--" that pnpm run forwards', async () => {
    const { out, io } = capture();
    expect(await main(["--doctor", "--", "--version"], io, environment)).toBe(0);
    expect(out).toEqual([BRIDGE_VERSION]);
  });

  it("rejects an unknown option with exit code 2", async () => {
    const { err, io } = capture();
    expect(await main(["--frobnicate"], io, environment)).toBe(2);
    expect(err.join("\n")).toMatch(/frobnicate/);
  });

  it("runs --doctor as JSON on a folder the game has not created yet", async () => {
    const { out, io } = capture();
    const dir = join(tempRoot(), "FS25_FarmLink");
    expect(await main(["--doctor", "--json", "--dir", dir], io, environment)).toBe(0);
    const report = JSON.parse(out.join("\n"));
    expect(report.root.exists).toBe(false);
    expect(report.checks.map((c: { status: string }) => c.status)).not.toContain("fail");
  });

  it("follows the active save and prints each new frame", async () => {
    const root = tempRoot();
    const dir = writeSave(root, undefined, {
      "meta.json": meta(),
      "live_vehicle.json": frame(tractor, 845),
    });
    const { out, err, io, stop } = capture();
    const running = main(["--print", "--dir", root, "--json"], io, environment);

    await vi.waitFor(() => expect(out).toHaveLength(1), { timeout: 3000 });
    writeFileSync(join(dir, "live_vehicle.json"), JSON.stringify(frame(null, 846)));
    await vi.waitFor(() => expect(out).toHaveLength(2), { timeout: 3000 });

    stop();
    expect(await running).toBe(0);
    expect(JSON.parse(out[1] ?? "").minute).toBe(846);
    expect(err.join("\n")).toMatch(/following save 6f1c2d3e/);
  });

  it("rejects a port that is not a number", async () => {
    const { err, io } = capture();
    expect(await main(["--port", "eighty"], io, environment)).toBe(2);
    expect(err).toEqual(["--port takes a port number"]);
  });
});

describe("farmlink-bridge serving the phone page", () => {
  async function serveOnce(args: string[], root: string, stateDir: string) {
    const { out, err, io, stop } = capture();
    let listening: { port: number; token: string; urls: string[] } | undefined;
    const running = main(
      [
        "--dir",
        root,
        "--state",
        stateDir,
        "--port",
        "0",
        "--host",
        "127.0.0.1",
        "--no-qr",
        ...args,
      ],
      io,
      environment,
      { page: "<p>page</p>", onListening: (info) => (listening = info) },
    );
    await vi.waitFor(() => expect(listening).toBeDefined());
    return { out, err, running, stop, info: listening as NonNullable<typeof listening> };
  }

  it("serves the page, prints the pairing link and follows the active save", async () => {
    const root = tempRoot();
    writeSave(root, undefined, { "meta.json": meta(), "live_vehicle.json": frame(tractor) });
    const { out, err, running, stop, info } = await serveOnce([], root, tempRoot());

    expect(info.urls).toEqual([`http://127.0.0.1:${info.port}/?t=${info.token}`]);
    expect(out).toContain(`  ${info.urls[0]}`);
    const base = `http://127.0.0.1:${info.port}`;
    expect(await (await fetch(`${base}/`)).text()).toBe("<p>page</p>");
    await vi.waitFor(async () => {
      const response = await fetch(`${base}/api/status?t=${info.token}`);
      const body = (await response.json()) as { status: unknown };
      expect(body.status).toMatchObject({
        saveId: "6f1c2d3e-4a5b-4c6d-8e7f-0123456789ab",
        saveName: "Riverbend Springs",
        gameOnline: true,
      });
    });

    stop();
    expect(await running).toBe(0);
    expect(err.join("\n")).toMatch(/following save 6f1c2d3e/);
  });

  it("keeps the pairing token between runs until --reset-token", async () => {
    const root = tempRoot();
    const stateDir = tempRoot();
    const tokens: string[] = [];
    for (const args of [[], [], ["--reset-token"]]) {
      const { running, stop, info } = await serveOnce(args, root, stateDir);
      tokens.push(info.token);
      stop();
      expect(await running).toBe(0);
    }
    expect(tokens[1]).toBe(tokens[0]);
    expect(tokens[2]).not.toBe(tokens[0]);
  });

  it("says so when the port is taken", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", () => resolve()));
    const port = (blocker.address() as { port: number }).port;
    const { err, io } = capture();
    const code = await main(
      ["--dir", tempRoot(), "--state", tempRoot(), "--port", String(port), "--host", "127.0.0.1"],
      io,
      environment,
    );
    blocker.close();
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(new RegExp(`port ${port} is in use`));
  });
});
