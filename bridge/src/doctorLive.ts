// The P1 half of --doctor: the fleet and farm channels, the command channel in both directions,
// the heartbeat, and whether a bridge is serving the phone. Everything here is read-only; the
// pairing token never appears in the report, because people send the report around.

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  AckRing,
  FILES,
  LIVE_PORT,
  LiveFarm,
  LiveFleet,
  parseBridgeXml,
  parseCommandsXml,
} from "@farmlink/schema";
import type { Check } from "./doctor";
import { readBridgeState } from "./state";
import { readJsonFile } from "./watch/files";

/** The fleet channel is written every 5 s, the farm channel every 60 s. */
const FLEET_FRESH_SEC = 15;
const FARM_FRESH_SEC = 75;
/** The bridge writes bridge.xml every 5 s. */
const HEARTBEAT_FRESH_SEC = 15;

export interface LiveReport {
  fleet: {
    state: string;
    ageSec: number | null;
    jobs: number;
    stops: Array<{ stopId: number; helper: string | null; reason: string; realTs: string }>;
  };
  farm: { state: string; ageSec: number | null; farms: number };
  commands: { state: string; ageSec: number | null; epoch: string | null; lastId: number | null };
  acks: {
    state: string;
    ageSec: number | null;
    epoch: string | null;
    watermark: number | null;
    last: { id: number; status: string; message: string | null } | null;
  };
  heartbeat: { state: string; ageSec: number | null; beat: number | null; version: string | null };
  bridgeState: { path: string; commandEpoch: string | null; nextCommandId: number | null };
  server: { url: string; state: string; bridgeVersion: string | null };
}

async function age(path: string, now: number): Promise<number | null> {
  try {
    return Math.round((now - (await stat(path)).mtimeMs) / 100) / 10;
  } catch {
    return null;
  }
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function probeServer(port: number): Promise<LiveReport["server"]> {
  const url = `http://127.0.0.1:${port}/healthz`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(800) });
    const body = (await response.json()) as { bridgeVersion?: string };
    return { url, state: "running", bridgeVersion: body.bridgeVersion ?? null };
  } catch {
    return { url, state: "not running", bridgeVersion: null };
  }
}

export interface LiveOptions {
  /** The active save's folder, or undefined before the game has written one. */
  saveDir: string | undefined;
  stateDir: string;
  /** Port to look for a running bridge on; null skips the check. */
  serverPort: number | null;
  now: number;
}

export async function collectLive(options: LiveOptions): Promise<LiveReport> {
  const { saveDir, now } = options;
  const file = (name: string) => (saveDir ? join(saveDir, name) : undefined);
  const missing = "missing";

  const report: LiveReport = {
    fleet: { state: missing, ageSec: null, jobs: 0, stops: [] },
    farm: { state: missing, ageSec: null, farms: 0 },
    commands: { state: missing, ageSec: null, epoch: null, lastId: null },
    acks: { state: missing, ageSec: null, epoch: null, watermark: null, last: null },
    heartbeat: { state: missing, ageSec: null, beat: null, version: null },
    bridgeState: {
      path: join(options.stateDir, "bridge-state.json"),
      commandEpoch: null,
      nextCommandId: null,
    },
    server:
      options.serverPort === null
        ? { url: "", state: "not checked", bridgeVersion: null }
        : await probeServer(options.serverPort),
  };

  const state = readBridgeState(options.stateDir);
  if (state) {
    report.bridgeState.commandEpoch = state.commandEpoch;
    report.bridgeState.nextCommandId = state.nextCommandId;
  }

  const fleetPath = file(FILES.liveFleet);
  if (fleetPath) {
    const fleet = await readJsonFile(fleetPath, LiveFleet);
    report.fleet.ageSec = await age(fleetPath, now);
    if (fleet.ok) {
      report.fleet.state = "ok";
      report.fleet.jobs = fleet.value.fleet.jobs.length;
      report.fleet.stops = fleet.value.fleet.stops.map((s) => ({
        stopId: s.stopId,
        helper: s.helper,
        reason: s.reason,
        realTs: s.realTs,
      }));
    } else if (fleet.reason !== "missing") {
      report.fleet.state = fleet.error;
    }
  }

  const farmPath = file(FILES.liveFarm);
  if (farmPath) {
    const farm = await readJsonFile(farmPath, LiveFarm);
    report.farm.ageSec = await age(farmPath, now);
    if (farm.ok) {
      report.farm.state = "ok";
      report.farm.farms = farm.value.farm.farms.length;
    } else if (farm.reason !== "missing") {
      report.farm.state = farm.error;
    }
  }

  const commandsPath = file(FILES.commands);
  const commandsText = commandsPath ? await readText(commandsPath) : undefined;
  if (commandsPath && commandsText !== undefined) {
    report.commands.ageSec = await age(commandsPath, now);
    try {
      const commands = parseCommandsXml(commandsText);
      report.commands.state = "ok";
      report.commands.epoch = commands.epoch;
      report.commands.lastId = commands.commands.at(-1)?.id ?? null;
    } catch (error) {
      report.commands.state = (error as Error).message;
    }
  }

  const acksPath = file(FILES.acks);
  if (acksPath) {
    const acks = await readJsonFile(acksPath, AckRing);
    report.acks.ageSec = await age(acksPath, now);
    if (acks.ok) {
      const last = acks.value.acks.at(-1);
      report.acks.state = "ok";
      report.acks.epoch = acks.value.epoch;
      report.acks.watermark = acks.value.watermark;
      report.acks.last = last ? { id: last.id, status: last.status, message: last.message } : null;
    } else if (acks.reason !== "missing") {
      report.acks.state = acks.error;
    }
  }

  const heartbeatPath = file(FILES.bridgeHeartbeat);
  const heartbeatText = heartbeatPath ? await readText(heartbeatPath) : undefined;
  if (heartbeatPath && heartbeatText !== undefined) {
    report.heartbeat.ageSec = await age(heartbeatPath, now);
    try {
      const heartbeat = parseBridgeXml(heartbeatText);
      report.heartbeat.state = "ok";
      report.heartbeat.beat = heartbeat.beat;
      report.heartbeat.version = heartbeat.bridgeVersion;
    } catch (error) {
      report.heartbeat.state = (error as Error).message;
    }
  }
  return report;
}

const fresh = (ageSec: number | null, limit: number) => ageSec !== null && ageSec <= limit;

function channelCheck(
  id: string,
  title: string,
  channel: { state: string; ageSec: number | null },
  limit: number,
  summary: string,
): Check {
  if (channel.state === "missing") {
    return { id, title, status: "pending", detail: "not written yet: load a save with the P1 mod" };
  }
  if (channel.state !== "ok") return { id, title, status: "fail", detail: channel.state };
  return {
    id,
    title,
    status: fresh(channel.ageSec, limit) ? "pass" : "pending",
    detail: fresh(channel.ageSec, limit)
      ? `${summary}, ${channel.ageSec} s old`
      : `valid but ${channel.ageSec} s old: run --doctor while the game is running`,
  };
}

/** The P1 checks: channels, the command round trip, the heartbeat and the phone server. */
export function liveChecks(live: LiveReport): Check[] {
  return liveChecksWithoutPhase(live).map((check) => ({ ...check, phase: "P1" as const }));
}

function liveChecksWithoutPhase(live: LiveReport): Check[] {
  const stops = live.fleet.stops.map((s) => s.reason);
  const checks: Check[] = [
    channelCheck(
      "fleet",
      "live_fleet.json: machines, workers and stops",
      live.fleet,
      FLEET_FRESH_SEC,
      `${live.fleet.jobs} workers running; stops: ${stops.length > 0 ? stops.join(", ") : "none"}`,
    ),
    channelCheck(
      "farm",
      "live_farm.json: money, silos and weather",
      live.farm,
      FARM_FRESH_SEC,
      `${live.farm.farms} farm(s)`,
    ),
  ];

  const title = "Commands reach the mod and come back";
  const { commands, acks, bridgeState } = live;
  if (commands.state === "missing") {
    checks.push({
      id: "commands",
      title,
      status: "pending",
      detail: "no command sent yet: stop a worker from the phone",
    });
  } else if (commands.state !== "ok") {
    checks.push({
      id: "commands",
      title,
      status: "fail",
      detail: `commands.xml: ${commands.state}`,
    });
  } else if (acks.state !== "ok" && acks.state !== "missing") {
    checks.push({ id: "commands", title, status: "fail", detail: `acks.json: ${acks.state}` });
  } else if (acks.epoch !== commands.epoch || (acks.watermark ?? 0) < (commands.lastId ?? 0)) {
    checks.push({
      id: "commands",
      title,
      status: "fail",
      detail: `commands.xml holds up to id ${commands.lastId} (epoch ${commands.epoch}), but the mod answered up to ${acks.watermark ?? "none"} (epoch ${acks.epoch ?? "none"}): is the game running with the P1 mod?`,
    });
  } else {
    const last = acks.last;
    checks.push({
      id: "commands",
      title,
      status: "pass",
      detail: `the mod answered up to id ${acks.watermark}${last ? `; last: ${last.id} ${last.status}${last.message ? ` (${last.message})` : ""}` : ""}${bridgeState.commandEpoch && bridgeState.commandEpoch !== commands.epoch ? "; written by another bridge installation" : ""}`,
    });
  }

  const heartbeat = live.heartbeat;
  checks.push({
    id: "heartbeat",
    title: "bridge.xml heartbeat",
    status:
      heartbeat.state === "ok" && fresh(heartbeat.ageSec, HEARTBEAT_FRESH_SEC) ? "pass" : "pending",
    detail:
      heartbeat.state === "ok"
        ? `beat ${heartbeat.beat} from bridge ${heartbeat.version}, ${heartbeat.ageSec} s old`
        : `${heartbeat.state}: start the bridge without --doctor to write it`,
  });

  checks.push({
    id: "server",
    title: "Phone page served on this computer",
    status: live.server.state === "running" ? "pass" : "pending",
    detail:
      live.server.state === "running"
        ? `bridge ${live.server.bridgeVersion} answers on ${live.server.url.replace("/healthz", "")}`
        : `no bridge answers on ${live.server.url.replace("/healthz", "") || `port ${LIVE_PORT}`}: start farmlink-bridge in another window`,
  });
  return checks;
}
