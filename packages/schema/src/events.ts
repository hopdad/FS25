import { z } from "zod";
import {
  FarmId,
  FillTypeName,
  GameDay,
  JobId,
  MinuteOfDay,
  RealTimestamp,
  Uuid,
  VehicleId,
  Version,
} from "./primitives";

/**
 * Money context. Sales, fuel and wages are derived from `money` events through this, so no
 * amount is ever recorded twice.
 */
export const MoneyContext = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("sale"),
    stationId: z.string().min(1),
    fillType: FillTypeName,
    liters: z.number().min(0),
  }),
  z.object({
    kind: z.literal("fuel"),
    vehicleId: VehicleId,
    fillType: FillTypeName,
    liters: z.number().min(0),
  }),
  z.object({
    kind: z.literal("wage"),
    jobId: JobId,
    vehicleId: VehicleId.nullable(),
  }),
  z.object({
    kind: z.literal("shop"),
    storeItem: z.string().min(1),
    vehicleId: VehicleId.nullable(),
  }),
  z.object({ kind: z.literal("none") }),
]);

export const MoneyData = z.object({
  /** Signed: income is positive, expenses negative. */
  amount: z.number(),
  /** `MoneyType` constant name, for example `AI` or `SOLD_PRODUCTS`. */
  moneyType: z.string().min(1),
  context: MoneyContext,
  /** Number of game transactions folded into this entry (PLAN_REVIEW.md F3). Absent means 1. */
  count: z.int().min(1).optional(),
});

export const HarvestData = z.object({
  /** Null when the position did not resolve to a field; `farmlandId` is still set if known. */
  fieldId: z.int().min(1).nullable(),
  farmlandId: z.int().min(1).nullable(),
  fillType: FillTypeName,
  liters: z.number().min(0),
  vehicleId: VehicleId,
  isAI: z.boolean(),
});

export const WorkType = z.enum(["seeding", "spraying", "fertilizing", "tillage", "other"]);

export const FieldWorkData = z.object({
  fieldId: z.int().min(1).nullable(),
  farmlandId: z.int().min(1).nullable(),
  workType: WorkType,
  areaHa: z.number().min(0),
  inputFillType: FillTypeName.nullable(),
  inputLiters: z.number().min(0).nullable(),
  vehicleId: VehicleId,
  isAI: z.boolean(),
});

export const VehicleAddedData = z.object({
  vehicleId: VehicleId,
  /** Store item XML filename. */
  storeItem: z.string().min(1),
  name: z.string(),
  price: z.number().min(0),
  leased: z.boolean(),
});

export const VehicleRemovedData = z.object({
  vehicleId: VehicleId,
  reason: z.enum(["sold", "deleted"]),
  operatingHours: z.number().min(0).nullable(),
});

export const VehicleHoursData = z.object({
  vehicleId: VehicleId,
  operatingHours: z.number().min(0),
});

export const WorkerStartData = z.object({
  jobId: JobId,
  vehicleId: VehicleId,
  /** AIJobTypeManager name, for example `FIELDWORK` or `DELIVER`. */
  jobType: z.string().min(1),
  fieldId: z.int().min(1).nullable(),
});

export const WorkerStopData = z.object({
  jobId: JobId,
  vehicleId: VehicleId,
  /** Name registered with `aiMessageManager`, for example `ERROR_OUT_OF_FUEL`; `UNKNOWN` if none. */
  reason: z.string().min(1),
  durationMin: z.number().min(0),
  /** Wages paid for this job, as a positive amount. */
  wagesTotal: z.number().min(0),
});

/** One event per game day with every station's prices (PLAN_REVIEW.md F3). */
export const PricesData = z.object({
  entries: z.array(
    z.object({
      stationId: z.string().min(1),
      fillType: FillTypeName,
      pricePer1000L: z.number().min(0),
    }),
  ),
});

export const DayRolloverData = z.object({
  balance: z.number(),
  loan: z.number().min(0),
  /** Finance statistic name to amount for the day that just ended. */
  financeByCategory: z.record(z.string(), z.number()),
  year: z.int().min(0),
  period: z.int().min(1).max(12),
  dayInPeriod: z.int().min(1),
  daysPerPeriod: z.int().min(1),
});

export const SessionData = z.object({
  modVersion: z.string().min(1),
  gameVersion: z.string().min(1),
  integrations: z.array(z.string()),
  /** Set on the first session of a branch created by reloading an older save (PLAN_REVIEW.md F2). */
  parentBranchId: Uuid.nullable().optional(),
  forkSeq: z.int().min(0).nullable().optional(),
});

/** Fields shared by every event line. `(saveId, branchId, seq)` is the natural key. */
export const EnvelopeBase = z.object({
  v: Version,
  saveId: Uuid,
  branchId: Uuid,
  seq: z.int().min(1),
  day: GameDay,
  minute: MinuteOfDay,
  realTs: RealTimestamp,
  farmId: FarmId,
  /** FS `uniqueUserId` of the player who caused the event; null for AI and system events. */
  userId: z.string().min(1).nullable(),
});

const event = <T extends string, D extends z.ZodType>(type: T, data: D) =>
  EnvelopeBase.extend({ type: z.literal(type), data });

export const MoneyEvent = event("money", MoneyData);
export const HarvestEvent = event("harvest", HarvestData);
export const FieldWorkEvent = event("field_work", FieldWorkData);
export const VehicleAddedEvent = event("vehicle_added", VehicleAddedData);
export const VehicleRemovedEvent = event("vehicle_removed", VehicleRemovedData);
export const VehicleHoursEvent = event("vehicle_hours", VehicleHoursData);
export const WorkerStartEvent = event("worker_start", WorkerStartData);
export const WorkerStopEvent = event("worker_stop", WorkerStopData);
export const PricesEvent = event("prices", PricesData);
export const DayRolloverEvent = event("day_rollover", DayRolloverData);
export const SessionEvent = event("session", SessionData);

/** One line of `events/<day>.ndjson`. */
export const EventEnvelope = z.discriminatedUnion("type", [
  MoneyEvent,
  HarvestEvent,
  FieldWorkEvent,
  VehicleAddedEvent,
  VehicleRemovedEvent,
  VehicleHoursEvent,
  WorkerStartEvent,
  WorkerStopEvent,
  PricesEvent,
  DayRolloverEvent,
  SessionEvent,
]);

export type EventEnvelope = z.infer<typeof EventEnvelope>;
export type EventType = EventEnvelope["type"];
export type MoneyContext = z.infer<typeof MoneyContext>;
