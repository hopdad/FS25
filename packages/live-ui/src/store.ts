import type {
  ActiveJob,
  Alert,
  BridgeStatus,
  FarmState,
  FleetVehicle,
  LiveFarm,
  LiveFleet,
  LiveVehicle,
  ServerMessage,
  WorkerStopEntry,
} from "@farmlink/schema";
import { isAiController } from "./format";

/** Where the page stands with the bridge. */
export type Connection = "connecting" | "open" | "reconnecting" | "unreachable" | "unpaired";

export interface LiveState {
  connection: Connection;
  status: BridgeStatus | null;
  vehicle: LiveVehicle | null;
  fleet: LiveFleet | null;
  farm: LiveFarm | null;
  /** Recent alerts, oldest first. */
  alerts: Alert[];
  /** Alerts to pop up: the ones raised while the page was watching, or just before. */
  toasts: Alert[];
}

export const MAX_ALERTS = 50;
/** An alert the page first hears of on connecting still pops up if it is this recent. */
export const TOAST_REPLAY_MS = 120_000;

export type LiveAction =
  | { type: "message"; message: ServerMessage; at: number }
  | { type: "connection"; connection: Connection }
  | { type: "dismiss"; id: string };

export function initialState(): LiveState {
  return {
    connection: "connecting",
    status: null,
    vehicle: null,
    fleet: null,
    farm: null,
    alerts: [],
    toasts: [],
  };
}

export function reduce(state: LiveState, action: LiveAction): LiveState {
  switch (action.type) {
    case "connection":
      return state.connection === action.connection
        ? state
        : { ...state, connection: action.connection };
    case "dismiss":
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) };
    case "message":
      return receive(state, action.message, action.at);
  }
}

function receive(state: LiveState, message: ServerMessage, now: number): LiveState {
  switch (message.type) {
    case "hello":
      return state;
    case "status": {
      // Another save: nothing of the old one may linger while the new one's frames arrive.
      const otherSave = state.status !== null && state.status.saveId !== message.status.saveId;
      return otherSave
        ? {
            ...state,
            status: message.status,
            vehicle: null,
            fleet: null,
            farm: null,
            alerts: [],
            toasts: [],
          }
        : { ...state, status: message.status };
    }
    case "channel":
      if (message.channel === "vehicle") return { ...state, vehicle: message.data };
      if (message.channel === "fleet") return { ...state, fleet: message.data };
      return { ...state, farm: message.data };
    case "alert":
      return addAlerts(state, [message.alert], now, true);
    case "alerts":
      return addAlerts(state, message.alerts, now, false);
  }
}

function addAlerts(state: LiveState, incoming: Alert[], now: number, live: boolean): LiveState {
  const known = new Set(state.alerts.map((a) => a.id));
  const fresh = incoming.filter((a) => !known.has(a.id));
  if (fresh.length === 0) return state;
  const alerts = [...state.alerts, ...fresh]
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-MAX_ALERTS);
  const popping = fresh.filter((a) => live || now - Date.parse(a.at) <= TOAST_REPLAY_MS);
  return { ...state, alerts, toasts: [...state.toasts, ...popping] };
}

export interface FarmChoice {
  farmId: number;
  name: string;
}

/** The farms in the save, from live_farm.json, or else from who owns the machines. */
export function farmChoices(state: LiveState): FarmChoice[] {
  const farms = state.farm?.farm.farms ?? [];
  if (farms.length > 0) {
    return farms
      .map((f) => ({ farmId: f.farmId, name: f.name }))
      .sort((a, b) => a.farmId - b.farmId);
  }
  const ids = new Set(state.fleet?.fleet.vehicles.map((v) => v.farmId) ?? []);
  return [...ids].sort((a, b) => a - b).map((farmId) => ({ farmId, name: `Farm ${farmId}` }));
}

/** The farm of the machine the player sits in, or else the first farm. */
export function defaultFarmId(state: LiveState): number | undefined {
  const current = state.vehicle?.vehicle?.vehicleId;
  const row = current
    ? state.fleet?.fleet.vehicles.find((v) => v.vehicleId === current)
    : undefined;
  return row?.farmId ?? farmChoices(state)[0]?.farmId;
}

const CONTROLLER_ORDER: Record<FleetVehicle["controller"], number> = {
  ai: 0,
  courseplay: 0,
  autodrive: 0,
  player: 1,
  idle: 2,
};

export interface FarmView {
  jobs: ActiveJob[];
  /** Newest first. */
  stops: WorkerStopEntry[];
  /** Machines that are not attached to another one: AI-driven first, then the player's, then parked. */
  machines: FleetVehicle[];
  /** Vehicle names by id, across every farm. */
  names: Map<string, string>;
  /** Newest first. */
  alerts: Alert[];
  toasts: Alert[];
  farm: FarmState | null;
}

/** What the page shows for one farm. Alerts without a farm are shown on every farm. */
export function farmView(state: LiveState, farmId: number | undefined): FarmView {
  const mine = (id: number | null) => farmId === undefined || id === null || id === farmId;
  const fleet = state.fleet?.fleet;
  const machines = (fleet?.vehicles ?? [])
    .filter((v) => mine(v.farmId) && v.attachedTo === null)
    .sort(
      (a, b) =>
        CONTROLLER_ORDER[a.controller] - CONTROLLER_ORDER[b.controller] ||
        a.name.localeCompare(b.name),
    );
  const farms = state.farm?.farm.farms ?? [];
  return {
    jobs: (fleet?.jobs ?? []).filter((j) => mine(j.farmId)),
    stops: (fleet?.stops ?? []).filter((s) => mine(s.farmId)).reverse(),
    machines,
    names: new Map((fleet?.vehicles ?? []).map((v) => [v.vehicleId, v.name])),
    alerts: state.alerts.filter((a) => mine(a.farmId)).reverse(),
    toasts: state.toasts.filter((a) => mine(a.farmId)),
    farm: farms.find((f) => f.farmId === farmId) ?? farms[0] ?? null,
  };
}

/** The newest in-game time any channel reported. */
export function gameTime(state: LiveState): { day: number; minute: number } | null {
  const headers = [state.vehicle, state.fleet, state.farm].filter((h) => h !== null);
  if (headers.length === 0) return null;
  const latest = headers.reduce((a, b) =>
    b.day * 1440 + b.minute > a.day * 1440 + a.minute ? b : a,
  );
  return { day: latest.day, minute: latest.minute };
}

/** How many machines the AI is driving right now. */
export function aiCount(view: FarmView): number {
  return view.machines.filter((m) => isAiController(m.controller)).length;
}
