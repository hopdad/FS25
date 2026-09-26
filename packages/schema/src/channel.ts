import { z } from "zod";
import { FarmId, GameDay, JobId, RealTimestamp, Uuid, Version } from "./primitives";

// The command channel. The mod cannot read text files (PLAN_REVIEW.md F1), so the bridge writes
// commands to `commands.xml`; these schemas are the logical shape the bridge serializes and the
// shape the mod's acks come back in.

const CommandBase = z.object({
  v: Version,
  /** Monotonic, assigned and persisted by the bridge. */
  id: z.int().min(1),
  issuedAt: RealTimestamp,
  ttlSec: z.int().min(1).max(3600),
  farmId: FarmId,
});

export const PingCommand = CommandBase.extend({
  type: z.literal("ping"),
  args: z.object({}),
});

export const WorkerStopCommand = CommandBase.extend({
  type: z.literal("worker.stop"),
  args: z.object({ jobId: JobId }),
});

export const Command = z.discriminatedUnion("type", [PingCommand, WorkerStopCommand]);

export const AckStatus = z.enum(["ok", "rejected", "expired", "error"]);

/** Written by the mod once per command id, including failed and expired ones. */
export const Ack = z.object({
  v: Version,
  id: z.int().min(1),
  status: AckStatus,
  message: z.string().nullable(),
  at: RealTimestamp,
});

/** Bridge heartbeat, serialized to `bridge.xml` so the mod can read it (PLAN_REVIEW.md F1). */
export const BridgeHeartbeat = z.object({
  v: Version,
  bridgeVersion: z.string().min(1),
  /** Increments on every write; the mod checks it changed within 10 s of its own clock. */
  beat: z.int().min(0),
  realTs: RealTimestamp,
  features: z.array(z.enum(["xlsx", "commands"])),
});

/** `export_request.json`: the in-game Export Excel button asks the bridge for an xlsx. */
export const ExportRequest = z.object({
  v: Version,
  id: z.string().min(1),
  requestedAt: RealTimestamp,
  saveId: Uuid,
  saveName: z.string(),
  day: GameDay,
  format: z.literal("xlsx"),
});

export type Command = z.infer<typeof Command>;
export type Ack = z.infer<typeof Ack>;
