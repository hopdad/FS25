import type {
  Alert,
  BridgeStatus,
  LiveFarm,
  LiveFleet,
  LiveVehicle,
  ServerMessage,
} from "@farmlink/schema";
import { BRIDGE_VERSION } from "../version";

/** One connected page. */
export interface HubClient {
  send(text: string): void;
  /** Bytes queued but not yet sent. */
  readonly bufferedAmount?: number;
}

interface Channels {
  vehicle: LiveVehicle;
  fleet: LiveFleet;
  farm: LiveFarm;
}
export type ChannelName = keyof Channels;

/** Recent alerts replayed to a page when it connects. */
const MAX_ALERTS = 50;
/** A client this far behind skips channel frames until it catches up; the next frame replaces them. */
const MAX_BUFFERED_BYTES = 1_000_000;

function encode(message: ServerMessage): string {
  return JSON.stringify(message);
}

/**
 * The state every page sees: bridge status, the latest frame of each channel, and recent alerts. A
 * page that connects gets all of it at once, then every change as it happens. Channel frames are
 * sent whole rather than as diffs: they are small, and a whole frame cannot drift out of sync.
 */
export class LiveHub {
  private status: BridgeStatus = {
    bridgeVersion: BRIDGE_VERSION,
    gameOnline: false,
    saveId: null,
    saveName: null,
    mode: null,
    modVersion: null,
    gameVersion: null,
  };
  private readonly frames = new Map<ChannelName, string>();
  private alerts: Alert[] = [];
  private readonly clients = new Set<HubClient>();

  /** `onAlert` sees every alert as it is raised, for the bridge's own log. */
  constructor(private readonly onAlert?: (alert: Alert) => void) {}

  get clientCount(): number {
    return this.clients.size;
  }

  get currentStatus(): BridgeStatus {
    return this.status;
  }

  get recentAlerts(): readonly Alert[] {
    return this.alerts;
  }

  /** Sends the current state to a new page and returns the function that detaches it. */
  attach(client: HubClient): () => void {
    const detach = () => {
      this.clients.delete(client);
    };
    try {
      client.send(encode({ type: "hello", bridgeVersion: BRIDGE_VERSION }));
      client.send(encode({ type: "status", status: this.status }));
      client.send(encode({ type: "alerts", alerts: this.alerts }));
      for (const text of this.frames.values()) client.send(text);
    } catch {
      // Closed before the greeting went out; its close handler has nothing left to detach.
      return detach;
    }
    this.clients.add(client);
    return detach;
  }

  setStatus(patch: Partial<BridgeStatus>): void {
    const next = { ...this.status, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.status)) return;
    this.status = next;
    this.broadcast(encode({ type: "status", status: next }));
  }

  publish<C extends ChannelName>(channel: C, data: Channels[C]): void {
    const text = JSON.stringify({ type: "channel", channel, data });
    this.frames.set(channel, text);
    this.broadcast(text, true);
  }

  raise(alerts: readonly Alert[]): void {
    for (const alert of alerts) {
      this.alerts = [...this.alerts, alert].slice(-MAX_ALERTS);
      this.onAlert?.(alert);
      this.broadcast(encode({ type: "alert", alert }));
    }
  }

  /** Forgets the channel frames of a save the bridge no longer follows. Alerts stay: they are history. */
  clearFrames(): void {
    this.frames.clear();
  }

  private broadcast(text: string, droppable = false): void {
    for (const client of this.clients) {
      if (droppable && (client.bufferedAmount ?? 0) > MAX_BUFFERED_BYTES) continue;
      try {
        client.send(text);
      } catch {
        // A closing socket; its close handler detaches it.
      }
    }
  }
}
