// A PostgREST server on a test database, which is what the bridge talks to on Supabase: the same
// role switch, JWT claims and upsert semantics. Found through POSTGREST_BIN or on PATH; without it
// the tests that need it are skipped, unless REQUIRE_POSTGREST is set (CI sets it).

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { freePort } from "./cluster";

export function findPostgrest(): string | undefined {
  const fromEnv = process.env.POSTGREST_BIN;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const which = spawnSync("sh", ["-c", "command -v postgrest"], { encoding: "utf8" });
  const onPath = which.status === 0 ? which.stdout.trim() : "";
  if (onPath) return onPath;
  if (process.env.REQUIRE_POSTGREST) {
    throw new Error(
      "REQUIRE_POSTGREST is set, but there is no POSTGREST_BIN and no postgrest on PATH",
    );
  }
  return undefined;
}

export interface Postgrest {
  url: string;
  /** A signed-in user's access token, as Supabase Auth would issue it. */
  token(userId: string): string;
  stop(): void;
}

const base64url = (value: string | Buffer) => Buffer.from(value).toString("base64url");

/** An HS256 JWT. */
export function signJwt(secret: string, claims: Record<string, unknown>): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify(claims));
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest();
  return `${header}.${payload}.${base64url(signature)}`;
}

export async function startPostgrest(bin: string, databaseUrl: string): Promise<Postgrest> {
  const port = await freePort();
  const secret = randomBytes(32).toString("hex");
  let output = "";
  const child: ChildProcess = spawn(bin, [], {
    env: {
      PGRST_DB_URI: databaseUrl,
      PGRST_DB_SCHEMAS: "public",
      PGRST_DB_ANON_ROLE: "anon",
      PGRST_DB_POOL: "4",
      PGRST_JWT_SECRET: secret,
      PGRST_SERVER_HOST: "127.0.0.1",
      PGRST_SERVER_PORT: String(port),
      PGRST_LOG_LEVEL: "error",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    output += String(chunk);
  });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`postgrest exited: ${output}`);
    try {
      const response = await fetch(`${url}/`);
      if (response.status < 500) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`postgrest did not start: ${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return {
    url,
    token: (userId) =>
      signJwt(secret, {
        sub: userId,
        role: "authenticated",
        aud: "authenticated",
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    stop: () => child.kill(),
  };
}
