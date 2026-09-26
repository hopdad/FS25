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

export const Controller = z.enum(["player", "ai", "courseplay", "autodrive", "idle"]);

export const FleetVehicle = z.object({
  vehicleId: VehicleId,
  name: z.string(),
  farmId: FarmId,
  position: Position,
  fuelPct: Percent.nullable(),
  damagePct: Percent.nullable(),
  controller: Controller,
});

export const ActiveJob = z.object({
  jobId: JobId,
  vehicleId: VehicleId,
  jobType: z.string().min(1),
  fieldId: z.int().min(1).nullable(),
  progressPct: Percent.nullable(),
  tankFillPct: Percent.nullable(),
});

/** `live_fleet.json`, written every 5 s. Provisional until P1. */
export const LiveFleet = LiveHeader.extend({
  fleet: z.object({
    vehicles: z.array(FleetVehicle),
    jobs: z.array(ActiveJob),
  }),
});

const Stock = z.object({ fillType: FillTypeName, liters: z.number().min(0) });

/** `live_farm.json`, written every 60 s. Provisional until P1. */
export const LiveFarm = LiveHeader.extend({
  farm: z.object({
    farmId: FarmId,
    balance: z.number(),
    loan: z.number().min(0),
    storage: z.array(Stock),
    productions: z.array(
      z.object({
        id: z.string().min(1),
        name: z.string(),
        stocks: z.array(Stock),
      }),
    ),
    weather: z.object({
      current: z.object({ type: z.string(), temperatureC: z.number() }),
      forecast: z.array(
        z.object({
          day: GameDay,
          type: z.string(),
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
