import type { EventEnvelope } from "@farmlink/schema";
import { EventLogReader } from "./reader";
import { SequenceCheck } from "./sequence";

export interface EventLogWatcherOptions {
  saveDir: string;
  pollMs?: number;
  log?: (line: string) => void;
  /** Every new valid event, in log order, once. */
  onEvents?: (events: EventEnvelope[]) => void;
}

/** Invalid lines logged one by one before the rest are only counted. */
const MAX_LOGGED_INVALID = 10;

/**
 * Follows a save's event log while the bridge serves: validates each new line, runs the gap check,
 * and logs what fails either. The Supabase sync takes its events from here.
 */
export class EventLogWatcher {
  readonly sequence = new SequenceCheck();
  private readonly reader: EventLogReader;
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  readonly stats = { events: 0, invalid: 0 };

  constructor(private readonly options: EventLogWatcherOptions) {
    this.reader = new EventLogReader(options.saveDir);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), this.options.pollMs ?? 2000);
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One polling step; public so tests can drive it without timers. */
  async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const log = this.options.log ?? (() => {});
      const fresh: EventEnvelope[] = [];
      for (const line of await this.reader.read()) {
        if (!line.ok) {
          this.stats.invalid += 1;
          if (this.stats.invalid <= MAX_LOGGED_INVALID) {
            log(`skipped an invalid event line, ${line.file} line ${line.line}: ${line.error}`);
          }
          continue;
        }
        const result = this.sequence.add(line.event);
        if (result === "duplicate") continue;
        if (result !== undefined) {
          log(
            `event log gap on branch ${result.branchId}: seq ${result.after + 1}` +
              `${result.missing > 1 ? ` to ${result.next - 1}` : ""} never written`,
          );
        }
        this.stats.events += 1;
        fresh.push(line.event);
      }
      if (fresh.length > 0) this.options.onEvents?.(fresh);
    } finally {
      this.busy = false;
    }
  }
}
