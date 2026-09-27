import type { EventRow, LiveFarm } from "@farmlink/schema";
import { type RestClient, SyncError } from "./rest";

/** The save's row in Supabase, from meta.json. */
export interface SaveInfo {
  saveId: string;
  name: string | null;
  map: string | null;
  modVersion: string | null;
}

/** One row of `snapshots`: the farm object of live_farm.json, once per game day and branch. */
export interface SnapshotRow {
  save_id: string;
  branch_id: string;
  day: number;
  payload: LiveFarm["farm"];
}

/** What the caller may do with a save: an owner or member syncs it; a viewer only reads. */
export type SaveRole = "owner" | "member";

/** Where the sync writes. The Supabase one is below; tests use an in-memory one. */
export interface SyncTransport {
  /** Creates the save's row if it has none, and says what the caller is to it. */
  ensureSave(save: SaveInfo): Promise<SaveRole>;
  /** Inserts event rows; a row already there is left as it is. */
  insertEvents(rows: readonly EventRow[]): Promise<void>;
  upsertSnapshot(row: SnapshotRow): Promise<void>;
  /** Records the sync time, and the name and version the save has now. */
  markSynced(save: SaveInfo, at: Date): Promise<void>;
}

/** The ledger's tables over PostgREST (supabase/migrations), as the signed-in player. */
export class SupabaseTransport implements SyncTransport {
  constructor(private readonly rest: RestClient) {}

  async ensureSave(save: SaveInfo): Promise<SaveRole> {
    // owner_id defaults to the caller; a save that already exists, anyone's, is left alone.
    await this.rest.insert(
      "saves",
      [{ id: save.saveId, name: save.name, map: save.map, mod_version: save.modVersion }],
      { onConflict: "id", resolution: "ignore-duplicates" },
    );
    const mine = await this.rest.rpc<{ save_id: string; role: string }[]>("my_saves");
    const role = mine.find((row) => row.save_id === save.saveId)?.role;
    if (role === "owner" || role === "member") return role;
    throw new SyncError(
      role === "viewer"
        ? `you can only view save ${save.saveId}; its owner can make you a member`
        : `save ${save.saveId} belongs to another account`,
      "forbidden",
    );
  }

  async insertEvents(rows: readonly EventRow[]): Promise<void> {
    await this.rest.insert("events", rows, {
      onConflict: "save_id,branch_id,seq",
      resolution: "ignore-duplicates",
    });
  }

  async upsertSnapshot(row: SnapshotRow): Promise<void> {
    await this.rest.insert("snapshots", [{ ...row, taken_at: new Date().toISOString() }], {
      onConflict: "save_id,branch_id,day",
      resolution: "merge-duplicates",
    });
  }

  async markSynced(save: SaveInfo, at: Date): Promise<void> {
    await this.rest.update(
      "saves",
      { id: `eq.${save.saveId}` },
      {
        last_synced_at: at.toISOString(),
        ...(save.name !== null ? { name: save.name } : {}),
        ...(save.modVersion !== null ? { mod_version: save.modVersion } : {}),
      },
    );
  }
}
