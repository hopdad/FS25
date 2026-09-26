import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BridgeState, defaultStateDir } from "../src/state";
import { tempRoot } from "./fixtures";

describe("BridgeState", () => {
  it("creates bridge-state.json with a token and an epoch on first run", () => {
    const dir = join(tempRoot(), "nested", "FarmLink");
    const state = new BridgeState(dir);
    expect(state.created).toBe(true);
    expect(state.pairingToken).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(state.commandEpoch).toMatch(/^[0-9a-f-]{36}$/);
    const saved = JSON.parse(readFileSync(state.path, "utf8"));
    expect(saved).toEqual({
      v: 1,
      pairingToken: state.pairingToken,
      commandEpoch: state.commandEpoch,
      nextCommandId: 1,
    });
    if (process.platform !== "win32") expect(statSync(state.path).mode & 0o777).toBe(0o600);
  });

  it("keeps the token, the epoch and the command numbering across runs", () => {
    const dir = tempRoot();
    const first = new BridgeState(dir);
    expect([first.nextCommandId(), first.nextCommandId()]).toEqual([1, 2]);

    const second = new BridgeState(dir);
    expect(second.created).toBe(false);
    expect(second.pairingToken).toBe(first.pairingToken);
    expect(second.commandEpoch).toBe(first.commandEpoch);
    expect(second.nextCommandId()).toBe(3);
  });

  it("skips past an id the mod already processed, and never goes back", () => {
    const state = new BridgeState(tempRoot());
    expect(state.skipPast(41)).toBe(true);
    expect(state.nextCommandId()).toBe(42);
    expect(state.skipPast(10)).toBe(false);
    expect(state.nextCommandId()).toBe(43);
  });

  it("resets the pairing token but keeps the numbering", () => {
    const dir = tempRoot();
    const state = new BridgeState(dir);
    const old = state.pairingToken;
    state.nextCommandId();
    const fresh = state.resetPairingToken();
    expect(fresh).not.toBe(old);
    const reloaded = new BridgeState(dir);
    expect(reloaded.pairingToken).toBe(fresh);
    expect(reloaded.nextCommandId()).toBe(2);
  });

  it("starts over when the file is damaged", () => {
    const dir = tempRoot();
    writeFileSync(join(dir, "bridge-state.json"), "{ not json");
    const state = new BridgeState(dir);
    expect(state.created).toBe(true);
    expect(state.nextCommandId()).toBe(1);
  });
});

describe("defaultStateDir", () => {
  it("uses the per-user config folder of each platform", () => {
    expect(
      defaultStateDir({
        platform: "win32",
        home: "C:\\Users\\sam",
        env: { APPDATA: "C:\\Users\\sam\\AppData\\Roaming" },
      }),
    ).toBe(join("C:\\Users\\sam\\AppData\\Roaming", "FarmLink"));
    expect(defaultStateDir({ platform: "darwin", home: "/Users/sam", env: {} })).toBe(
      "/Users/sam/Library/Application Support/FarmLink",
    );
    expect(defaultStateDir({ platform: "linux", home: "/home/sam", env: {} })).toBe(
      "/home/sam/.config/farmlink",
    );
    expect(
      defaultStateDir({ platform: "linux", home: "/home/sam", env: { XDG_CONFIG_HOME: "/cfg" } }),
    ).toBe("/cfg/farmlink");
  });
});
