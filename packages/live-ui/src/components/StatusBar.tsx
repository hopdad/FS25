import type { BridgeStatus, SyncSummary } from "@farmlink/schema";
import type { Connection, FarmChoice } from "../store";

type Tone = "ok" | "warn" | "bad" | "wait";

/** The connection and the game in a few words, with a colour. */
export function describeConnection(
  connection: Connection,
  status: BridgeStatus | null,
): { tone: Tone; text: string } {
  switch (connection) {
    case "unpaired":
      return { tone: "bad", text: "Link out of date" };
    case "unreachable":
      return { tone: "bad", text: "Bridge not reachable" };
    case "connecting":
      return { tone: "wait", text: "Connecting…" };
    case "reconnecting":
      return { tone: "wait", text: "Reconnecting…" };
    case "open":
      if (status?.gameOnline) return { tone: "ok", text: "Live" };
      return { tone: "warn", text: status?.saveId ? "Game offline" : "Waiting for the game" };
  }
}

/** Events waiting beyond this many mean the sync is catching up, not just between batches. */
const BACKLOG = 200;

/** The Supabase sync in a word or two, or null while the bridge does not sync. */
export function describeSync(
  sync: SyncSummary | null | undefined,
): { tone: Tone; text: string } | null {
  if (!sync) return null;
  switch (sync.state) {
    case "blocked":
      return { tone: "bad", text: "Sync stopped" };
    case "retrying":
      return { tone: "warn", text: "Sync retrying" };
    case "waiting":
      return { tone: "wait", text: "Sync starting" };
    case "sending":
      if (sync.queued > BACKLOG) {
        return { tone: "wait", text: `Syncing ${sync.queued.toLocaleString("en-US")} events` };
      }
      return { tone: "ok", text: "Synced" };
    case "synced":
      return { tone: "ok", text: "Synced" };
  }
}

export interface StatusBarProps {
  connection: Connection;
  status: BridgeStatus | null;
  /** In-game clock, for example `Day 37 · 14:05`. */
  clock: string | null;
  farms: FarmChoice[];
  farmId: number | undefined;
  onFarm: (farmId: number) => void;
}

/** Sticky header: connection state, save, game clock, and a farm picker in multiplayer. */
export function StatusBar({ connection, status, clock, farms, farmId, onFarm }: StatusBarProps) {
  const { tone, text } = describeConnection(connection, status);
  const sync = describeSync(status?.sync);
  return (
    <header className="status">
      <div className="status-line">
        <span className={`dot ${tone}`} aria-hidden="true" />
        <span className="status-text" role="status">
          {text}
        </span>
        {clock && <span className="clock">{clock}</span>}
      </div>
      <div className="status-line sub">
        <span className="save">
          {status?.saveName ?? (status?.saveId ? "Unnamed save" : "No save")}
        </span>
        {sync && (
          <span className="sync" title={status?.sync?.message ?? undefined}>
            <span className={`dot small ${sync.tone}`} aria-hidden="true" />
            {sync.text}
          </span>
        )}
        {farms.length > 1 && (
          <select
            aria-label="Farm"
            value={farmId === undefined ? "" : String(farmId)}
            onChange={(event) => onFarm(Number(event.currentTarget.value))}
          >
            {farms.map((farm) => (
              <option key={farm.farmId} value={String(farm.farmId)}>
                {farm.name}
              </option>
            ))}
          </select>
        )}
      </div>
    </header>
  );
}

/** What to do about a connection problem, or null when there is none. */
export function ConnectionHelp({ connection }: { connection: Connection }) {
  if (connection === "unpaired") {
    return (
      <p className="banner bad">
        This link is out of date: the bridge has a new pairing code. Open the link or scan the QR
        code shown in the bridge window again.
      </p>
    );
  }
  if (connection === "unreachable") {
    return (
      <p className="banner bad">
        Cannot reach the bridge. Check that it is running on your computer and that this phone is on
        the same Wi-Fi. On Windows, allow farmlink-bridge through the firewall for private networks.
      </p>
    );
  }
  return null;
}

/** What the player should know about the sync: it stopped, or the mod's log skipped events. */
export function SyncHelp({ sync }: { sync: SyncSummary | null | undefined }) {
  if (!sync) return null;
  return (
    <>
      {sync.state === "blocked" && (
        <p className="banner warn">
          Syncing to your FarmLink account stopped: {sync.message ?? "unknown reason"}. Your farm's
          history stays on this computer and is sent once this is fixed.
        </p>
      )}
      {sync.gaps > 0 && (
        <p className="banner warn">
          The mod's event log skipped {sync.gaps.toLocaleString("en-US")}{" "}
          {sync.gaps === 1 ? "event" : "events"}, so your history is missing them. The bridge log
          says where.
        </p>
      )}
    </>
  );
}
