// Runs the mod's real Lua against the engine stub (mod/sim/run.lua) and checks what it writes
// against the contracts: with Zod, with the exported JSON Schema, and through --doctor. Skipped
// when no Lua 5.1 interpreter is installed; CI installs one.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AckRing,
  LiveFarm,
  LiveFleet,
  LiveVehicle,
  Meta,
  ProbeReport,
  parseCommandsXml,
} from "@farmlink/schema";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { CommandWriter } from "../src/commands/writer";
import { runDoctor } from "../src/doctor";
import { AlertEngine } from "../src/live/alerts";
import { BridgeState } from "../src/state";
import { tempRoot } from "./fixtures";

const repo = fileURLToPath(new URL("../../", import.meta.url));

function findLua51(): string | undefined {
  for (const command of ["lua5.1", "lua"]) {
    const result = spawnSync(command, ["-v"], { encoding: "utf8" });
    if (result.status === 0 && `${result.stdout}${result.stderr}`.includes("Lua 5.1")) {
      return command;
    }
  }
  return undefined;
}

const lua = findLua51();
if (!lua && process.env.REQUIRE_LUA) {
  throw new Error("REQUIRE_LUA is set, but no Lua 5.1 interpreter was found");
}

interface SimSummary {
  saveId: string;
  baseDir: string;
  saveDir: string;
  savegameDirectory: string;
  activeJobs: number;
  commandWatermark: number;
}

/** Runs mod/sim/run.lua and returns the JSON summary it prints last. */
function simulate(profile: string, args: string[]): SimSummary {
  const stdout = execFileSync(lua as string, [join(repo, "mod/sim/run.lua"), profile, ...args], {
    encoding: "utf8",
  });
  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
}

describe.skipIf(!lua)("the mod's files, produced by its Lua", () => {
  let profile: string;
  let saveDir: string;
  let baseDir: string;

  beforeAll(() => {
    profile = tempRoot();
    const summary = simulate(profile, ["3"]);
    saveDir = summary.saveDir;
    baseDir = summary.baseDir;
  });

  const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));

  it("match the Zod contracts", () => {
    expect(Meta.parse(read(join(saveDir, "meta.json"))).mode).toBe("singleplayer");
    const live = LiveVehicle.parse(read(join(saveDir, "live_vehicle.json")));
    expect(live.vehicle?.name).toBe("Fendt 942 Vario");
    expect(live.vehicle?.implements[0]?.fillUnits[0]).toEqual({
      fillType: "SEEDS",
      level: 2100,
      capacity: 3600,
    });
    expect(ProbeReport.parse(read(join(baseDir, "_probe", "probe.json"))).v).toBe(1);
    const fleet = LiveFleet.parse(read(join(saveDir, "live_fleet.json")));
    expect(fleet.fleet.jobs.map((j) => j.helper)).toEqual(["Alex"]);
    expect(fleet.fleet.stops).toMatchObject([{ helper: "Sam", reason: "ERROR_OUT_OF_FUEL" }]);
    expect(LiveFarm.parse(read(join(saveDir, "live_farm.json"))).farm.farms).toHaveLength(1);
  });

  it("give the bridge the alerts P1 promises", () => {
    const fleet = LiveFleet.parse(read(join(saveDir, "live_fleet.json")));
    const alerts = new AlertEngine().onFleet(fleet, Date.now());
    expect(alerts.map((a) => [a.kind, a.message])).toEqual([
      ["worker_stop", "Sam on Fendt 942 Vario: out of fuel"],
      ["fuel_low", "Claas Lexion 8900: 3 % fuel left, driven by Alex"],
    ]);
  });

  it("match the exported JSON Schema", () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    const schemaDir = join(repo, "packages/schema/json-schema");
    const check = (schemaFile: string, dataFile: string) => {
      const validate = ajv.compile(read(join(schemaDir, schemaFile)));
      const ok = validate(read(dataFile));
      expect(validate.errors ?? [], `${dataFile} against ${schemaFile}`).toEqual([]);
      expect(ok).toBe(true);
    };
    check("meta.schema.json", join(saveDir, "meta.json"));
    check("live-vehicle.schema.json", join(saveDir, "live_vehicle.json"));
    check("probe.schema.json", join(baseDir, "_probe", "probe.json"));
    check("live-fleet.schema.json", join(saveDir, "live_fleet.json"));
    check("live-farm.schema.json", join(saveDir, "live_farm.json"));
  });

  it("keep the ledger identity in the savegame", () => {
    const savegames = readdirSync(profile).filter((name) => name.startsWith("savegame"));
    expect(savegames).toEqual(["savegame3"]);
    expect(existsSync(join(profile, "savegame3", "farmLink.xml"))).toBe(true);
  });

  it("let --doctor answer every probe item from the simulated session", async () => {
    const report = await runDoctor({
      environment: { platform: "linux", home: "/nonexistent", env: {} },
      dir: profile,
      observeMs: 0,
      stateDir: tempRoot(),
      serverPort: null,
    });
    const status = Object.fromEntries(report.checks.map((c) => [c.id, c.status]));
    expect(status).toEqual({
      loaded: "pass",
      updates: "pending",
      cost: "pass",
      item1: "pass",
      item2: "pass",
      item3: "pass",
      item4: "pass",
      item5: "pass",
      item6: "pass",
      item7: "pass",
      item9: "pass",
      fleet: "pass",
      farm: "pass",
      commands: "pending",
      heartbeat: "pending",
      server: "pending",
    });
    expect(report.live.fleet.stops).toMatchObject([{ helper: "Sam", reason: "ERROR_OUT_OF_FUEL" }]);
  });
});

describe.skipIf(!lua)("a worker stop sent by the bridge and run by the mod's Lua", () => {
  it("stops the worker, answers ok, and does not alert on the player's own stop", async () => {
    const profile = tempRoot();
    const first = simulate(profile, ["3"]);
    const state = new BridgeState(tempRoot());
    const writer = new CommandWriter({ saveDir: first.saveDir, numbering: state });

    // The resumed session hires a worker that gets job id 1.
    const answer = writer.send({ type: "worker.stop", farmId: 1, args: { jobId: "1" } });
    const commandsPath = join(first.saveDir, "commands.xml");
    await vi.waitFor(() => expect(existsSync(commandsPath)).toBe(true));
    expect(parseCommandsXml(readFileSync(commandsPath, "utf8")).epoch).toBe(state.commandEpoch);

    const second = simulate(profile, ["2", "--resume", first.savegameDirectory]);
    expect(second.saveId).toBe(first.saveId);
    expect(second.activeJobs).toBe(0);
    expect(second.commandWatermark).toBe(1);

    const ring = AckRing.parse(JSON.parse(readFileSync(join(second.saveDir, "acks.json"), "utf8")));
    expect(ring).toMatchObject({ epoch: state.commandEpoch, watermark: 1 });
    writer.onAcks(ring);
    expect(await answer).toEqual({ id: 1, status: "ok", message: null });

    const fleet = LiveFleet.parse(
      JSON.parse(readFileSync(join(second.saveDir, "live_fleet.json"), "utf8")),
    );
    expect(fleet.fleet.stops).toMatchObject([
      { jobId: "1", helper: "Alex", reason: "SUCCESS_STOPPED_BY_USER" },
    ]);
    const alerts = new AlertEngine().onFleet(fleet, Date.now());
    expect(alerts.filter((a) => a.kind === "worker_stop")).toEqual([]);

    // --doctor sees the round trip.
    const report = await runDoctor({
      environment: { platform: "linux", home: "/nonexistent", env: {} },
      dir: profile,
      observeMs: 0,
      stateDir: state.dir,
      serverPort: null,
    });
    const commands = report.checks.find((c) => c.id === "commands");
    expect(commands).toMatchObject({ status: "pass", phase: "P1" });
    expect(commands?.detail).toBe("the mod answered up to id 1; last: 1 ok");
    expect(report.live.bridgeState).toMatchObject({
      commandEpoch: state.commandEpoch,
      nextCommandId: 2,
    });
    expect(JSON.stringify(report)).not.toContain(state.pairingToken);
  });
});
