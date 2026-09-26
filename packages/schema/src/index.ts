import { Ack, AckRing, BridgeHeartbeat, Command, CommandsFile, ExportRequest } from "./channel";
import { EventEnvelope } from "./events";
import { LiveFarm, LiveFleet, LiveVehicle } from "./live";
import { Meta } from "./meta";
import { ProbeReport } from "./probe";
import { CommandRequest, CommandResponse, ServerMessage } from "./protocol";

export * from "./channel";
export * from "./events";
export * from "./live";
export * from "./meta";
export * from "./primitives";
export * from "./probe";
export * from "./protocol";
export * from "./reasons";
export * from "./xml";

export const MOD_NAME = "FS25_FarmLink";

/** Written into `meta.json`; bumped together with `Version` on a breaking change. */
export const SCHEMA_VERSION = 1;

/** File names under `modSettings/FS25_FarmLink/<saveId>/` (and `_probe/` for the P0 probe). */
export const FILES = {
  meta: "meta.json",
  liveVehicle: "live_vehicle.json",
  liveFleet: "live_fleet.json",
  liveFarm: "live_farm.json",
  eventsDir: "events",
  commands: "commands.xml",
  acks: "acks.json",
  exportRequest: "export_request.json",
  bridgeHeartbeat: "bridge.xml",
  probeDir: "_probe",
  probe: "probe.json",
} as const;

/** Every top-level file format, keyed by the name its JSON Schema is exported under. */
export const CONTRACTS = {
  "event-envelope": EventEnvelope,
  "live-vehicle": LiveVehicle,
  "live-fleet": LiveFleet,
  "live-farm": LiveFarm,
  meta: Meta,
  command: Command,
  "commands-file": CommandsFile,
  ack: Ack,
  "ack-ring": AckRing,
  "bridge-heartbeat": BridgeHeartbeat,
  "export-request": ExportRequest,
  probe: ProbeReport,
  "server-message": ServerMessage,
  "command-request": CommandRequest,
  "command-response": CommandResponse,
} as const;

export type ContractName = keyof typeof CONTRACTS;
