// Runs the mod's real Lua against the engine stub (mod/sim/run.lua) and checks what it writes
// against the contracts: with Zod, with the exported JSON Schema, and through --doctor. Skipped
// when no Lua 5.1 interpreter is installed; CI installs one.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LiveVehicle, Meta, ProbeReport } from "@farmlink/schema";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { beforeAll, describe, expect, it } from "vitest";
import { runDoctor } from "../src/doctor";
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

describe.skipIf(!lua)("the mod's files, produced by its Lua", () => {
  let profile: string;
  let saveDir: string;
  let baseDir: string;

  beforeAll(() => {
    profile = tempRoot();
    const stdout = execFileSync(lua as string, [join(repo, "mod/sim/run.lua"), profile, "3"], {
      encoding: "utf8",
    });
    const summary = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
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
    });
  });
});
