import type { Io } from "../cli";
import { AuthClient, readSupabaseConfig, SessionStore, TokenSource } from "./auth";
import { SyncCursorStore } from "./cursor";
import { SyncEngine, type SyncEngineOptions } from "./engine";
import { RestClient } from "./rest";
import { SupabaseTransport } from "./transport";

export type SyncSetup =
  | { ready: true; email: string; engineFor: (saveId: string) => SyncEngine }
  | { ready: false; reason: string };

export interface SyncSetupOptions {
  stateDir: string;
  env: Record<string, string | undefined>;
  log?: (line: string) => void;
  fetch?: typeof fetch;
  /** Batch size and timings, for tests. */
  engine?: Partial<Pick<SyncEngineOptions, "batchSize" | "flushMs" | "tickMs" | "backoffMs">>;
}

const HOW_TO_SIGN_IN = "run farmlink-bridge --sign-in <your email>";

/**
 * Whether this bridge syncs, and to what: a Supabase project (supabase.json or the environment) and
 * a signed-in session for it. Sync is optional; without either the bridge works on the LAN only.
 */
export function openSync(options: SyncSetupOptions): SyncSetup {
  const { stateDir, env, log } = options;
  const { config, error } = readSupabaseConfig(stateDir, env);
  if (error !== undefined) return { ready: false, reason: error };
  if (config === undefined) return { ready: false, reason: "no Supabase project is set up" };
  const store = new SessionStore(stateDir);
  const session = store.load(config.url);
  if (session === undefined) return { ready: false, reason: `not signed in: ${HOW_TO_SIGN_IN}` };

  const tokens = new TokenSource(new AuthClient(config, { fetch: options.fetch }), store, session);
  const transport = new SupabaseTransport(
    new RestClient({
      url: `${config.url}/rest/v1`,
      apiKey: config.anonKey,
      accessToken: () => tokens.accessToken(),
      onUnauthorized: () => tokens.invalidate(),
      fetch: options.fetch,
    }),
  );
  const cursor = new SyncCursorStore(stateDir);
  return {
    ready: true,
    email: session.email,
    engineFor: (saveId) => new SyncEngine({ ...options.engine, saveId, transport, cursor, log }),
  };
}

/** `--sign-in <email>`: emails a code, reads it from the console and keeps the session. */
export async function signIn(
  options: {
    stateDir: string;
    env: Record<string, string | undefined>;
    email: string;
    fetch?: typeof fetch;
  },
  io: Io,
): Promise<number> {
  const { config, error } = readSupabaseConfig(options.stateDir, options.env);
  if (config === undefined) {
    io.err(
      error ??
        "no Supabase project is set up: set FARMLINK_SUPABASE_URL and FARMLINK_SUPABASE_ANON_KEY",
    );
    return 2;
  }
  if (io.readLine === undefined) {
    io.err("--sign-in needs a console to type the code into");
    return 2;
  }
  const client = new AuthClient(config, { fetch: options.fetch });
  try {
    await client.sendCode(options.email);
  } catch (caught) {
    io.err(`could not send the sign-in email: ${(caught as Error).message}`);
    return 1;
  }
  io.out(`A sign-in email is on its way to ${options.email}. Type the 6-digit code from it:`);
  const code = (await io.readLine()).trim();
  try {
    const session = await client.verifyCode(options.email, code);
    new SessionStore(options.stateDir).save(session);
    io.out(`Signed in as ${session.email || options.email}. The bridge now syncs your saves.`);
    return 0;
  } catch (caught) {
    io.err(`that code did not work: ${(caught as Error).message}`);
    return 1;
  }
}

/** `--sign-out`: forgets the session, here and on the server. */
export async function signOut(
  options: { stateDir: string; env: Record<string, string | undefined>; fetch?: typeof fetch },
  io: Io,
): Promise<number> {
  const store = new SessionStore(options.stateDir);
  const session = store.load();
  if (session === undefined) {
    io.out("Not signed in.");
    return 0;
  }
  const { config } = readSupabaseConfig(options.stateDir, options.env);
  if (config !== undefined && config.url === session.url) {
    await new AuthClient(config, { fetch: options.fetch }).signOut(session);
  }
  store.clear();
  io.out(`Signed out ${session.email}. The bridge no longer syncs.`);
  return 0;
}
