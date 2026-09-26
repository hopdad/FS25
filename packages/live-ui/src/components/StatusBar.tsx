import type { BridgeStatus } from "@farmlink/schema";
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
