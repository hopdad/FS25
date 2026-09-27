// Signing in to Supabase (PLAN_REVIEW.md F6): the player types the 6-digit code from the sign-in
// email into the bridge console, once. The session, with its refresh token, is kept in `auth.json`
// in the bridge's state folder, readable by the user only; the access token is refreshed from it a
// minute before it expires, or when PostgREST refuses it.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { SyncError } from "./rest";

const AUTH_FILE = "auth.json";
const CONFIG_FILE = "supabase.json";

/** The project the bridge syncs to. The anon key is public by design; row-level security guards. */
export const SupabaseConfig = z.object({
  url: z.url(),
  anonKey: z.string().min(20),
});
export type SupabaseConfig = z.infer<typeof SupabaseConfig>;

/**
 * FARMLINK_SUPABASE_URL and FARMLINK_SUPABASE_ANON_KEY, else `supabase.json` in the state folder
 * (`{ "url": ..., "anonKey": ... }`). Undefined when neither is there, or `error` says what is wrong.
 */
export function readSupabaseConfig(
  stateDir: string,
  env: Record<string, string | undefined>,
): { config?: SupabaseConfig; error?: string } {
  let raw: unknown;
  let source: string;
  if (env.FARMLINK_SUPABASE_URL || env.FARMLINK_SUPABASE_ANON_KEY) {
    raw = { url: env.FARMLINK_SUPABASE_URL, anonKey: env.FARMLINK_SUPABASE_ANON_KEY };
    source = "FARMLINK_SUPABASE_URL and FARMLINK_SUPABASE_ANON_KEY";
  } else {
    source = join(stateDir, CONFIG_FILE);
    try {
      raw = JSON.parse(readFileSync(source, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      return { error: `${source}: ${(error as Error).message}` };
    }
  }
  const parsed = SupabaseConfig.safeParse(raw);
  if (!parsed.success) return { error: `${source}: needs a project url and its anon key` };
  return { config: { ...parsed.data, url: parsed.data.url.replace(/\/+$/, "") } };
}

export const StoredSession = z.object({
  v: z.literal(1),
  /** The project the session belongs to; a session for another project is ignored. */
  url: z.string(),
  userId: z.uuid(),
  email: z.string(),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  /** Seconds since the epoch. */
  expiresAt: z.number(),
});
export type StoredSession = z.infer<typeof StoredSession>;

/** `auth.json`: the signed-in session. Written atomically, readable by the user only. */
export class SessionStore {
  readonly path: string;

  constructor(readonly dir: string) {
    this.path = join(dir, AUTH_FILE);
  }

  load(url?: string): StoredSession | undefined {
    try {
      const parsed = StoredSession.safeParse(JSON.parse(readFileSync(this.path, "utf8")));
      if (!parsed.success) return undefined;
      return url === undefined || parsed.data.url === url ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  save(session: StoredSession): void {
    mkdirSync(this.dir, { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
  }

  clear(): void {
    rmSync(this.path, { force: true });
  }
}

interface AuthResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  expires_at?: number;
  user?: { id?: string; email?: string };
}

/** Supabase Auth's endpoints that the bridge uses. */
export class AuthClient {
  private readonly fetch: typeof fetch;
  private readonly now: () => number;

  constructor(
    private readonly config: SupabaseConfig,
    options: { fetch?: typeof fetch; now?: () => number } = {},
  ) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  /** Emails a sign-in code, creating the account on first use. */
  async sendCode(email: string): Promise<void> {
    await this.post("otp", { email, create_user: true });
  }

  /** Exchanges the emailed code for a session. */
  async verifyCode(email: string, code: string): Promise<StoredSession> {
    return this.session(await this.post("verify", { type: "email", email, token: code }));
  }

  async refresh(session: StoredSession): Promise<StoredSession> {
    return this.session(
      await this.post("token?grant_type=refresh_token", { refresh_token: session.refreshToken }),
      session,
    );
  }

  /** Ends the session on the server too; failures do not matter, the local copy is gone anyway. */
  async signOut(session: StoredSession): Promise<void> {
    await this.post("logout", {}, session.accessToken).catch(() => {});
  }

  private session(body: AuthResponse, previous?: StoredSession): StoredSession {
    const userId = body.user?.id ?? previous?.userId;
    if (!body.access_token || !body.refresh_token || !userId) {
      throw new SyncError("Supabase Auth answered without a session", "server");
    }
    const expiresAt = body.expires_at ?? Math.floor(this.now() / 1000) + (body.expires_in ?? 3600);
    return {
      v: 1,
      url: this.config.url,
      userId,
      email: body.user?.email ?? previous?.email ?? "",
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt,
    };
  }

  private async post(path: string, body: object, bearer?: string): Promise<AuthResponse> {
    let response: Response;
    try {
      response = await this.fetch(`${this.config.url}/auth/v1/${path}`, {
        method: "POST",
        headers: {
          apikey: this.config.anonKey,
          "Content-Type": "application/json",
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new SyncError(`Supabase Auth: ${(error as Error).message}`, "network");
    }
    const text = await response.text().catch(() => "");
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      parsed = { msg: text.slice(0, 200) };
    }
    if (response.ok) return parsed as AuthResponse;
    const reason = [parsed.msg, parsed.error_description, parsed.message, parsed.error].find(
      (value) => typeof value === "string" && value !== "",
    );
    const message = `Supabase Auth: HTTP ${response.status}${reason ? `: ${String(reason)}` : ""}`;
    if (response.status === 429 || response.status >= 500) {
      throw new SyncError(message, "server", response.status);
    }
    throw new SyncError(message, "signedOut", response.status);
  }
}

/**
 * Hands the sync a valid access token: refreshed a minute before it expires, or after PostgREST
 * refused it. One refresh at a time; each new refresh token is saved before it is used.
 */
export class TokenSource {
  private session: StoredSession;
  private refreshing: Promise<StoredSession> | undefined;
  private stale = false;
  private readonly now: () => number;

  constructor(
    private readonly client: AuthClient,
    private readonly store: SessionStore,
    session: StoredSession,
    now: () => number = Date.now,
  ) {
    this.session = session;
    this.now = now;
  }

  get email(): string {
    return this.session.email;
  }

  get userId(): string {
    return this.session.userId;
  }

  /** PostgREST refused the token: the next request refreshes first. */
  invalidate(): void {
    this.stale = true;
  }

  async accessToken(): Promise<string> {
    const expiring = this.session.expiresAt * 1000 - this.now() < 60_000;
    if (!this.stale && !expiring) return this.session.accessToken;
    this.refreshing ??= this.client
      .refresh(this.session)
      .then((next) => {
        this.store.save(next);
        this.session = next;
        this.stale = false;
        return next;
      })
      .catch((caught: unknown) => {
        if (caught instanceof SyncError && caught.kind === "signedOut") {
          throw new SyncError(
            `signed out (${caught.message}): run farmlink-bridge --sign-in <your email>`,
            "signedOut",
            caught.status,
          );
        }
        throw caught;
      })
      .finally(() => {
        this.refreshing = undefined;
      });
    return (await this.refreshing).accessToken;
  }
}
