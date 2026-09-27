import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const SYNC_FILE = "sync-state.json";

const Rejected = z.object({
  branchId: z.uuid(),
  seq: z.int().min(1),
  error: z.string(),
});
export type Rejected = z.infer<typeof Rejected>;

const SaveCursor = z.object({
  /** Per branch, the highest seq Supabase has confirmed. Everything at or below it is there. */
  branches: z.record(z.uuid(), z.int().min(0)),
  /** Per branch, the game day of the last snapshot written. */
  snapshotDays: z.record(z.uuid(), z.int().min(0)),
  /** Lines Supabase refused outright; they stay in the event files. The most recent 50. */
  rejected: z.array(Rejected),
  lastSyncedAt: z.string().nullable(),
});
type SaveCursor = z.infer<typeof SaveCursor>;

export const SyncStateFile = z.object({
  v: z.literal(1),
  saves: z.record(z.uuid(), SaveCursor),
});
export type SyncStateFile = z.infer<typeof SyncStateFile>;

const MAX_REJECTED = 50;

/**
 * `sync-state.json` in the bridge's state folder: how far each save's event log has reached
 * Supabase. The event files are the queue; this only says where the sync stands in them, and it
 * moves only after Supabase confirms a write. Writes go to a temporary file renamed into place.
 */
export class SyncCursorStore {
  readonly path: string;
  private data: SyncStateFile;

  constructor(readonly dir: string) {
    this.path = join(dir, SYNC_FILE);
    this.data = SyncCursorStore.read(dir) ?? { v: 1, saves: {} };
  }

  /** Reads the file without creating it, for --doctor. */
  static read(dir: string): SyncStateFile | undefined {
    try {
      const parsed = SyncStateFile.safeParse(
        JSON.parse(readFileSync(join(dir, SYNC_FILE), "utf8")),
      );
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  save(saveId: string): Readonly<SaveCursor> {
    return (
      this.data.saves[saveId] ?? {
        branches: {},
        snapshotDays: {},
        rejected: [],
        lastSyncedAt: null,
      }
    );
  }

  /** The highest seq confirmed on a branch; 0 before anything was. */
  synced(saveId: string, branchId: string): number {
    return this.save(saveId).branches[branchId] ?? 0;
  }

  snapshotDay(saveId: string, branchId: string): number | undefined {
    return this.save(saveId).snapshotDays[branchId];
  }

  /** Records a confirmed write: per branch, the highest seq it held. Never moves back. */
  advance(saveId: string, seqs: Record<string, number>, at: Date): void {
    const current = this.save(saveId);
    const branches = { ...current.branches };
    for (const [branchId, seq] of Object.entries(seqs)) {
      branches[branchId] = Math.max(branches[branchId] ?? 0, seq);
    }
    this.put(saveId, { ...current, branches, lastSyncedAt: at.toISOString() });
  }

  setSnapshotDay(saveId: string, branchId: string, day: number): void {
    const current = this.save(saveId);
    this.put(saveId, { ...current, snapshotDays: { ...current.snapshotDays, [branchId]: day } });
  }

  reject(saveId: string, entries: Rejected[]): void {
    const current = this.save(saveId);
    this.put(saveId, {
      ...current,
      rejected: [...current.rejected, ...entries].slice(-MAX_REJECTED),
    });
  }

  private put(saveId: string, cursor: SaveCursor): void {
    this.data = { ...this.data, saves: { ...this.data.saves, [saveId]: cursor } };
    mkdirSync(this.dir, { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}
