import { z } from "zod";
import { AckStatus } from "./channel";
import { LiveFarm, LiveFleet, LiveVehicle } from "./live";
import { RuntimeMode } from "./meta";
import { FarmId, JobId, Uuid, VehicleId } from "./primitives";

// The bridge's LAN interface: WebSocket messages pushed to the phone page, and the HTTP command
// request the page posts. Both ends import these, the page as types only.

export const LIVE_PORT = 8790;

export const BridgeStatus = z.object({
  bridgeVersion: z.string(),
  /** False once no live frame has arrived for 15 s. */
  gameOnline: z.boolean(),
  saveId: Uuid.nullable(),
  saveName: z.string().nullable(),
  mode: RuntimeMode.nullable(),
  modVersion: z.string().nullable(),
  gameVersion: z.string().nullable(),
});

export const AlertKind = z.enum(["worker_stop", "fuel_low", "tank_full_soon", "game_offline"]);
export const AlertSeverity = z.enum(["info", "warning", "critical"]);

export const Alert = z.object({
  /** Stable per occurrence, so a reconnecting page does not show an alert twice. */
  id: z.string().min(1),
  kind: AlertKind,
  severity: AlertSeverity,
  title: z.string(),
  message: z.string(),
  vehicleId: VehicleId.nullable(),
  jobId: JobId.nullable(),
  /** The farm it concerns, so a page can show only its own farm's alerts; null for game-wide ones. */
  farmId: FarmId.nullable(),
  /** When the bridge raised it, UTC. */
  at: z.iso.datetime(),
});

const ChannelMessage = z.discriminatedUnion("channel", [
  z.object({ type: z.literal("channel"), channel: z.literal("vehicle"), data: LiveVehicle }),
  z.object({ type: z.literal("channel"), channel: z.literal("fleet"), data: LiveFleet }),
  z.object({ type: z.literal("channel"), channel: z.literal("farm"), data: LiveFarm }),
]);

/** Everything the bridge pushes over the WebSocket. Channel frames are sent whole. */
export const ServerMessage = z.union([
  z.object({ type: z.literal("hello"), bridgeVersion: z.string() }),
  z.object({ type: z.literal("status"), status: BridgeStatus }),
  ChannelMessage,
  z.object({ type: z.literal("alert"), alert: Alert }),
  z.object({ type: z.literal("alerts"), alerts: z.array(Alert) }),
]);

/** Body of `POST /api/commands`. The bridge assigns the id and the timestamps. */
export const CommandRequest = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ping"), farmId: FarmId, args: z.object({}).default({}) }),
  z.object({ type: z.literal("worker.stop"), farmId: FarmId, args: z.object({ jobId: JobId }) }),
]);

/**
 * The answer to a command request: the mod's ack, or `expired` from the bridge when no ack came
 * back within the command's TTL. The page never assumes success.
 */
export const CommandResponse = z.object({
  id: z.int().min(1).nullable(),
  status: AckStatus,
  message: z.string().nullable(),
});

export type BridgeStatus = z.infer<typeof BridgeStatus>;
export type Alert = z.infer<typeof Alert>;
export type AlertKind = z.infer<typeof AlertKind>;
export type AlertSeverity = z.infer<typeof AlertSeverity>;
export type ServerMessage = z.infer<typeof ServerMessage>;
export type CommandRequest = z.input<typeof CommandRequest>;
export type CommandResponse = z.infer<typeof CommandResponse>;
