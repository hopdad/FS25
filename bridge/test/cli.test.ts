import { writeFileSync } from "node:fs";
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
    const running = main(["--dir", root, "--json"], io, environment);

    await vi.waitFor(() => expect(out).toHaveLength(1), { timeout: 3000 });
    writeFileSync(join(dir, "live_vehicle.json"), JSON.stringify(frame(null, 846)));
    await vi.waitFor(() => expect(out).toHaveLength(2), { timeout: 3000 });

    stop();
    expect(await running).toBe(0);
    expect(JSON.parse(out[1] ?? "").minute).toBe(846);
    expect(err.join("\n")).toMatch(/following save 6f1c2d3e/);
  });
});
