import { type Alert, LiveVehicle, ServerMessage } from "@farmlink/schema";
import { describe, expect, it } from "vitest";
import { type HubClient, LiveHub } from "../src/live/hub";
import { BRIDGE_VERSION } from "../src/version";
import { frame, SAVE_ID, tractor } from "./fixtures";

function client(bufferedAmount = 0) {
  const messages: ServerMessage[] = [];
  const c: HubClient & { messages: ServerMessage[]; bufferedAmount: number } = {
    messages,
    bufferedAmount,
    send: (text) => messages.push(ServerMessage.parse(JSON.parse(text))),
  };
  return c;
}

const types = (messages: ServerMessage[]) =>
  messages.map((m) => (m.type === "channel" ? `channel:${m.channel}` : m.type));

function alert(n: number): Alert {
  return {
    id: `stop:x:${n}`,
    kind: "worker_stop",
    severity: "critical",
    title: "Worker stopped",
    message: `stop ${n}`,
    vehicleId: null,
    jobId: null,
    farmId: 1,
    at: "2026-09-26T15:05:00.000Z",
  };
}

describe("LiveHub", () => {
  it("greets a new page with the status, recent alerts and the latest frames", () => {
    const hub = new LiveHub();
    hub.setStatus({ saveId: SAVE_ID, gameOnline: true });
    hub.raise([alert(1)]);
    hub.publish("vehicle", LiveVehicle.parse(frame(tractor)));

    const page = client();
    hub.attach(page);
    expect(types(page.messages)).toEqual(["hello", "status", "alerts", "channel:vehicle"]);
    expect(page.messages[0]).toEqual({ type: "hello", bridgeVersion: BRIDGE_VERSION });
    expect(page.messages[1]).toMatchObject({ status: { saveId: SAVE_ID, gameOnline: true } });
    expect(page.messages[2]).toEqual({ type: "alerts", alerts: [alert(1)] });
  });

  it("pushes changes to every page, and only real status changes", () => {
    const hub = new LiveHub();
    const a = client();
    const b = client();
    hub.attach(a);
    const detachB = hub.attach(b);
    a.messages.length = 0;
    b.messages.length = 0;

    hub.setStatus({ gameOnline: false });
    hub.setStatus({ gameOnline: true });
    hub.publish("vehicle", LiveVehicle.parse(frame(null)));
    detachB();
    hub.raise([alert(2)]);

    expect(types(a.messages)).toEqual(["status", "channel:vehicle", "alert"]);
    expect(types(b.messages)).toEqual(["status", "channel:vehicle"]);
    expect(hub.clientCount).toBe(1);
  });

  it("lets a page that falls behind skip frames, but not alerts", () => {
    const hub = new LiveHub();
    const slow = client(5_000_000);
    hub.attach(slow);
    slow.messages.length = 0;
    hub.publish("vehicle", LiveVehicle.parse(frame(null)));
    hub.raise([alert(3)]);
    expect(types(slow.messages)).toEqual(["alert"]);
  });

  it("keeps the 50 most recent alerts and reports each one", () => {
    const seen: string[] = [];
    const hub = new LiveHub((a) => seen.push(a.id));
    hub.raise(Array.from({ length: 60 }, (_, i) => alert(i)));
    expect(hub.recentAlerts).toHaveLength(50);
    expect(hub.recentAlerts[0]?.id).toBe("stop:x:10");
    expect(seen).toHaveLength(60);
  });

  it("forgets the frames of a save it stopped following", () => {
    const hub = new LiveHub();
    hub.publish("vehicle", LiveVehicle.parse(frame(null)));
    hub.clearFrames();
    const page = client();
    hub.attach(page);
    expect(types(page.messages)).toEqual(["hello", "status", "alerts"]);
  });

  it("keeps serving the other pages when one send fails", () => {
    const hub = new LiveHub();
    let open = true;
    const flaky: HubClient = {
      send: () => {
        if (!open) throw new Error("socket closed");
      },
    };
    const closed: HubClient = {
      send: () => {
        throw new Error("socket closed");
      },
    };
    const ok = client();
    hub.attach(flaky);
    hub.attach(closed);
    hub.attach(ok);
    expect(hub.clientCount).toBe(2);
    open = false;
    hub.raise([alert(4)]);
    expect(types(ok.messages).at(-1)).toBe("alert");
  });
});
