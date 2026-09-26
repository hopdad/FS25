import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderBridgeXml, renderCommandsXml } from "@farmlink/schema";
import { describe, expect, it } from "vitest";
import { collectLive, liveChecks } from "../src/doctorLive";
import { fleetFrame, SAVE_ID, stopEntry, TS, tempRoot, writeSave } from "./fixtures";

const EPOCH = "3b7e1c2a-9d4f-4a6b-8c1e-2f3a4b5c6d7e";
const OTHER_EPOCH = "11111111-2222-4333-8444-555555555555";

function commandsXml(epoch: string, id: number) {
  return renderCommandsXml({
    v: 1,
    epoch,
    commands: [{ v: 1, id, type: "ping", farmId: 1, issuedAt: TS, ttlSec: 30, args: {} }],
  });
}

function acksJson(epoch: string, watermark: number) {
  return {
    v: 1,
    epoch,
    watermark,
    acks: [{ v: 1, id: watermark, status: "ok", message: null, at: TS }],
  };
}

async function checksFor(files: Record<string, unknown>) {
  const saveDir = writeSave(tempRoot(), SAVE_ID, files);
  const live = await collectLive({
    saveDir,
    stateDir: tempRoot(),
    serverPort: null,
    now: Date.now(),
  });
  return { live, byId: Object.fromEntries(liveChecks(live).map((c) => [c.id, c])) };
}

describe("--doctor's P1 checks", () => {
  it("waits for a first command before judging the round trip", async () => {
    const { byId } = await checksFor({ "live_fleet.json": fleetFrame() });
    expect(byId.fleet?.status).toBe("pass");
    expect(byId.farm?.status).toBe("pending");
    expect(byId.commands).toMatchObject({ status: "pending", phase: "P1" });
    expect(byId.heartbeat?.status).toBe("pending");
  });

  it("fails when the mod has not answered the bridge's commands", async () => {
    const { byId } = await checksFor({
      "commands.xml": commandsXml(EPOCH, 5),
      "acks.json": acksJson(OTHER_EPOCH, 9),
    });
    expect(byId.commands?.status).toBe("fail");
    expect(byId.commands?.detail).toMatch(/holds up to id 5 .* answered up to 9 .*P1 mod\?$/);
  });

  it("passes when the acks caught up, and lists the stop reasons", async () => {
    const { byId, live } = await checksFor({
      "commands.xml": commandsXml(EPOCH, 5),
      "acks.json": acksJson(EPOCH, 5),
      "bridge.xml": renderBridgeXml({
        v: 1,
        bridgeVersion: "0.2.0",
        beat: 3,
        realTs: TS,
        features: ["commands"],
      }),
      "live_fleet.json": fleetFrame({ stops: [stopEntry(1, "ERROR_GRAINTANK_IS_FULL")] }),
    });
    expect(byId.commands).toMatchObject({
      status: "pass",
      detail: "the mod answered up to id 5; last: 5 ok",
    });
    expect(byId.heartbeat?.status).toBe("pass");
    expect(byId.fleet?.detail).toMatch(/^0 workers running; stops: ERROR_GRAINTANK_IS_FULL, /);
    expect(live.heartbeat.beat).toBe(3);
  });

  it("reports a damaged file instead of guessing", async () => {
    const saveDir = writeSave(tempRoot(), SAVE_ID);
    writeFileSync(join(saveDir, "commands.xml"), "<nothing/>");
    const live = await collectLive({
      saveDir,
      stateDir: tempRoot(),
      serverPort: null,
      now: Date.now(),
    });
    const commands = liveChecks(live).find((c) => c.id === "commands");
    expect(commands).toMatchObject({
      status: "fail",
      detail: "commands.xml: no <commands> element",
    });
  });
});
