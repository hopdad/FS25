import { stat } from "node:fs/promises";
import type { z } from "zod";
import { type ReadOptions, readJsonFile } from "./files";

export interface LiveWatcherStats {
  /** Valid frames delivered. */
  frames: number;
  /** Changes that never produced parseable JSON, even after retries. */
  tornReads: number;
  /** Frames that parsed but failed the schema; dropped with a counted warning. */
  invalid: number;
  /** Reads that needed more than one attempt but then succeeded. */
  retriedReads: number;
}

export interface LiveWatcherOptions<T> {
  file: string;
  schema: z.ZodType<T>;
  /** How often to stat the file. */
  pollMs?: number;
  /** No new frame for this long marks the game offline. The spec asks for 15 s. */
  offlineAfterMs?: number;
  read?: ReadOptions;
  onFrame: (frame: T, text: string) => void;
  onInvalid?: (error: string) => void;
  onOffline?: () => void;
  onOnline?: () => void;
  now?: () => number;
}

/**
 * Polls one live channel file and delivers each new, valid frame once. Polling rather than file
 * events: the game rewrites the file in place every second, and a stat every 100 ms is cheap and
 * behaves the same on Windows, macOS and Linux.
 */
export class LiveWatcher<T> {
  readonly stats: LiveWatcherStats = { frames: 0, tornReads: 0, invalid: 0, retriedReads: 0 };
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  private lastSignature = "";
  private lastText = "";
  private lastFrameAt: number;
  private offline = false;
  private readonly now: () => number;

  constructor(private readonly options: LiveWatcherOptions<T>) {
    this.now = options.now ?? Date.now;
    this.lastFrameAt = this.now();
  }

  start(): void {
    if (this.timer) return;
    this.lastFrameAt = this.now();
    this.timer = setInterval(() => void this.poll(), this.options.pollMs ?? 100);
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  get isOffline(): boolean {
    return this.offline;
  }

  /** One polling step; public so tests can drive it without timers. */
  async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.check();
      this.checkOffline();
    } finally {
      this.busy = false;
    }
  }

  private async check(): Promise<void> {
    let signature: string;
    try {
      const info = await stat(this.options.file);
      signature = `${info.mtimeMs}:${info.size}`;
    } catch {
      return;
    }
    if (signature === this.lastSignature) return;

    const result = await readJsonFile(this.options.file, this.options.schema, this.options.read);
    if (result.ok) {
      this.lastSignature = signature;
      if (result.attempts > 1) this.stats.retriedReads++;
      if (result.text === this.lastText) return;
      this.lastText = result.text;
      this.stats.frames++;
      this.lastFrameAt = this.now();
      if (this.offline) {
        this.offline = false;
        this.options.onOnline?.();
      }
      this.options.onFrame(result.value, result.text);
      return;
    }
    if (result.reason === "invalid") {
      // The content is complete but wrong; wait for the next write rather than re-reading it.
      this.lastSignature = signature;
      this.stats.invalid++;
      this.options.onInvalid?.(result.error);
    } else if (result.reason === "parse" || result.reason === "unreadable") {
      // Leave the signature unset so the next poll tries again.
      this.stats.tornReads++;
    }
  }

  private checkOffline(): void {
    const limit = this.options.offlineAfterMs ?? 15000;
    if (!this.offline && this.now() - this.lastFrameAt > limit) {
      this.offline = true;
      this.options.onOffline?.();
    }
  }
}
