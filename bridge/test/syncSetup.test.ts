import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Io, main } from "../src/cli";
import type { Environment } from "../src/config";
import { LiveHub } from "../src/live/hub";
import { SaveSession } from "../src/live/session";
import {
  AuthClient,
  readSupabaseConfig,
  SessionStore,
  type StoredSession,
  TokenSource,
} from "../src/sync/auth";
import { openSync } from "../src/sync/setup";
import { BRANCH_ID, farmFrame, meta, SAVE_ID, tempRoot, writeSave } from "./fixtures";

const USER = "3b9a7c1e-2d4f-4e6a-8b0c-1d2e3f4a5b6c";
const ANON_KEY = "anon-key-0123456789abcdef";

interface Recorded {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

/** Just enough of Supabase Auth and PostgREST to follow what the bridge sends. */
async function fakeSupabase() {
  const requests: Recorded[] = [];
  const events: { seq: number }[] = [];
  const saves = new Set<string>();
  let issued = 0;
  const session = (email: string) => {
    issued += 1;
    return {
      access_token: `access-${issued}`,
      refresh_token: `refresh-${issued}`,
      expires_in: 3600,
      user: { id: USER, email },
    };
  };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    const body = text ? JSON.parse(text) : undefined;
    const url = new URL(req.url ?? "/", "http://fake");
    requests.push({
      method: req.method ?? "",
      path: url.pathname + url.search,
      headers: req.headers,
      body,
    });
    const send = (status: number, json?: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(json === undefined ? "" : JSON.stringify(json));
    };
    switch (url.pathname) {
      case "/auth/v1/otp":
        return send(200, {});
      case "/auth/v1/verify":
        return body.token === "123456"
          ? send(200, session(body.email))
          : send(403, {
              code: 403,
              error_code: "otp_expired",
              msg: "Token has expired or is invalid",
            });
      case "/auth/v1/token":
        return String(body.refresh_token).startsWith("refresh-")
          ? send(200, session("farmer@example.com"))
          : send(400, { error_code: "refresh_token_not_found", msg: "Invalid Refresh Token" });
      case "/auth/v1/logout":
        return send(204);
      case "/rest/v1/saves":
        if (req.method === "POST") for (const row of body) saves.add(row.id);
        return send(req.method === "POST" ? 201 : 204);
      case "/rest/v1/rpc/my_saves":
        return send(
          200,
          [...saves].map((id) => ({ save_id: id, role: "owner" })),
        );
      case "/rest/v1/events":
        events.push(...body);
        return send(201);
      case "/rest/v1/snapshots":
        return send(201);
    }
    send(404, { code: "PGRST205", message: `no route ${url.pathname}` });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    events,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function capture(lines: string[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    stopSignal: () => new Promise(() => {}),
    readLine: async () => lines.shift() ?? "",
  };
  return { io, out, err };
}

function money(seq: number) {
  return {
    v: 1,
    saveId: SAVE_ID,
    branchId: BRANCH_ID,
    seq,
    realTs: "2026-09-27T10:00:00Z",
    day: 37,
    minute: 600,
    year: 2,
    farmId: 1,
    userId: null,
    type: "money",
    data: { amount: -10, moneyType: "OTHER", context: { kind: "none" } },
  };
}

describe("signing in and syncing", () => {
  let fake: Awaited<ReturnType<typeof fakeSupabase>>;
  let stateDir: string;
  let environment: Environment;

  beforeEach(async () => {
    fake = await fakeSupabase();
    stateDir = tempRoot();
    environment = {
      platform: "linux",
      home: "/nonexistent",
      env: { FARMLINK_SUPABASE_URL: `${fake.url}/`, FARMLINK_SUPABASE_ANON_KEY: ANON_KEY },
    };
  });

  afterEach(async () => {
    await fake.close();
  });

  const stored = (): StoredSession => ({
    v: 1,
    url: fake.url,
    userId: USER,
    email: "farmer@example.com",
    accessToken: "access-0",
    refreshToken: "refresh-0",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });

  it("signs in with the emailed code, and keeps the session readable by the user only", async () => {
    const { io, out } = capture(["123456\n"]);
    expect(
      await main(["--sign-in", "farmer@example.com", "--state", stateDir], io, environment),
    ).toBe(0);
    expect(fake.requests.map((r) => [r.path, r.body])).toEqual([
      ["/auth/v1/otp", { email: "farmer@example.com", create_user: true }],
      ["/auth/v1/verify", { type: "email", email: "farmer@example.com", token: "123456" }],
    ]);
    expect(fake.requests[0]?.headers.apikey).toBe(ANON_KEY);
    expect(out).toEqual([
      "A sign-in email is on its way to farmer@example.com. Type the 6-digit code from it:",
      "Signed in as farmer@example.com. The bridge now syncs your saves.",
    ]);
    const path = join(stateDir, "auth.json");
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      url: fake.url,
      userId: USER,
      email: "farmer@example.com",
      refreshToken: "refresh-1",
    });
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("turns away a wrong code and an address that is not one", async () => {
    const wrong = capture(["000000"]);
    expect(
      await main(["--sign-in", "farmer@example.com", "--state", stateDir], wrong.io, environment),
    ).toBe(1);
    expect(wrong.err).toEqual([
      "that code did not work: Supabase Auth: HTTP 403: Token has expired or is invalid",
    ]);
    expect(existsSync(join(stateDir, "auth.json"))).toBe(false);

    const typo = capture();
    expect(await main(["--sign-in", "farmer.example.com"], typo.io, environment)).toBe(2);
    expect(typo.err).toEqual(["--sign-in takes your email address"]);
  });

  it("refreshes the token before it expires and after a refusal, saving each new one", async () => {
    const { config } = readSupabaseConfig(stateDir, environment.env);
    if (!config) throw new Error("no config");
    const store = new SessionStore(stateDir);
    const clock = { now: Date.now() };
    const tokens = new TokenSource(
      new AuthClient(config),
      store,
      { ...stored(), expiresAt: Math.floor(clock.now / 1000) + 30 },
      () => clock.now,
    );

    const [a, b] = await Promise.all([tokens.accessToken(), tokens.accessToken()]);
    expect([a, b]).toEqual(["access-1", "access-1"]);
    expect(
      fake.requests.filter((r) => r.path === "/auth/v1/token?grant_type=refresh_token"),
    ).toHaveLength(1);
    expect(store.load()?.refreshToken).toBe("refresh-1");
    expect(await tokens.accessToken()).toBe("access-1");

    tokens.invalidate();
    expect(await tokens.accessToken()).toBe("access-2");
    expect(store.load()?.refreshToken).toBe("refresh-2");

    const revoked = new TokenSource(new AuthClient(config), store, {
      ...stored(),
      refreshToken: "gone",
      expiresAt: 0,
    });
    await expect(revoked.accessToken()).rejects.toMatchObject({
      kind: "signedOut",
      message:
        "signed out (Supabase Auth: HTTP 400: Invalid Refresh Token): run farmlink-bridge --sign-in <your email>",
    });
  });

  it("says why it does not sync", () => {
    expect(openSync({ stateDir, env: {} })).toEqual({
      ready: false,
      reason: "no Supabase project is set up",
    });
    expect(openSync({ stateDir, env: environment.env })).toEqual({
      ready: false,
      reason: "not signed in: run farmlink-bridge --sign-in <your email>",
    });
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "supabase.json"), '{"url": "not a url"}');
    expect(openSync({ stateDir, env: {} })).toEqual({
      ready: false,
      reason: `${join(stateDir, "supabase.json")}: needs a project url and its anon key`,
    });
  });

  it("follows a save's event log into Supabase as the signed-in player", async () => {
    new SessionStore(stateDir).save(stored());
    const sync = openSync({ stateDir, env: environment.env, engine: { flushMs: 100, tickMs: 50 } });
    if (!sync.ready) throw new Error(sync.reason);
    expect(sync.email).toBe("farmer@example.com");

    const root = tempRoot();
    const dir = writeSave(root, SAVE_ID, {
      "meta.json": meta({ modVersion: "0.2.0.0" }),
      "live_farm.json": farmFrame(),
    });
    mkdirSync(join(dir, "events"));
    writeFileSync(
      join(dir, "events", "37.ndjson"),
      `${[1, 2, 3].map((seq) => JSON.stringify(money(seq))).join("\n")}\n`,
    );

    const hub = new LiveHub();
    const session = new SaveSession({
      saveId: SAVE_ID,
      dir,
      hub,
      numbering: {
        commandEpoch: "5f6a7b8c-9d0e-4f1a-8b2c-3d4e5f6a7b8c",
        nextCommandId: () => 1,
        skipPast: () => false,
      },
      pollScale: 0.1,
      now: () => statSync(join(dir, "live_farm.json")).mtimeMs,
      sync: sync.engineFor(SAVE_ID),
    });
    session.start();
    try {
      await vi.waitFor(() => expect(fake.events.map((e) => e.seq)).toEqual([1, 2, 3]), {
        timeout: 5000,
      });
      await vi.waitFor(
        () => expect(hub.currentStatus.sync).toMatchObject({ state: "synced", queued: 0, gaps: 0 }),
        {
          timeout: 5000,
        },
      );
    } finally {
      await session.stop();
    }

    const rest = fake.requests.filter((r) => r.path.startsWith("/rest/v1/"));
    expect(
      rest.every(
        (r) => r.headers.authorization === "Bearer access-0" && r.headers.apikey === ANON_KEY,
      ),
    ).toBe(true);
    expect(rest.find((r) => r.path.startsWith("/rest/v1/saves?"))).toMatchObject({
      path: "/rest/v1/saves?on_conflict=id",
      body: [{ id: SAVE_ID, name: "Riverbend Springs", map: null, mod_version: "0.2.0.0" }],
      headers: { prefer: "resolution=ignore-duplicates,return=minimal" },
    });
    expect(rest.find((r) => r.path.startsWith("/rest/v1/events"))?.path).toBe(
      "/rest/v1/events?on_conflict=save_id%2Cbranch_id%2Cseq",
    );
    expect(rest.find((r) => r.path.startsWith("/rest/v1/snapshots"))).toMatchObject({
      headers: { prefer: "resolution=merge-duplicates,return=minimal" },
      body: [expect.objectContaining({ save_id: SAVE_ID, branch_id: BRANCH_ID, day: 37 })],
    });
    expect(
      rest.some((r) => r.method === "PATCH" && r.path === `/rest/v1/saves?id=eq.${SAVE_ID}`),
    ).toBe(true);
    expect(
      JSON.parse(readFileSync(join(stateDir, "sync-state.json"), "utf8")).saves[SAVE_ID],
    ).toMatchObject({
      branches: { [BRANCH_ID]: 3 },
      snapshotDays: { [BRANCH_ID]: 37 },
    });
  });

  it("signs out here and on the server", async () => {
    new SessionStore(stateDir).save(stored());
    const { io, out } = capture();
    expect(await main(["--sign-out", "--state", stateDir], io, environment)).toBe(0);
    expect(fake.requests.map((r) => [r.path, r.headers.authorization])).toEqual([
      ["/auth/v1/logout", "Bearer access-0"],
    ]);
    expect(out).toEqual(["Signed out farmer@example.com. The bridge no longer syncs."]);
    expect(existsSync(join(stateDir, "auth.json"))).toBe(false);

    const again = capture();
    expect(await main(["--sign-out", "--state", stateDir], again.io, environment)).toBe(0);
    expect(again.out).toEqual(["Not signed in."]);
  });
});
