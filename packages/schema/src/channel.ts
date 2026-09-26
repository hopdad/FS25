import { z } from "zod";
import { FarmId, GameDay, JobId, RealTimestamp, Uuid, Version } from "./primitives";

// The command channel. The mod cannot read text files (PLAN_REVIEW.md F1), so the bridge writes
// commands to `commands.xml` (see xml.ts for the wire format) and the mod answers in `acks.json`.

const CommandBase = z.object({
  v: Version,
  /** Monotonic within an epoch, assigned and persisted by the bridge. */
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

export const COMMAND_TYPES = ["ping", "worker.stop"] as const;

/**
 * The content of `commands.xml`. `epoch` identifies the bridge installation that numbered the
 * commands: when it changes (a reinstalled bridge starts again at 1), the mod resets its watermark
 * instead of ignoring every new id.
 */
export const CommandsFile = z.object({
  v: Version,
  epoch: Uuid,
  commands: z.array(Command),
});

export const AckStatus = z.enum(["ok", "rejected", "expired", "error"]);

/** The mod's answer to one command id, including failed and expired ones. */
export const Ack = z.object({
  v: Version,
  id: z.int().min(1),
  status: AckStatus,
  message: z.string().nullable(),
  at: RealTimestamp,
});

/**
 * `acks.json`: the most recent acks, rewritten in full after each command. A ring instead of an
 * appended `acks.ndjson`, because the sandbox's write-only `io.open` may not append (F1).
 */
export const AckRing = z.object({
  v: Version,
  /** The epoch of the commands these acks answer; null before the mod has seen any. */
  epoch: Uuid.nullable(),
  /** Highest command id the mod has processed in that epoch. */
  watermark: z.int().min(0),
  acks: z.array(Ack),
});

export const BRIDGE_FEATURES = ["commands", "xlsx"] as const;

/** Bridge heartbeat, serialized to `bridge.xml` so the mod can read it (PLAN_REVIEW.md F1). */
export const BridgeHeartbeat = z.object({
  v: Version,
  bridgeVersion: z.string().min(1),
  /** Increments on every write; the mod checks it changed within 10 s of its own clock. */
  beat: z.int().min(0),
  realTs: RealTimestamp,
  features: z.array(z.enum(BRIDGE_FEATURES)),
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
export type CommandType = Command["type"];
export type CommandsFile = z.infer<typeof CommandsFile>;
export type Ack = z.infer<typeof Ack>;
export type AckRing = z.infer<typeof AckRing>;
export type BridgeHeartbeat = z.infer<typeof BridgeHeartbeat>;
