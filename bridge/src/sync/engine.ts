import { type EventEnvelope, type EventRow, eventRow, type LiveFarm } from "@farmlink/schema";
import type { Rejected, SyncCursorStore } from "./cursor";
import { SyncError } from "./rest";
import type { SaveInfo, SaveRole, SnapshotRow, SyncTransport } from "./transport";

export interface SyncStatus {
  /**
   * `waiting` for the save's meta.json; `synced` with nothing queued; `sending` with events queued;
   * `retrying` after a failure that may pass; `blocked` by one that will not without a change
   * (another account's save, missing migrations).
   */
  state: "waiting" | "synced" | "sending" | "retrying" | "blocked";
  queued: number;
  role: SaveRole | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  retryInMs: number | null;
  /** Lines Supabase refused outright, over the save's life. */
  rejected: number;
  /** Per branch, the highest seq confirmed. */
  branches: Record<string, number>;
}

export interface SyncEngineOptions {
  saveId: string;
  transport: SyncTransport;
  cursor: SyncCursorStore;
  log?: (line: string) => void;
  now?: () => number;
  /** Events per write (default 200). */
  batchSize?: number;
  /** A smaller batch waits at most this long (default 5 s). */
  flushMs?: number;
  /** Backoff after a failure: doubles from the first to the second (default 1 s to 5 min). */
  backoffMs?: [number, number];
  /** How often the save's last_synced_at is updated while events flow (default 60 s). */
  markEveryMs?: number;
  /** How often the engine checks whether to write (default 1 s). */
  tickMs?: number;
}

/**
 * The Supabase sync for one save (docs/HANDOFF.md, "Supabase sync"). It takes the event log's lines
 * in order, skips what Supabase already has, and writes the rest in batches of up to 200 or every
 * 5 s. The cursor advances only after Supabase confirms a write, so after a crash or a long time
 * offline the next run starts where the confirmed writes end, from the event files themselves. A
 * failure backs off from 1 s to 5 min. A batch the database refuses is split until the refused
 * lines are found; those are recorded and skipped, and the rest goes through.
 */
export class SyncEngine {
  private readonly saveId: string;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly batchSize: number;
  private readonly flushMs: number;
  private readonly backoff: [number, number];
  private readonly markEveryMs: number;

  private queue: EventRow[] = [];
  private queuedSince: number | undefined;
  private readonly lastQueued = new Map<string, number>();
  private snapshot: SnapshotRow | undefined;
  private info: SaveInfo | undefined;
  private role: SaveRole | undefined;
  private timer: NodeJS.Timeout | undefined;
  private busy: Promise<void> | undefined;
  private backoffMs = 0;
  private retryAt = 0;
  private error: SyncError | undefined;
  private loggedError: string | undefined;
  private lastMarkAt: number | undefined;
  private unmarked = false;

  constructor(private readonly options: SyncEngineOptions) {
    this.saveId = options.saveId;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
    this.batchSize = options.batchSize ?? 200;
    this.flushMs = options.flushMs ?? 5000;
    this.backoff = options.backoffMs ?? [1000, 300_000];
    this.markEveryMs = options.markEveryMs ?? 60_000;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.options.tickMs ?? 1000);
  }

  /**
   * Stops the timer and makes one last attempt at what is queued, for at most `timeoutMs`. Whatever
   * does not make it is sent by the next run, from the event files.
   */
  async stop(timeoutMs = 5000): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    let timeout: NodeJS.Timeout | undefined;
    await Promise.race([
      this.tick({ flush: true, ignoreBackoff: true }),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
      }),
    ]);
    clearTimeout(timeout);
  }

  /** The save's name and version, from meta.json. Nothing is written before the first. */
  setSave(info: SaveInfo): void {
    const changed = this.info?.name !== info.name || this.info?.modVersion !== info.modVersion;
    this.info = info;
    if (changed) this.unmarked = true;
  }

  /** New event lines, in log order. Lines Supabase already has are skipped. */
  push(events: readonly EventEnvelope[]): void {
    for (const event of events) {
      if (event.saveId !== this.saveId) continue;
      const done = Math.max(
        this.options.cursor.synced(this.saveId, event.branchId),
        this.lastQueued.get(event.branchId) ?? 0,
      );
      if (event.seq <= done) continue;
      this.queue.push(eventRow(event));
      this.lastQueued.set(event.branchId, event.seq);
      this.queuedSince ??= this.now();
    }
    if (this.queue.length >= this.batchSize) void this.tick();
  }

  /** A live_farm.json frame: the first of each game day becomes that day's snapshot. */
  offerSnapshot(frame: LiveFarm, branchId: string): void {
    if (frame.saveId !== this.saveId) return;
    const last = this.options.cursor.snapshotDay(this.saveId, branchId);
    if (last !== undefined && frame.day <= last) return;
    if (this.snapshot?.branch_id === branchId && this.snapshot.day === frame.day) return;
    this.snapshot = {
      save_id: this.saveId,
      branch_id: branchId,
      day: frame.day,
      payload: frame.farm,
    };
  }

  status(): SyncStatus {
    const cursor = this.options.cursor.save(this.saveId);
    const retrying = this.error !== undefined;
    let state: SyncStatus["state"] = "synced";
    if (this.info === undefined) state = "waiting";
    else if (retrying) state = this.error?.retryable ? "retrying" : "blocked";
    else if (this.queue.length > 0 || this.snapshot !== undefined) state = "sending";
    return {
      state,
      queued: this.queue.length,
      role: this.role ?? null,
      lastSyncedAt: cursor.lastSyncedAt,
      lastError: this.error?.message ?? null,
      retryInMs: retrying ? Math.max(0, this.retryAt - this.now()) : null,
      rejected: cursor.rejected.length,
      branches: { ...cursor.branches },
    };
  }

  /** One step: writes what is due. Public so tests can drive it without timers. */
  tick(options: { flush?: boolean; ignoreBackoff?: boolean } = {}): Promise<void> {
    if (this.busy) {
      // A write is under way; a flush asked for meanwhile runs once it is done.
      const busy = this.busy;
      return options.flush || options.ignoreBackoff ? busy.then(() => this.tick(options)) : busy;
    }
    this.busy = this.step(options).finally(() => {
      this.busy = undefined;
    });
    return this.busy;
  }

  private async step({ flush = false, ignoreBackoff = false }): Promise<void> {
    const info = this.info;
    if (info === undefined) return;
    if (!ignoreBackoff && this.now() < this.retryAt) return;
    const due = () =>
      this.queue.length >= this.batchSize ||
      (this.queue.length > 0 && (flush || this.now() - (this.queuedSince ?? 0) >= this.flushMs));
    if (!due() && this.snapshot === undefined && !this.unmarked) return;

    try {
      this.role ??= await this.options.transport.ensureSave(info);
      while (due()) {
        const batch = this.queue.slice(0, this.batchSize);
        await this.send(batch);
        this.queue.splice(0, batch.length);
        this.queuedSince = this.queue.length > 0 ? this.now() : undefined;
        this.unmarked = true;
      }
      const snapshot = this.snapshot;
      if (snapshot !== undefined) {
        await this.options.transport.upsertSnapshot(snapshot);
        this.options.cursor.setSnapshotDay(this.saveId, snapshot.branch_id, snapshot.day);
        if (this.snapshot === snapshot) this.snapshot = undefined;
      }
      if (
        this.unmarked &&
        (flush || this.lastMarkAt === undefined || this.now() - this.lastMarkAt >= this.markEveryMs)
      ) {
        await this.options.transport.markSynced(info, new Date(this.now()));
        this.lastMarkAt = this.now();
        this.unmarked = false;
      }
      if (this.error !== undefined) this.log(`sync: writing to Supabase again`);
      this.error = undefined;
      this.loggedError = undefined;
      this.backoffMs = 0;
      this.retryAt = 0;
    } catch (caught) {
      this.fail(caught);
    }
  }

  /** Writes one batch; refused lines are found by halving, recorded and skipped. */
  private async send(batch: EventRow[]): Promise<void> {
    const refused = await this.isolate(batch);
    if (refused.length > 0) {
      this.options.cursor.reject(this.saveId, refused);
      const seqs = refused.map((r) => r.seq).join(", ");
      this.log(
        `sync: Supabase refused ${refused.length} event line(s), seq ${seqs}: ${refused[0]?.error}`,
      );
    }
    const highest: Record<string, number> = {};
    for (const row of batch)
      highest[row.branch_id] = Math.max(highest[row.branch_id] ?? 0, row.seq);
    this.options.cursor.advance(this.saveId, highest, new Date(this.now()));
  }

  private async isolate(rows: EventRow[]): Promise<Rejected[]> {
    try {
      await this.options.transport.insertEvents(rows);
      return [];
    } catch (caught) {
      if (!(caught instanceof SyncError) || caught.kind !== "rejected") throw caught;
      if (rows.length === 1) {
        const [row] = rows as [EventRow];
        return [{ branchId: row.branch_id, seq: row.seq, error: caught.message }];
      }
      const half = Math.ceil(rows.length / 2);
      return [
        ...(await this.isolate(rows.slice(0, half))),
        ...(await this.isolate(rows.slice(half))),
      ];
    }
  }

  private fail(caught: unknown): void {
    const error =
      caught instanceof SyncError
        ? caught
        : new SyncError(String((caught as Error)?.message ?? caught), "server");
    const [min, max] = this.backoff;
    this.backoffMs = error.retryable ? Math.min(max, Math.max(min, this.backoffMs * 2)) : max;
    this.retryAt = this.now() + this.backoffMs;
    // A refusal may be lifted (made a member, migrations applied): ask again next time.
    if (error.kind === "forbidden" || error.kind === "config") this.role = undefined;
    this.error = error;
    if (this.loggedError !== error.message) {
      this.loggedError = error.message;
      this.log(`sync: ${error.message}; next attempt in ${Math.round(this.backoffMs / 1000)} s`);
    }
  }
}
