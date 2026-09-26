import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { CommandRequest, type CommandResponse, LIVE_PORT } from "@farmlink/schema";
import { type WebSocket, WebSocketServer } from "ws";
import type { LiveHub } from "../live/hub";
import { BRIDGE_VERSION } from "../version";
import { describeIssue } from "../watch/files";

export interface ServerOptions {
  hub: LiveHub;
  /** The pairing token every WebSocket and API request must carry. */
  token: string;
  /** The phone page's HTML. */
  page: string;
  sendCommand: (request: CommandRequest) => Promise<CommandResponse>;
  /** Defaults to every interface, so a phone on the same network can connect. */
  host?: string;
  port?: number;
  /** How often to ping each page; one that misses a pong by the next ping is dropped. */
  pingMs?: number;
  /** How often to repeat the status to every page, which pages use to spot a dead connection. */
  statusRepeatMs?: number;
  log?: (line: string) => void;
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 16 * 1024;

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  // The page's URL carries the token; never send it anywhere as a referrer.
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "content-security-policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; " +
    "connect-src 'self' ws: wss:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Compares in constant time, so response timing reveals nothing about the token. */
export function tokenMatches(expected: string, given: string | null | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", "http://bridge.invalid");
}

/** The token from `Authorization: Bearer <token>`, or else from `?t=`. */
function requestToken(req: IncomingMessage, url: URL): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length).trim();
  return url.searchParams.get("t");
}

/** Reads a small request body; a larger one is refused without reading the rest of it. */
function readBody(req: IncomingMessage): Promise<string> {
  const declared = Number(req.headers["content-length"]);
  if (declared > MAX_BODY_BYTES) {
    return Promise.reject(new HttpError(413, "request body too large"));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.pause();
        reject(new HttpError(413, "request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
    // An unread body is still on the connection; close it rather than parse it as a request.
    ...(status === 413 ? { connection: "close" } : {}),
  });
  res.end(text);
}

function refused(message: string): CommandResponse {
  return { id: null, status: "rejected", message };
}

/** Answers an upgrade request that will not become a WebSocket. */
function refuseUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.once("finish", () => socket.destroy());
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * The bridge's LAN server: the phone page on `/`, the live WebSocket on `/ws`, and
 * `POST /api/commands`. The WebSocket and the API require the pairing token; the page itself holds
 * no data and is served to anyone.
 */
export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const { hub } = options;
  const log = options.log ?? (() => {});
  const authorized = (req: IncomingMessage, url: URL) =>
    tokenMatches(options.token, requestToken(req, url));

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = requestUrl(req);
    const method = req.method ?? "GET";
    const path = url.pathname;

    if ((path === "/" || path === "/index.html") && (method === "GET" || method === "HEAD")) {
      res.writeHead(200, PAGE_HEADERS);
      res.end(options.page);
      return;
    }
    if (path === "/healthz" && method === "GET") {
      sendJson(res, 200, { ok: true, bridgeVersion: BRIDGE_VERSION });
      return;
    }
    if (path === "/api/status" && method === "GET") {
      if (!authorized(req, url)) {
        sendJson(res, 401, { error: "missing or wrong pairing token" });
        return;
      }
      sendJson(res, 200, { status: hub.currentStatus, alerts: hub.recentAlerts });
      return;
    }
    if (path === "/api/commands") {
      if (method !== "POST") {
        res.setHeader("allow", "POST");
        sendJson(res, 405, refused("use POST"));
        return;
      }
      if (!authorized(req, url)) {
        sendJson(res, 401, refused("missing or wrong pairing token"));
        return;
      }
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 400;
        sendJson(res, status, refused(error instanceof HttpError ? error.message : "invalid JSON"));
        return;
      }
      const parsed = CommandRequest.safeParse(body);
      if (!parsed.success) {
        sendJson(res, 400, refused(describeIssue(parsed.error)));
        return;
      }
      const response = await options.sendCommand(parsed.data);
      const note = response.message ? ` (${response.message})` : "";
      log(`command ${response.id ?? "-"} ${parsed.data.type}: ${response.status}${note}`);
      sendJson(res, 200, response);
      return;
    }
    sendJson(res, 404, { error: "not found" });
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      log(`request ${req.method} ${req.url?.split("?")[0]} failed: ${String(error)}`);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      else res.destroy();
    });
  });

  const sockets = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const pingMs = options.pingMs ?? 30_000;

  server.on("upgrade", (req, socket, head) => {
    const url = requestUrl(req);
    if (url.pathname !== "/ws") {
      refuseUpgrade(socket, 404, "Not Found");
      return;
    }
    if (!authorized(req, url)) {
      refuseUpgrade(socket, 401, "Unauthorized");
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => connected(ws));
  });

  const connected = (ws: WebSocket) => {
    let alive = true;
    ws.on("pong", () => {
      alive = true;
    });
    const detach = hub.attach({
      send: (text) => ws.send(text),
      get bufferedAmount() {
        return ws.bufferedAmount;
      },
    });
    log(`page connected (${hub.clientCount} open)`);
    const pinger = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, pingMs);
    ws.on("close", () => {
      clearInterval(pinger);
      detach();
      log(`page disconnected (${hub.clientCount} open)`);
    });
    ws.on("error", () => ws.terminate());
  };

  const repeater = setInterval(() => hub.repeatStatus(), options.statusRepeatMs ?? 10_000);

  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => {
      clearInterval(repeater);
      reject(error);
    };
    server.once("error", failed);
    server.listen(options.port ?? LIVE_PORT, options.host ?? "0.0.0.0", () => {
      server.off("error", failed);
      resolve();
    });
  });
  server.on("error", (error) => log(`server error: ${error.message}`));

  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      clearInterval(repeater);
      for (const ws of sockets.clients) ws.terminate();
      sockets.close();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    },
  };
}
