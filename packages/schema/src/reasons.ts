// Why a hired worker stopped, in words. The names are the ones FS25 registers with its
// AIMessageManager (VERIFY_FIRST.md, 6); live_fleet.json carries them in `stops[].reason`.
// No Zod here, so the phone page can import this without bundling it.

/** The reason the game records when the player stops a worker. */
export const USER_STOPPED = "SUCCESS_STOPPED_BY_USER";

export const STOP_REASONS: Readonly<Record<string, string>> = {
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

/** A stop reason in words; a name the game adds later falls back to its own words. */
export function describeReason(reason: string): string {
  return (
    STOP_REASONS[reason] ??
    reason
      .replace(/^(ERROR|SUCCESS)_/, "")
      .toLowerCase()
      .replace(/_/g, " ")
  );
}

/** How serious a stop is: the game's own errors are, a finished job is not. */
export function stopSeverity(reason: string): "info" | "warning" | "critical" {
  if (reason.startsWith("SUCCESS_")) return "info";
  if (reason.startsWith("ERROR_")) return "critical";
  return "warning";
}
