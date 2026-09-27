import { z } from "zod";
import { RealTimestamp, Uuid, Version } from "./primitives";

/** How the game instance that wrote the files is running. */
export const RuntimeMode = z.enum(["singleplayer", "host", "dedicated"]);

/** The event log's counters (P2). */
export const EventLogStats = z.object({
  /** `append` to the day's file, or `handle`: kept-open files, where append mode is refused (F1). */
  mode: z.enum(["append", "handle"]),
  emitted: z.int().min(0),
  written: z.int().min(0),
  /** Lines waiting for the next write. */
  pending: z.int().min(0),
  flushes: z.int().min(0),
  writeErrors: z.int().min(0),
  /** Failed writes of heads.xml, which guards against reusing seqs after a crash (F2). */
  claimErrors: z.int().min(0),
  /** Lines given up after writes kept failing; they show as a seq gap. */
  dropped: z.int().min(0),
});

/** Write-cost and fault counters, for P0's frame-time criterion and for `--doctor`. */
export const MetaStats = z.object({
  liveWrites: z.int().min(0),
  liveWriteAvgMs: z.number().min(0),
  liveWriteMaxMs: z.number().min(0),
  moduleErrors: z.record(z.string(), z.int().min(0)),
  disabledModules: z.array(z.string()),
  events: EventLogStats.optional(),
});

/** `meta.json`: written on load, then every 60 s. */
export const Meta = z.object({
  v: Version,
  modVersion: z.string().min(1),
  gameVersion: z.string().min(1),
  saveId: Uuid,
  branchId: Uuid,
  schemaVersion: z.int().min(1),
  lastSeq: z.int().min(0),
  /** Highest seq claimed per branch, written before events are appended (PLAN_REVIEW.md F2). */
  heads: z.record(Uuid, z.int().min(0)),
  heartbeat: RealTimestamp,
  /** Increments on every write, so readers can check liveness without comparing clocks. */
  beat: z.int().min(0),
  mode: RuntimeMode,
  saveName: z.string().nullable(),
  savegameIndex: z.int().min(0).nullable(),
  stats: MetaStats.optional(),
});

export type Meta = z.infer<typeof Meta>;
export type EventLogStats = z.infer<typeof EventLogStats>;
