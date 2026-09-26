import type { Alert, AlertSeverity, FleetVehicle, LiveFleet } from "@farmlink/schema";
import { parseGameTimestamp } from "../time";

/** The reason the game records when the player stops a worker; every other stop raises an alert. */
export const USER_STOPPED = "SUCCESS_STOPPED_BY_USER";

// Names registered in FS25's AIMessageManager (VERIFY_FIRST.md, 6), in words for the phone.
const REASONS: Record<string, string> = {
  ERROR_BLOCKED_BY_OBJECT: "blocked by an object",
  ERROR_COULD_NOT_PREPARE: "could not prepare the job",
  ERROR_FIELD_NOT_OWNED: "the field is not owned",
  ERROR_FIELD_NOT_READY: "the field is not ready",
  ERROR_GRAINTANK_IS_FULL: "grain tank full",
  ERROR_IMPLEMENT_WRONG_WAY: "implement facing the wrong way",
  ERROR_LOADING_STATION_DELETED: "loading station removed",
  ERROR_NO_FIELD_FOUND: "no field found",
  ERROR_NO_PALLETS_LOADED: "no pallets loaded",
  ERROR_NO_VALID_FILLTYPE_LOADED: "nothing usable loaded",
  ERROR_NO_VINE_FOUND: "no vines found",
  ERROR_NOT_REACHABLE: "target not reachable",
  ERROR_OUT_OF_FILL: "ran out of seed, fertilizer or other material",
  ERROR_OUT_OF_FUEL: "out of fuel",
  ERROR_OUT_OF_MONEY: "the farm is out of money",
  ERROR_PALLETS_FULL: "pallets full",
  ERROR_THRESHING_NOT_ALLOWED: "threshing not allowed right now",
  ERROR_UNKNOWN: "unknown error",
  ERROR_UNLOADING_STATION_DELETED: "unloading station removed",
  ERROR_UNLOADINGSTATION_FULL: "unloading station full",
  ERROR_WRONG_SEASON: "wrong season for this work",
  ERROR_VEHICLE_BROKEN: "vehicle broken down",
  ERROR_VEHICLE_DELETED: "vehicle removed",
  ERROR_VINEYARD_NOT_SUPPORTED: "vineyard not supported",
  SUCCESS_FINISHED_JOB: "job finished",
  SUCCESS_SILO_EMPTY: "silo empty",
  SUCCESS_STOPPED_BY_USER: "stopped by the player",
  UNKNOWN: "stopped without a reason",
};

/** A stop reason in words; names the game adds later fall back to their own words. */
export function describeReason(reason: string): string {
  return (
    REASONS[reason] ??
    reason
      .replace(/^(ERROR|SUCCESS)_/, "")
      .toLowerCase()
      .replace(/_/g, " ")
  );
}

function stopSeverity(reason: string): AlertSeverity {
  if (reason.startsWith("SUCCESS_")) return "info";
  if (reason.startsWith("ERROR_")) return "critical";
  return "warning";
}

/** `FIELDWORK` → `fieldwork job`, for a stop whose vehicle is gone from the fleet. */
function describeJobType(jobType: string): string {
  return `${jobType.toLowerCase().replace(/_/g, " ")} job`;
}

export interface AlertRules {
  /** Fuel below this on a vehicle the AI drives raises `fuel_low`. */
  fuelLowPct: number;
  /** The fuel must climb back to this before `fuel_low` can fire again for the vehicle. */
  fuelRecoverPct: number;
  /** Raise `tank_full_soon` when the tank will be full within this many seconds. */
  tankEtaSec: number;
  /** Stops already in the ring when the bridge first sees a session are alerted only if this recent. */
  backfillMs: number;
}

export const DEFAULT_RULES: AlertRules = {
  fuelLowPct: 10,
  fuelRecoverPct: 15,
  tankEtaSec: 120,
  backfillMs: 120_000,
};

const AI_CONTROLLERS = new Set<FleetVehicle["controller"]>(["ai", "courseplay", "autodrive"]);
/** Fill rate is measured over this much recent history. */
const TANK_WINDOW_MS = 60_000;
/** An estimate needs at least this many samples spread over at least this long. */
const TANK_MIN_SAMPLES = 3;
const TANK_MIN_SPAN_MS = 15_000;
/** A drop this large means the tank was unloaded: the history starts over. */
const TANK_UNLOAD_DROP_PCT = 5;

interface TankTrack {
  samples: Array<{ t: number; pct: number }>;
  alerted: boolean;
}

/** Seconds until 100 %, from a least-squares fit of fill against time; undefined if not filling. */
export function tankEtaSeconds(
  samples: ReadonlyArray<{ t: number; pct: number }>,
): number | undefined {
  const first = samples[0];
  const last = samples.at(-1);
  if (!first || !last || samples.length < TANK_MIN_SAMPLES) return undefined;
  if (last.t - first.t < TANK_MIN_SPAN_MS) return undefined;
  const n = samples.length;
  const meanT = samples.reduce((sum, s) => sum + s.t, 0) / n;
  const meanP = samples.reduce((sum, s) => sum + s.pct, 0) / n;
  let covariance = 0;
  let variance = 0;
  for (const s of samples) {
    covariance += (s.t - meanT) * (s.pct - meanP);
    variance += (s.t - meanT) ** 2;
  }
  if (variance === 0) return undefined;
  const pctPerSecond = (covariance / variance) * 1000;
  if (pctPerSecond <= 0) return undefined;
  return Math.max(0, (100 - last.pct) / pctPerSecond);
}

function formatEta(seconds: number): string {
  if (seconds < 60) return "less than a minute";
  return `about ${Math.round(seconds / 60)} min`;
}

/**
 * Turns the live stream into alerts (docs/HANDOFF.md, "Live server"): a worker stopping for any
 * reason but the player's, low fuel on a vehicle the AI drives, a tank about to fill up, and the game
 * going quiet. One engine per followed save; its memory resets when the game starts a new session.
 */
export class AlertEngine {
  private sessionId: string | undefined;
  private readonly seenStops = new Set<number>();
  private readonly lowFuel = new Set<string>();
  private readonly tanks = new Map<string, TankTrack>();
  private online = false;

  constructor(private readonly rules: AlertRules = DEFAULT_RULES) {}

  /** Checks one fresh `live_fleet.json` frame. */
  onFleet(frame: LiveFleet, nowMs: number): Alert[] {
    const firstFrame = frame.sessionId !== this.sessionId;
    if (firstFrame) {
      this.sessionId = frame.sessionId;
      this.seenStops.clear();
      this.lowFuel.clear();
      this.tanks.clear();
    }
    const vehicles = new Map(frame.fleet.vehicles.map((v) => [v.vehicleId, v]));
    const at = new Date(nowMs).toISOString();
    return [
      ...this.stops(frame, vehicles, firstFrame, nowMs, at),
      ...this.fuel(frame, nowMs, at),
      ...this.tankEta(frame, vehicles, nowMs, at),
    ];
  }

  /** The game is writing again. */
  markOnline(): void {
    this.online = true;
  }

  /** The game went quiet: one alert per outage, and only after it had been online. */
  onOffline(nowMs: number): Alert[] {
    if (!this.online) return [];
    this.online = false;
    return [
      {
        id: `offline:${nowMs}`,
        kind: "game_offline",
        severity: "warning",
        title: "Game offline",
        message: "No update from the game for 15 s: it was closed, crashed or is loading.",
        vehicleId: null,
        jobId: null,
        farmId: null,
        at: new Date(nowMs).toISOString(),
      },
    ];
  }

  private stops(
    frame: LiveFleet,
    vehicles: Map<string, FleetVehicle>,
    firstFrame: boolean,
    nowMs: number,
    at: string,
  ): Alert[] {
    const out: Alert[] = [];
    for (const stop of frame.fleet.stops) {
      if (this.seenStops.has(stop.stopId)) continue;
      this.seenStops.add(stop.stopId);
      if (stop.reason === USER_STOPPED) continue;
      if (firstFrame) {
        // The bridge (re)started mid-session: old stops were either alerted before or are stale.
        const stoppedAt = parseGameTimestamp(stop.realTs);
        if (stoppedAt === undefined || nowMs - stoppedAt > this.rules.backfillMs) continue;
      }
      const vehicle = stop.vehicleId === null ? undefined : vehicles.get(stop.vehicleId);
      const machine = vehicle?.name ?? describeJobType(stop.jobType);
      out.push({
        id: `stop:${frame.sessionId}:${stop.stopId}`,
        kind: "worker_stop",
        severity: stopSeverity(stop.reason),
        title: stop.reason.startsWith("SUCCESS_") ? "Worker finished" : "Worker stopped",
        message: `${stop.helper ?? "Worker"} on ${machine}: ${describeReason(stop.reason)}`,
        vehicleId: stop.vehicleId,
        jobId: stop.jobId,
        farmId: stop.farmId,
        at,
      });
    }
    return out;
  }

  private fuel(frame: LiveFleet, nowMs: number, at: string): Alert[] {
    const out: Alert[] = [];
    const jobs = new Map(frame.fleet.jobs.map((j) => [j.vehicleId, j]));
    const present = new Set<string>();
    for (const vehicle of frame.fleet.vehicles) {
      const id = vehicle.vehicleId;
      present.add(id);
      const pct = vehicle.fuelPct;
      if (pct === null) continue;
      if (pct >= this.rules.fuelRecoverPct) {
        this.lowFuel.delete(id);
        continue;
      }
      const job = jobs.get(id);
      const aiDriven = AI_CONTROLLERS.has(vehicle.controller) || job !== undefined;
      if (!aiDriven || pct >= this.rules.fuelLowPct || this.lowFuel.has(id)) continue;
      this.lowFuel.add(id);
      out.push({
        id: `fuel:${frame.sessionId}:${id}:${nowMs}`,
        kind: "fuel_low",
        severity: "warning",
        title: "Fuel low",
        message: `${vehicle.name}: ${Math.round(pct)} % fuel left${job?.helper ? `, driven by ${job.helper}` : ""}`,
        vehicleId: id,
        jobId: job?.jobId ?? null,
        farmId: vehicle.farmId,
        at,
      });
    }
    for (const id of this.lowFuel) if (!present.has(id)) this.lowFuel.delete(id);
    return out;
  }

  private tankEta(
    frame: LiveFleet,
    vehicles: Map<string, FleetVehicle>,
    nowMs: number,
    at: string,
  ): Alert[] {
    const out: Alert[] = [];
    const running = new Set<string>();
    for (const job of frame.fleet.jobs) {
      running.add(job.jobId);
      const pct = job.tankFillPct;
      if (pct === null) continue;
      let track = this.tanks.get(job.jobId);
      if (!track) {
        track = { samples: [], alerted: false };
        this.tanks.set(job.jobId, track);
      }
      const previous = track.samples.at(-1);
      if (previous && pct < previous.pct - TANK_UNLOAD_DROP_PCT) {
        track.samples = [];
        track.alerted = false;
      }
      track.samples.push({ t: nowMs, pct });
      track.samples = track.samples.filter((s) => nowMs - s.t <= TANK_WINDOW_MS);
      if (track.alerted || pct >= 100) continue;
      const eta = tankEtaSeconds(track.samples);
      if (eta === undefined || eta > this.rules.tankEtaSec) continue;
      track.alerted = true;
      const machine = vehicles.get(job.vehicleId)?.name ?? describeJobType(job.jobType);
      out.push({
        id: `tank:${frame.sessionId}:${job.jobId}:${nowMs}`,
        kind: "tank_full_soon",
        severity: "warning",
        title: "Tank almost full",
        message: `${job.helper ?? "Worker"} on ${machine}: ${Math.round(pct)} % full, full in ${formatEta(eta)}`,
        vehicleId: job.vehicleId,
        jobId: job.jobId,
        farmId: job.farmId,
        at,
      });
    }
    for (const jobId of this.tanks.keys()) if (!running.has(jobId)) this.tanks.delete(jobId);
    return out;
  }
}
