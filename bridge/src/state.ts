import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Environment } from "./config";

const STATE_FILE = "bridge-state.json";

/** What the bridge keeps between runs: the phone's pairing token and the command numbering. */
export const BridgeStateFile = z.object({
  v: z.literal(1),
  pairingToken: z.string().min(16),
  /** Identifies this installation's command numbering; the mod resets its watermark when it changes. */
  commandEpoch: z.uuid(),
  nextCommandId: z.int().min(1),
});
export type BridgeStateFile = z.infer<typeof BridgeStateFile>;

/** The per-user folder for bridge state: %APPDATA%\FarmLink, Application Support, or ~/.config. */
export function defaultStateDir(environment: Environment): string {
  const { platform, home, env } = environment;
  if (platform === "win32") {
    return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "FarmLink");
  }
  if (platform === "darwin") return join(home, "Library", "Application Support", "FarmLink");
  return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "farmlink");
}

/** Reads bridge-state.json without creating it, for --doctor. */
export function readBridgeState(dir: string): BridgeStateFile | undefined {
  try {
    const parsed = BridgeStateFile.safeParse(
      JSON.parse(readFileSync(join(dir, STATE_FILE), "utf8")),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function newPairingToken(): string {
  return randomBytes(16).toString("base64url");
}

function fresh(): BridgeStateFile {
  return { v: 1, pairingToken: newPairingToken(), commandEpoch: randomUUID(), nextCommandId: 1 };
}

/**
 * Loads, creates and saves `bridge-state.json`. Writes go to a temporary file first and are renamed
 * into place, so a crash mid-write never leaves a half-written state behind.
 */
export class BridgeState {
  private data: BridgeStateFile;
  readonly path: string;
  /** True when this run created the file, i.e. the phone has never been paired with this token. */
  readonly created: boolean;

  constructor(readonly dir: string) {
    this.path = join(dir, STATE_FILE);
    let loaded: BridgeStateFile | undefined;
    try {
      const parsed = BridgeStateFile.safeParse(JSON.parse(readFileSync(this.path, "utf8")));
      if (parsed.success) loaded = parsed.data;
    } catch {
      // missing or unreadable: start fresh
    }
    this.created = loaded === undefined;
    this.data = loaded ?? fresh();
    if (this.created) this.save();
  }

  get pairingToken(): string {
    return this.data.pairingToken;
  }

  get commandEpoch(): string {
    return this.data.commandEpoch;
  }

  /** Hands out the next command id and persists the counter before the id is used. */
  nextCommandId(): number {
    const id = this.data.nextCommandId;
    this.data = { ...this.data, nextCommandId: id + 1 };
    this.save();
    return id;
  }

  /**
   * Moves the counter past an id the mod has already processed in this epoch. That happens when an
   * older copy of this file comes back, for example from a backup; without it the mod would ignore
   * every command until the counter caught up with its watermark.
   */
  skipPast(id: number): boolean {
    if (id < this.data.nextCommandId) return false;
    this.data = { ...this.data, nextCommandId: id + 1 };
    this.save();
    return true;
  }

  resetPairingToken(): string {
    this.data = { ...this.data, pairingToken: newPairingToken() };
    this.save();
    return this.data.pairingToken;
  }

  private save(): void {
    mkdirSync(this.dir, { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}
