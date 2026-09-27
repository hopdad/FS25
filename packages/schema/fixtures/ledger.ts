// The ledger's golden fixtures: event lines in, the analytics they must produce out. Every
// implementation of the ledger math runs them: the SQL views (supabase/test), and later the mod's
// in-game ledger (PLAN_REVIEW.md, "Two implementations of the same math").
//
// A fixture's events omit what they share: each event is `{ ...defaults, ...event }`. Expected rows
// name the view's columns and list only the columns they pin; numbers match to 6 decimals.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventEnvelope } from "../src/events";

export interface LedgerFixture {
  name: string;
  description: string;
  saveId: string;
  branchId: string;
  events: EventEnvelope[];
  /** Daily snapshots: the `farm` object of live_farm.json, on the fixture's branch. */
  snapshots: { day: number; payload: unknown }[];
  /** View name to the rows it must hold for the save, in any order. */
  expect: Record<string, Record<string, unknown>[]>;
}

export const LEDGER_FIXTURES_DIR = fileURLToPath(new URL("./ledger/", import.meta.url));

interface RawFixture {
  description: string;
  defaults: Record<string, unknown> & { saveId: string; branchId: string };
  events: Record<string, unknown>[];
  snapshots?: { day: number; payload: unknown }[];
  expect: Record<string, Record<string, unknown>[]>;
}

export function loadLedgerFixture(file: string): LedgerFixture {
  const raw = JSON.parse(readFileSync(join(LEDGER_FIXTURES_DIR, file), "utf8")) as RawFixture;
  const events = raw.events.map((event, index) => {
    const parsed = EventEnvelope.safeParse({ ...raw.defaults, ...event });
    if (!parsed.success) {
      throw new Error(`${file}, event ${index + 1}: ${parsed.error.message}`);
    }
    return parsed.data;
  });
  return {
    name: file.replace(/\.json$/, ""),
    description: raw.description,
    saveId: raw.defaults.saveId,
    branchId: raw.defaults.branchId,
    events,
    snapshots: raw.snapshots ?? [],
    expect: raw.expect,
  };
}

export function ledgerFixtures(): LedgerFixture[] {
  return readdirSync(LEDGER_FIXTURES_DIR)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map(loadLedgerFixture);
}
