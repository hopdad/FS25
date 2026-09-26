import { z } from "zod";
import {
  FarmId,
  FillLevel,
  FillTypeName,
  GameDay,
  JobId,
  MinuteOfDay,
  Percent,
  Position,
  RealTimestamp,
  Uuid,
  VehicleId,
  Version,
} from "./primitives";

/**
 * Header shared by the live channels. They carry no seq: each write replaces the file. The payload
 * sits under the channel's name (PLAN_REVIEW.md C6).
 */
export const LiveHeader = z.object({
  v: Version,
  saveId: Uuid,
  /** New every time a mission starts, so readers can tell a restarted game from a paused one. */
  sessionId: Uuid,
  realTs: RealTimestamp,
  day: GameDay,
  minute: MinuteOfDay,
});

export const ImplementState = z.object({
  vehicleId: VehicleId.nullable(),
  name: z.string(),
  fillUnits: z.array(FillLevel),
});

export const VehicleState = z.object({
  vehicleId: VehicleId.nullable(),
  name: z.string(),
  speedKmh: z.number().min(0),
  rpm: z.number().min(0).nullable(),
  /** Gear as the dashboard shows it, for example `3`, `B2` or `N`. */
  gear: z.string().nullable(),
  fuelType: FillTypeName.nullable(),
  fuelPct: Percent.nullable(),
  damagePct: Percent.nullable(),
  operatingHours: z.number().min(0).nullable(),
  position: Position,
  isAI: z.boolean(),
  /** The vehicle's own fill units other than fuel, for example a combine's grain tank. */
  fillUnits: z.array(FillLevel),
  implements: z.array(ImplementState),
});

/** `live_vehicle.json`, written every 1 s. `vehicle` is null while the player is on foot. */
export const LiveVehicle = LiveHeader.extend({
  vehicle: VehicleState.nullable(),
});

/**
 * Who is driving. Courseplay and AutoDrive are detected read-only from their own state (locked
 * decision: FarmLink never drives).
 */
export const Controller = z.enum(["player", "ai", "courseplay", "autodrive", "idle"]);

export const FleetVehicle = z.object({
  vehicleId: VehicleId,
  name: z.string(),
  farmId: FarmId,
  position: Position,
  fuelPct: Percent.nullable(),
  damagePct: Percent.nullable(),
  controller: Controller,
  /** The vehicle this one is attached to, for implements and trailers. */
  attachedTo: VehicleId.nullable(),
});

export const ActiveJob = z.object({
  jobId: JobId,
  vehicleId: VehicleId,
  farmId: FarmId,
  /** AIJobTypeManager name, for example `FIELDWORK`. */
  jobType: z.string().min(1),
  helper: z.string().nullable(),
  fieldId: z.int().min(1).nullable(),
  progressPct: Percent.nullable(),
  /** Fill of the rig's main tank (a combine's grain tank, a trailer), which drives the ETA alert. */
  tankFillPct: Percent.nullable(),
  startedAt: RealTimestamp,
});

/** A worker that stopped, kept in a short ring so the bridge can alert on it exactly once. */
export const WorkerStopEntry = z.object({
  /** Increases within a session; (sessionId, stopId) identifies the stop. */
  stopId: z.int().min(1),
  jobId: JobId,
  vehicleId: VehicleId.nullable(),
  farmId: FarmId,
  jobType: z.string().min(1),
  helper: z.string().nullable(),
  /** Name registered with `aiMessageManager`, for example `ERROR_OUT_OF_FUEL`; `UNKNOWN` if none. */
  reason: z.string().min(1),
  durationMin: z.number().min(0).nullable(),
  realTs: RealTimestamp,
  day: GameDay,
  minute: MinuteOfDay,
});

/**
 * `live_fleet.json`, written every 5 s and at once when a worker starts or stops. In P1 the stop
 * ring is how stops reach the bridge; from P2 they are also `worker_stop` events.
 */
export const LiveFleet = LiveHeader.extend({
  fleet: z.object({
    vehicles: z.array(FleetVehicle),
    jobs: z.array(ActiveJob),
    stops: z.array(WorkerStopEntry),
  }),
});

export const Stock = z.object({ fillType: FillTypeName, liters: z.number().min(0) });

export const FarmState = z.object({
  farmId: FarmId,
  name: z.string(),
  balance: z.number(),
  loan: z.number().min(0),
  /** Silo contents summed by fill type. */
  storage: z.array(Stock),
  productions: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string(),
      stocks: z.array(Stock),
    }),
  ),
});

export const WeatherType = z.enum([
  "SUN",
  "PARTIALLY_CLOUDY",
  "CLOUDY",
  "RAIN",
  "SNOW",
  "HAIL",
  "TWISTER",
  "THUNDER",
  "UNKNOWN",
]);

/** `live_farm.json`, written every 60 s: every farm in the save, and the world's weather. */
export const LiveFarm = LiveHeader.extend({
  farm: z.object({
    farms: z.array(FarmState),
    weather: z.object({
      current: z.object({ type: WeatherType, temperatureC: z.number() }).nullable(),
      forecast: z.array(
        z.object({
          day: GameDay,
          type: WeatherType,
          minC: z.number(),
          maxC: z.number(),
        }),
      ),
    }),
  }),
});

export type LiveVehicle = z.infer<typeof LiveVehicle>;
export type LiveFleet = z.infer<typeof LiveFleet>;
export type LiveFarm = z.infer<typeof LiveFarm>;
export type WorkerStopEntry = z.infer<typeof WorkerStopEntry>;
export type ActiveJob = z.infer<typeof ActiveJob>;
export type FleetVehicle = z.infer<typeof FleetVehicle>;
