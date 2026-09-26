import { join } from "node:path";
import {
  type AckRing,
  Command,
  CommandRequest,
  type CommandResponse,
  FILES,
  renderCommandsXml,
} from "@farmlink/schema";
import { writeFileAtomic } from "../fsutil";
import { localIsoWithOffset } from "../time";

/** How long a command may wait for the game before it expires. */
export const DEFAULT_TTL_SEC = 30;
/** Recent commands kept in commands.xml, so writing one never drops another the mod has not read. */
const RING_SIZE = 20;
/** How long past the TTL to wait for a late ack; the mod reads commands.xml every 500 ms. */
const GRACE_MS = 2000;

/** The part of BridgeState that numbers commands. */
export interface CommandNumbering {
  readonly commandEpoch: string;
  nextCommandId(): number;
  skipPast(id: number): boolean;
}

export interface CommandWriterOptions {
  saveDir: string;
  numbering: CommandNumbering;
  ttlSec?: number;
  graceMs?: number;
  now?: () => Date;
  write?: (path: string, text: string) => Promise<unknown>;
}

interface Pending {
  resolve: (response: CommandResponse) => void;
  timer: NodeJS.Timeout;
}

/**
 * The bridge's half of the command channel: numbers each command, rewrites `commands.xml` with the
 * ring of recent commands, and settles each command from the mod's `acks.json`. The page gets the
 * mod's answer or `expired`, never an assumed success.
 */
export class CommandWriter {
  readonly path: string;
  private ring: Command[] = [];
  /** Ids in commands.xml as last written: a command counts as sent once a write included it. */
  private written = new Set<number>();
  private readonly pending = new Map<number, Pending>();
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: CommandWriterOptions) {
    this.path = join(options.saveDir, FILES.commands);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Numbers the command, writes it, and resolves with the mod's ack. Never rejects. */
  send(request: CommandRequest): Promise<CommandResponse> {
    if (this.closed) {
      return Promise.resolve({ id: null, status: "rejected", message: "the save was closed" });
    }
    const parsed = CommandRequest.parse(request);
    const ttlSec = this.options.ttlSec ?? DEFAULT_TTL_SEC;
    const id = this.options.numbering.nextCommandId();
    const command = Command.parse({
      v: 1,
      id,
      issuedAt: localIsoWithOffset((this.options.now ?? (() => new Date()))()),
      ttlSec,
      farmId: parsed.farmId,
      type: parsed.type,
      args: parsed.args,
    });
    const answer = new Promise<CommandResponse>((resolve) => {
      const timer = setTimeout(
        () =>
          this.settle(id, {
            id,
            status: "expired",
            message: `no answer from the game within ${ttlSec} s`,
          }),
        ttlSec * 1000 + (this.options.graceMs ?? GRACE_MS),
      );
      this.pending.set(id, { resolve, timer });
    });
    this.ring = [...this.ring, command].slice(-RING_SIZE);
    this.queue = this.queue.then(() => this.deliver(id));
    return answer;
  }

  /** Writes the ring for one command, unless an earlier write already carried it. */
  private async deliver(id: number): Promise<void> {
    if (!this.pending.has(id) || this.written.has(id)) return;
    const snapshot = this.ring;
    if (!snapshot.some((c) => c.id === id)) {
      this.settle(id, {
        id,
        status: "error",
        message: "too many commands at once: this one left the queue before it was written",
      });
      return;
    }
    const text = renderCommandsXml({
      v: 1,
      epoch: this.options.numbering.commandEpoch,
      commands: snapshot,
    });
    try {
      await (this.options.write ?? writeFileAtomic)(this.path, text);
      this.written = new Set(snapshot.map((c) => c.id));
    } catch (error) {
      // Take it out again, so a later write cannot deliver a command the page was told failed.
      this.ring = this.ring.filter((c) => c.id !== id);
      this.settle(id, {
        id,
        status: "error",
        message: `could not write commands.xml: ${(error as Error).message}`,
      });
    }
  }

  /** Settles pending commands from the mod's ack ring. */
  onAcks(ring: AckRing): void {
    if (ring.epoch !== this.options.numbering.commandEpoch) return;
    this.options.numbering.skipPast(ring.watermark);
    for (const ack of ring.acks) {
      this.settle(ack.id, { id: ack.id, status: ack.status, message: ack.message });
    }
    for (const id of [...this.pending.keys()]) {
      if (id <= ring.watermark) {
        this.settle(id, {
          id,
          status: "error",
          message: "the game processed this command, but its answer was overwritten",
        });
      }
    }
  }

  /** Answers everything still waiting; later sends are rejected. */
  close(reason = "the bridge stopped following this save"): void {
    this.closed = true;
    for (const id of [...this.pending.keys()]) {
      this.settle(id, { id, status: "error", message: reason });
    }
  }

  private settle(id: number, response: CommandResponse): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.resolve(response);
  }
}
