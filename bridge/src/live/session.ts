import { join } from "node:path";
import {
  AckRing,
  type CommandRequest,
  type CommandResponse,
  FILES,
  LiveFarm,
  LiveFleet,
  LiveVehicle,
  Meta,
} from "@farmlink/schema";
import { HeartbeatWriter } from "../commands/heartbeat";
import { type CommandNumbering, CommandWriter } from "../commands/writer";
import { LiveWatcher } from "../watch/live";
import { AlertEngine, type AlertRules } from "./alerts";
import type { LiveHub } from "./hub";

/** A file older than this when read was left behind by a game that is no longer running. */
export const FRESH_MS = 15_000;

export interface SaveSessionOptions {
  saveId: string;
  /** The save's folder under modSettings/FS25_FarmLink. */
  dir: string;
  hub: LiveHub;
  numbering: CommandNumbering;
  rules?: AlertRules;
  log?: (line: string) => void;
  now?: () => number;
  /** Multiplies every polling interval; tests use a small factor. */
  pollScale?: number;
  heartbeatMs?: number;
  commandTtlSec?: number;
  offlineAfterMs?: number;
}

interface Startable {
  start(): void;
  stop(): void;
}

/**
 * Everything the bridge does for one save: follows its live channels into the hub, raises alerts,
 * writes commands and the heartbeat, and settles commands from the acks.
 */
export class SaveSession {
  readonly saveId: string;
  readonly writer: CommandWriter;
  private readonly alerts: AlertEngine;
  private readonly heartbeat: HeartbeatWriter;
  private readonly acks: LiveWatcher<AckRing>;
  private readonly parts: Startable[];
  private ready: Promise<void> = Promise.resolve();
  private online = false;
  private readonly now: () => number;

  constructor(private readonly options: SaveSessionOptions) {
    this.saveId = options.saveId;
    this.now = options.now ?? Date.now;
    const { dir, hub } = options;
    const log = options.log ?? (() => {});
    const scale = options.pollScale ?? 1;
    const file = (name: string) => join(dir, name);
    const fresh = (mtimeMs: number) => this.now() - mtimeMs <= FRESH_MS;
    const invalid = (name: string) => (error: string) =>
      log(`dropped an invalid ${name} frame: ${error}`);

    this.alerts = new AlertEngine(options.rules);
    this.writer = new CommandWriter({
      saveDir: dir,
      numbering: options.numbering,
      ttlSec: options.commandTtlSec,
    });
    this.heartbeat = new HeartbeatWriter({
      saveDir: dir,
      intervalMs: options.heartbeatMs,
      onError: (error) => log(`could not write ${FILES.bridgeHeartbeat}: ${error.message}`),
      onRecover: () => log(`writing ${FILES.bridgeHeartbeat} again`),
    });
    this.acks = new LiveWatcher({
      file: file(FILES.acks),
      schema: AckRing,
      pollMs: 100 * scale,
      offlineAfterMs: Number.POSITIVE_INFINITY,
      onFrame: (ring) => this.writer.onAcks(ring),
      onInvalid: invalid(FILES.acks),
    });

    const vehicle = new LiveWatcher({
      file: file(FILES.liveVehicle),
      schema: LiveVehicle,
      pollMs: 100 * scale,
      offlineAfterMs: options.offlineAfterMs,
      now: this.now,
      onFrame: (frame, _text, info) => {
        hub.publish("vehicle", frame);
        if (fresh(info.mtimeMs)) this.setOnline(true);
      },
      onInvalid: invalid(FILES.liveVehicle),
      onOffline: () => {
        this.setOnline(false);
        hub.raise(this.alerts.onOffline(this.now()));
      },
    });
    const fleet = new LiveWatcher({
      file: file(FILES.liveFleet),
      schema: LiveFleet,
      pollMs: 250 * scale,
      offlineAfterMs: Number.POSITIVE_INFINITY,
      onFrame: (frame, _text, info) => {
        hub.publish("fleet", frame);
        if (fresh(info.mtimeMs)) hub.raise(this.alerts.onFleet(frame, this.now()));
      },
      onInvalid: invalid(FILES.liveFleet),
    });
    const farm = new LiveWatcher({
      file: file(FILES.liveFarm),
      schema: LiveFarm,
      pollMs: 1000 * scale,
      offlineAfterMs: Number.POSITIVE_INFINITY,
      onFrame: (frame) => hub.publish("farm", frame),
      onInvalid: invalid(FILES.liveFarm),
    });
    const meta = new LiveWatcher({
      file: file(FILES.meta),
      schema: Meta,
      pollMs: 1000 * scale,
      offlineAfterMs: Number.POSITIVE_INFINITY,
      onFrame: (m) =>
        hub.setStatus({
          saveName: m.saveName,
          mode: m.mode,
          modVersion: m.modVersion,
          gameVersion: m.gameVersion,
        }),
      onInvalid: invalid(FILES.meta),
    });
    this.parts = [meta, vehicle, fleet, farm, this.acks, this.heartbeat];
  }

  get isOnline(): boolean {
    return this.online;
  }

  start(): void {
    this.options.hub.setStatus({
      saveId: this.saveId,
      gameOnline: false,
      saveName: null,
      mode: null,
      modVersion: null,
      gameVersion: null,
    });
    // Read acks.json before the first command, so the numbering catches up with the mod's watermark.
    this.ready = this.acks.poll();
    for (const part of this.parts) part.start();
  }

  stop(): void {
    for (const part of this.parts) part.stop();
    this.writer.close();
    this.options.hub.reset();
  }

  /** Sends a command to the game, or rejects it at once while the game is not running. */
  async send(request: CommandRequest): Promise<CommandResponse> {
    if (!this.online) return { id: null, status: "rejected", message: "the game is offline" };
    await this.ready;
    return this.writer.send(request);
  }

  private setOnline(online: boolean): void {
    if (online) this.alerts.markOnline();
    if (online === this.online) return;
    this.online = online;
    this.options.hub.setStatus({ gameOnline: online });
  }
}
