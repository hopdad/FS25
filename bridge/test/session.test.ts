import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Alert, parseBridgeXml, parseCommandsXml, type ServerMessage } from "@farmlink/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandNumbering } from "../src/commands/writer";
import { LiveHub } from "../src/live/hub";
import { SaveSession } from "../src/live/session";
import { localIsoWithOffset } from "../src/time";
import {
  farmFrame,
  fleetFrame,
  frame,
  meta,
  SAVE_ID,
  stopEntry,
  TS,
  tempRoot,
  tractor,
  writeSave,
} from "./fixtures";

const EPOCH = "3b7e1c2a-9d4f-4a6b-8c1e-2f3a4b5c6d7e";

function numbering(): CommandNumbering {
  let next = 1;
  return {
    commandEpoch: EPOCH,
    nextCommandId: () => next++,
    skipPast: (id) => {
      if (id < next) return false;
      next = id + 1;
      return true;
    },
  };
}

let session: SaveSession | undefined;

afterEach(() => {
  session?.stop();
  session = undefined;
});

function open(dir: string, options: { offlineAfterMs?: number } = {}) {
  const alerts: Alert[] = [];
  const hub = new LiveHub((alert) => alerts.push(alert));
  const messages: ServerMessage[] = [];
  hub.attach({ send: (text) => messages.push(JSON.parse(text)) });
  session = new SaveSession({
    saveId: SAVE_ID,
    dir,
    hub,
    numbering: numbering(),
    pollScale: 0.1,
    heartbeatMs: 50,
    offlineAfterMs: options.offlineAfterMs,
  });
  session.start();
  const channels = () => messages.flatMap((m) => (m.type === "channel" ? [m.channel] : [])).sort();
  return { hub, alerts, messages, channels, session };
}

describe("SaveSession", () => {
  it("relays every channel and fills in the status from meta.json", async () => {
    const dir = writeSave(tempRoot(), SAVE_ID, {
      "meta.json": meta(),
      "live_vehicle.json": frame(tractor),
      "live_fleet.json": fleetFrame(),
      "live_farm.json": farmFrame(),
    });
    const { hub, channels } = open(dir);
    await vi.waitFor(() =>
      expect(new Set(channels())).toEqual(new Set(["farm", "fleet", "vehicle"])),
    );
    await vi.waitFor(() =>
      expect(hub.currentStatus).toMatchObject({
        saveId: SAVE_ID,
        saveName: "Riverbend Springs",
        mode: "singleplayer",
        modVersion: "0.1.0.0",
        gameOnline: true,
      }),
    );
  });

  it("shows a stale save's last frames but treats the game as offline", async () => {
    const dir = writeSave(tempRoot(), SAVE_ID, {
      "live_vehicle.json": frame(tractor),
      "live_fleet.json": fleetFrame({
        stops: [stopEntry(1, "ERROR_OUT_OF_FUEL", localIsoWithOffset())],
      }),
    });
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(dir, "live_vehicle.json"), past, past);
    utimesSync(join(dir, "live_fleet.json"), past, past);

    const { hub, channels, alerts, session } = open(dir);
    await vi.waitFor(() => expect(channels()).toEqual(["fleet", "vehicle"]));
    expect(hub.currentStatus.gameOnline).toBe(false);
    expect(alerts).toEqual([]);
    expect(await session.send({ type: "ping", farmId: 1 })).toEqual({
      id: null,
      status: "rejected",
      message: "the game is offline",
    });
  });

  it("delivers a command and settles it from the mod's ack", async () => {
    const dir = writeSave(tempRoot(), SAVE_ID, { "live_vehicle.json": frame(tractor) });
    const { session } = open(dir);
    await vi.waitFor(() => expect(session.isOnline).toBe(true));

    const answer = session.send({ type: "worker.stop", farmId: 1, args: { jobId: "9" } });
    const commandsPath = join(dir, "commands.xml");
    await vi.waitFor(() => expect(existsSync(commandsPath)).toBe(true));
    const [command] = parseCommandsXml(readFileSync(commandsPath, "utf8")).commands;
    expect(command).toMatchObject({ id: 1, type: "worker.stop", args: { jobId: "9" } });

    // What the mod writes after running it.
    writeFileSync(
      join(dir, "acks.json"),
      JSON.stringify({
        v: 1,
        epoch: EPOCH,
        watermark: 1,
        acks: [{ v: 1, id: 1, status: "ok", message: null, at: TS }],
      }),
    );
    expect(await answer).toEqual({ id: 1, status: "ok", message: null });
  });

  it("keeps bridge.xml beating so the mod knows the bridge is there", async () => {
    const dir = writeSave(tempRoot(), SAVE_ID);
    open(dir);
    const path = join(dir, "bridge.xml");
    await vi.waitFor(() => expect(existsSync(path)).toBe(true));
    const first = parseBridgeXml(readFileSync(path, "utf8")).beat;
    await vi.waitFor(() =>
      expect(parseBridgeXml(readFileSync(path, "utf8")).beat).toBeGreaterThan(first),
    );
    expect(parseBridgeXml(readFileSync(path, "utf8")).features).toEqual(["commands"]);
  });

  it("raises an alert for a fresh worker stop", async () => {
    const dir = writeSave(tempRoot(), SAVE_ID, {
      "live_fleet.json": fleetFrame({
        stops: [stopEntry(1, "ERROR_OUT_OF_FUEL", localIsoWithOffset())],
      }),
    });
    const { alerts, messages } = open(dir);
    await vi.waitFor(() => expect(alerts.map((a) => a.kind)).toEqual(["worker_stop"]));
    expect(messages.some((m) => m.type === "alert")).toBe(true);
  });

  it("marks the game offline, with an alert, when the frames stop", async () => {
    const dir = writeSave(tempRoot(), SAVE_ID, { "live_vehicle.json": frame(tractor) });
    const { hub, alerts } = open(dir, { offlineAfterMs: 300 });
    await vi.waitFor(() => expect(hub.currentStatus.gameOnline).toBe(true));
    await vi.waitFor(() => expect(hub.currentStatus.gameOnline).toBe(false), { timeout: 2000 });
    expect(alerts.map((a) => a.kind)).toEqual(["game_offline"]);

    writeFileSync(join(dir, "live_vehicle.json"), JSON.stringify(frame(null, 846)));
    await vi.waitFor(() => expect(hub.currentStatus.gameOnline).toBe(true));
  });

  it("answers pending commands and forgets frames when it stops", async () => {
    const dir = writeSave(tempRoot(), SAVE_ID, { "live_vehicle.json": frame(tractor) });
    const { session, hub } = open(dir);
    await vi.waitFor(() => expect(session.isOnline).toBe(true));
    const answer = session.send({ type: "ping", farmId: 1 });
    await vi.waitFor(() => expect(existsSync(join(dir, "commands.xml"))).toBe(true));
    session.stop();
    expect(await answer).toEqual({
      id: 1,
      status: "error",
      message: "the bridge stopped following this save",
    });
    expect(await session.send({ type: "ping", farmId: 1 })).toMatchObject({ status: "rejected" });
    const late: ServerMessage[] = [];
    hub.attach({ send: (text) => late.push(JSON.parse(text)) });
    expect(late.map((m) => m.type)).toEqual(["hello", "status", "alerts"]);
  });
});
