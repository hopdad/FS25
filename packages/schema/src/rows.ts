import type { EventEnvelope } from "./events";

/** One row of the Supabase `events` table (supabase/migrations). */
export interface EventRow {
  save_id: string;
  branch_id: string;
  seq: number;
  type: EventEnvelope["type"];
  farm_id: number;
  user_id: string | null;
  day: number;
  minute: number;
  year: number;
  /** UTC, RFC 3339. */
  real_ts: string;
  data: EventEnvelope["data"];
  v: number;
}

/**
 * The `events` row for one event line, as the bridge upserts it. `realTs` is normalized to UTC
 * (PLAN_REVIEW.md C2): with an offset it names an instant, and without one it is the local time of
 * the PC the bridge shares with the game, which is how a date-time without offset parses here.
 */
export function eventRow(event: EventEnvelope): EventRow {
  const instant = new Date(event.realTs);
  if (Number.isNaN(instant.getTime())) {
    throw new Error(`event ${event.seq}: realTs ${event.realTs} is not a date-time`);
  }
  return {
    save_id: event.saveId,
    branch_id: event.branchId,
    seq: event.seq,
    type: event.type,
    farm_id: event.farmId,
    user_id: event.userId,
    day: event.day,
    minute: event.minute,
    year: event.year,
    real_ts: instant.toISOString(),
    data: event.data,
    v: event.v,
  };
}
