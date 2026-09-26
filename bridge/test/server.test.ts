import { request } from "node:http";
import { type CommandRequest, LiveVehicle, ServerMessage } from "@farmlink/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { type RunningServer, startServer, tokenMatches } from "../src/http/server";
import { LiveHub } from "../src/live/hub";
import { BRIDGE_VERSION } from "../src/version";
import { frame, tractor } from "./fixtures";

const TOKEN = "Zm9vYmFyYmF6cXV4MTIzNA";
const PAGE = "<!doctype html><title>FarmLink</title><p>live</p>";

let running: RunningServer | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function start(
  sendCommand = vi.fn(async (_request: CommandRequest) => ({
    id: 7,
    status: "ok" as const,
    message: null,
  })),
) {
  const hub = new LiveHub();
  running = await startServer({
    hub,
    token: TOKEN,
    page: PAGE,
    sendCommand,
    host: "127.0.0.1",
    port: 0,
  });
  const base = `http://127.0.0.1:${running.port}`;
  return { hub, base, sendCommand, ws: `ws://127.0.0.1:${running.port}` };
}

/** Opens a socket and collects every message, validated against the protocol. */
function connect(url: string) {
  const socket = new WebSocket(url);
  const messages: ServerMessage[] = [];
  socket.on("message", (data) => messages.push(ServerMessage.parse(JSON.parse(String(data)))));
  const opened = new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return { socket, messages, opened };
}

function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("tokenMatches", () => {
  it("accepts only the exact token", () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches(TOKEN, `${TOKEN}x`)).toBe(false);
    expect(tokenMatches(TOKEN, TOKEN.toLowerCase())).toBe(false);
    expect(tokenMatches(TOKEN, "")).toBe(false);
    expect(tokenMatches(TOKEN, null)).toBe(false);
  });
});

describe("the LAN server", () => {
  it("serves the page to anyone, with headers that keep the token private", async () => {
    const { base } = await start();
    const response = await fetch(`${base}/?t=${TOKEN}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(PAGE);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({
      ok: true,
      bridgeVersion: BRIDGE_VERSION,
    });
    expect((await fetch(`${base}/nothing-here`)).status).toBe(404);
  });

  it("refuses a WebSocket without the right token", async () => {
    const { ws } = await start();
    for (const url of [`${ws}/ws`, `${ws}/ws?t=wrong`, `${ws}/elsewhere?t=${TOKEN}`]) {
      const { opened } = connect(url);
      await expect(opened).rejects.toThrow(/Unexpected server response: (401|404)/);
    }
  });

  it("streams the current state, then every change, to a paired page", async () => {
    const { hub, ws } = await start();
    hub.setStatus({ gameOnline: true });
    const page = connect(`${ws}/ws?t=${TOKEN}`);
    await page.opened;
    await vi.waitFor(() => expect(page.messages).toHaveLength(3));
    expect(page.messages.map((m) => m.type)).toEqual(["hello", "status", "alerts"]);
    expect(hub.clientCount).toBe(1);

    hub.publish("vehicle", LiveVehicle.parse(frame(tractor)));
    await vi.waitFor(() => expect(page.messages).toHaveLength(4));
    expect(page.messages[3]).toMatchObject({
      type: "channel",
      channel: "vehicle",
      data: { vehicle: { name: "Fendt 942 Vario" } },
    });

    page.socket.close();
    await vi.waitFor(() => expect(hub.clientCount).toBe(0));
  });

  it("takes a command with the token in a header or the query, and returns the answer", async () => {
    const { base, sendCommand } = await start();
    const command = { type: "worker.stop", farmId: 1, args: { jobId: "9" } };

    const byHeader = await post(`${base}/api/commands`, command, {
      authorization: `Bearer ${TOKEN}`,
    });
    expect(byHeader.status).toBe(200);
    expect(await byHeader.json()).toEqual({ id: 7, status: "ok", message: null });
    expect(sendCommand).toHaveBeenCalledWith(command);

    const byQuery = await post(`${base}/api/commands?t=${TOKEN}`, { type: "ping", farmId: 1 });
    expect(byQuery.status).toBe(200);
    expect(sendCommand).toHaveBeenLastCalledWith({ type: "ping", farmId: 1, args: {} });
  });

  it("refuses unpaired, malformed and oversized command requests without running them", async () => {
    const { base, sendCommand } = await start();
    const url = `${base}/api/commands?t=${TOKEN}`;

    const unpaired = await post(`${base}/api/commands`, { type: "ping", farmId: 1 });
    expect(unpaired.status).toBe(401);
    expect(await unpaired.json()).toMatchObject({ id: null, status: "rejected" });

    const notJson = await post(url, "{ nope");
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toEqual({ id: null, status: "rejected", message: "invalid JSON" });

    const invalid = await post(url, { type: "worker.stop", farmId: 1, args: {} });
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { message: string }).message).toMatch(/^args\.jobId: /);

    const unknown = await post(url, { type: "worker.start", farmId: 1, args: {} });
    expect(unknown.status).toBe(400);

    const huge = await post(url, { type: "ping", farmId: 1, padding: "x".repeat(20_000) });
    expect(huge.status).toBe(413);

    const wrongMethod = await fetch(url);
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("POST");

    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("stops reading a streamed body once it is too large", async () => {
    const { base, sendCommand } = await start();
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(`${base}/api/commands?t=${TOKEN}`, {
        method: "POST",
        headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
      });
      req.on("response", (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("error", reject);
      req.write(`{"type":"ping","farmId":1,"padding":"${"x".repeat(10_000)}`);
      req.write(`${"x".repeat(10_000)}"}`);
      req.end();
    });
    expect(status).toBe(413);
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("reports status and recent alerts to a paired client", async () => {
    const { base, hub } = await start();
    hub.setStatus({ saveName: "Riverbend Springs" });
    expect((await fetch(`${base}/api/status`)).status).toBe(401);
    const response = await fetch(`${base}/api/status`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(await response.json()).toMatchObject({
      status: { saveName: "Riverbend Springs", gameOnline: false },
      alerts: [],
    });
  });

  it("closes open pages when it stops", async () => {
    const { ws } = await start();
    const page = connect(`${ws}/ws?t=${TOKEN}`);
    await page.opened;
    const closed = new Promise<void>((resolve) => page.socket.once("close", () => resolve()));
    await running?.close();
    running = undefined;
    await closed;
  });

  it("explains a port that is already taken", async () => {
    const { base } = await start();
    const port = Number(new URL(base).port);
    await expect(
      startServer({
        hub: new LiveHub(),
        token: TOKEN,
        page: PAGE,
        sendCommand: async () => ({ id: null, status: "rejected", message: null }),
        host: "127.0.0.1",
        port,
      }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
  });
});
