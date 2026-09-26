import { mkdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listSaves, pickSave } from "../src/watch/saves";
import { frame, meta, tempRoot, writeSave } from "./fixtures";

const OTHER = "0b8f6c1e-2d3a-4b5c-9d8e-7f6a5b4c3d2e";

describe("listSaves", () => {
  it("lists only saveId folders, most recently active first", async () => {
    const root = tempRoot();
    const older = writeSave(root, OTHER, { "meta.json": meta({ saveId: OTHER }) });
    writeSave(root, undefined, { "meta.json": meta(), "live_vehicle.json": frame() });
    mkdirSync(join(root, "_probe"));
    const past = new Date(Date.now() - 3600_000);
    utimesSync(join(older, "meta.json"), past, past);

    const saves = await listSaves(root);
    expect(saves.map((s) => s.saveId)).toEqual(["6f1c2d3e-4a5b-4c6d-8e7f-0123456789ab", OTHER]);
    expect(saves[0]?.meta?.saveName).toBe("Riverbend Springs");
    expect(saves[0]?.liveMtimeMs).toBeTypeOf("number");
  });

  it("keeps a save whose meta.json is invalid and says why", async () => {
    const root = tempRoot();
    writeSave(root, undefined, { "meta.json": meta({ mode: "arcade" }) });
    const [save] = await listSaves(root);
    expect(save?.meta).toBeUndefined();
    expect(save?.metaError).toMatch(/^mode:/);
  });

  it("returns nothing for a folder that does not exist", async () => {
    expect(await listSaves(join(tempRoot(), "missing"))).toEqual([]);
  });
});

describe("pickSave", () => {
  it("follows a named save even when another one is more recent", async () => {
    const root = tempRoot();
    writeSave(root, OTHER, { "meta.json": meta({ saveId: OTHER }) });
    writeSave(root, undefined, { "meta.json": meta() });
    expect((await pickSave(root, OTHER))?.saveId).toBe(OTHER);
    expect(await pickSave(root, "00000000-0000-4000-8000-000000000000")).toBeUndefined();
  });
});
