import { join } from "node:path";
import { type BridgeHeartbeat, FILES, renderBridgeXml } from "@farmlink/schema";
import { writeFileAtomic } from "../fsutil";
import { localIsoWithOffset } from "../time";
import { BRIDGE_VERSION } from "../version";

/** The mod treats the bridge as gone when the beat has not changed for 10 s. */
export const HEARTBEAT_INTERVAL_MS = 5000;

export interface HeartbeatOptions {
  saveDir: string;
  intervalMs?: number;
  features?: BridgeHeartbeat["features"];
  now?: () => Date;
  write?: (path: string, text: string) => Promise<unknown>;
  /** Called when writes start failing, once per streak. */
  onError?: (error: Error) => void;
  /** Called when a write succeeds after a failing streak. */
  onRecover?: () => void;
}

/** Rewrites `bridge.xml` with an increasing beat, so the mod knows a bridge is listening. */
export class HeartbeatWriter {
  readonly path: string;
  private beat = 0;
  private timer: NodeJS.Timeout | undefined;
  private failing = false;

  constructor(private readonly options: HeartbeatOptions) {
    this.path = join(options.saveDir, FILES.bridgeHeartbeat);
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(
      () => void this.tick(),
      this.options.intervalMs ?? HEARTBEAT_INTERVAL_MS,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Writes one beat; public so tests can drive it without timers. */
  async tick(): Promise<void> {
    this.beat++;
    const text = renderBridgeXml({
      v: 1,
      bridgeVersion: BRIDGE_VERSION,
      beat: this.beat,
      realTs: localIsoWithOffset((this.options.now ?? (() => new Date()))()),
      features: this.options.features ?? ["commands"],
    });
    try {
      await (this.options.write ?? writeFileAtomic)(this.path, text);
      if (this.failing) this.options.onRecover?.();
      this.failing = false;
    } catch (error) {
      if (!this.failing) this.options.onError?.(error as Error);
      this.failing = true;
    }
  }
}
