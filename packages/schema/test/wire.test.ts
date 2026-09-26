import { describe, expect, it } from "vitest";
import {
  AckRing,
  CommandRequest,
  CommandResponse,
  parseBridgeXml,
  parseCommandsXml,
  renderBridgeXml,
  renderCommandsXml,
  ServerMessage,
} from "../src/index";

const EPOCH = "3b7e1c2a-9d4f-4a6b-8c1e-2f3a4b5c6d7e";
const TS = "2026-09-26T11:04:05-04:00";

const stop = {
  v: 1 as const,
  id: 57,
  issuedAt: TS,
  ttlSec: 30,
  farmId: 1,
  type: "worker.stop" as const,
  args: { jobId: "9" },
};

describe("commands.xml", () => {
  it("writes each command as one element with its args beside the envelope", () => {
    const xml = renderCommandsXml({ v: 1, epoch: EPOCH, commands: [stop] });
    expect(xml).toBe(
      [
        '<?xml version="1.0" encoding="utf-8" standalone="no" ?>',
        `<commands v="1" epoch="${EPOCH}">`,
        `    <command id="57" type="worker.stop" farmId="1" issuedAt="${TS}" ttlSec="30" jobId="9"/>`,
        "</commands>",
        "",
      ].join("\n"),
    );
  });

  it("round-trips, including characters XML must escape", () => {
    const tricky = { ...stop, id: 58, args: { jobId: `a"<&>'b` } };
    const file = { v: 1 as const, epoch: EPOCH, commands: [stop, tricky] };
    const xml = renderCommandsXml(file);
    expect(xml).toContain('jobId="a&quot;&lt;&amp;&gt;&apos;b"');
    expect(parseCommandsXml(xml)).toEqual(file);
  });

  it("writes an empty ring as a bare root element", () => {
    const xml = renderCommandsXml({ v: 1, epoch: EPOCH, commands: [] });
    expect(parseCommandsXml(xml).commands).toEqual([]);
  });

  it("refuses an invalid command rather than writing it", () => {
    const bad = { ...stop, args: {} } as unknown as typeof stop;
    expect(() => renderCommandsXml({ v: 1, epoch: EPOCH, commands: [bad] })).toThrow();
  });
});

describe("bridge.xml", () => {
  it("round-trips the heartbeat", () => {
    const heartbeat = {
      v: 1 as const,
      bridgeVersion: "0.2.0",
      beat: 12,
      realTs: TS,
      features: ["commands" as const],
    };
    const xml = renderBridgeXml(heartbeat);
    expect(xml).toContain('<bridge v="1" version="0.2.0" beat="12"');
    expect(parseBridgeXml(xml)).toEqual(heartbeat);
  });
});

describe("acks.json", () => {
  it("accepts the ring the mod writes, and an empty one before any command", () => {
    expect(
      AckRing.safeParse({
        v: 1,
        epoch: EPOCH,
        watermark: 57,
        acks: [{ v: 1, id: 57, status: "ok", message: null, at: TS }],
      }).success,
    ).toBe(true);
    expect(AckRing.safeParse({ v: 1, epoch: null, watermark: 0, acks: [] }).success).toBe(true);
  });
});

describe("LAN protocol", () => {
  it("accepts a stop request from the page, and fills in ping's empty args", () => {
    expect(
      CommandRequest.parse({ type: "worker.stop", farmId: 1, args: { jobId: "9" } }).args,
    ).toEqual({ jobId: "9" });
    expect(CommandRequest.parse({ type: "ping", farmId: 1 }).args).toEqual({});
    expect(CommandRequest.safeParse({ type: "worker.start", farmId: 1, args: {} }).success).toBe(
      false,
    );
  });

  it("describes the messages the page receives", () => {
    const alert = {
      type: "alert",
      alert: {
        id: "stop:abc:3",
        kind: "worker_stop",
        severity: "critical",
        title: "Worker stopped",
        message: "Alex on Claas Lexion 8900: out of fuel",
        vehicleId: "v14",
        jobId: "9",
        at: "2026-09-26T15:04:06.120Z",
      },
    };
    expect(ServerMessage.safeParse(alert).success).toBe(true);
    expect(ServerMessage.safeParse({ type: "hello", bridgeVersion: "0.2.0" }).success).toBe(true);
    expect(ServerMessage.safeParse({ type: "channel", channel: "fleet", data: {} }).success).toBe(
      false,
    );
    expect(
      CommandResponse.safeParse({ id: null, status: "expired", message: "no answer" }).success,
    ).toBe(true);
  });
});
