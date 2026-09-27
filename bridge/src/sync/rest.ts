// A small client for the PostgREST API behind Supabase (docs/HANDOFF.md, "Supabase sync"). The
// bridge needs a handful of calls, so it speaks HTTP itself rather than bundling supabase-js into
// the executable: bulk inserts that ignore duplicates or merge them, one update, one select and one
// function call. Every request carries the signed-in player's token, so row-level security applies.

/** Why a request failed, which decides what the sync does next. */
export type SyncErrorKind =
  /** No answer: offline, DNS, timeout. Retried with backoff. */
  | "network"
  /** 5xx or 429. Retried with backoff. */
  | "server"
  /** The token was refused (401). The next attempt gets a fresh token. */
  | "auth"
  /** Row-level security or grants said no (403, 42501): someone else's save, or a viewer's. */
  | "forbidden"
  /** A table or function is missing (404): the migrations are not applied to this project. */
  | "config"
  /** The database refused the data itself (a constraint, a type). Retrying cannot help. */
  | "rejected"
  /** Supabase Auth no longer accepts the saved session: the player has to sign in again. */
  | "signedOut";

export class SyncError extends Error {
  constructor(
    message: string,
    readonly kind: SyncErrorKind,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "SyncError";
  }

  /** Whether the same request may succeed later without anyone changing anything. */
  get retryable(): boolean {
    return this.kind === "network" || this.kind === "server" || this.kind === "auth";
  }
}

export interface RestOptions {
  /** PostgREST's base URL: `<project>/rest/v1` on Supabase, or a plain PostgREST's root. */
  url: string;
  /** The project's anon key, which Supabase's gateway wants on every request. */
  apiKey?: string;
  /** The caller's access token, fetched for every request so it can be refreshed in between. */
  accessToken: () => Promise<string>;
  /** Told when a token is refused, so the next request gets a fresh one. */
  onUnauthorized?: () => void;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface PostgrestError {
  code?: string;
  message?: string;
  details?: string | null;
  hint?: string | null;
}

/** Maps a PostgREST error response to what the sync should do about it. */
export function classify(status: number, body: PostgrestError | undefined): SyncError {
  const code = body?.code;
  const text = [body?.message, body?.details, body?.hint].filter(Boolean).join("; ");
  const message = `HTTP ${status}${code ? ` ${code}` : ""}${text ? `: ${text}` : ""}`;
  if (status === 401 || code?.startsWith("PGRST30"))
    return new SyncError(message, "auth", status, code);
  if (status === 403 || code === "42501") return new SyncError(message, "forbidden", status, code);
  // A missing table, column or function: the project's schema is behind the bridge's.
  if (
    status === 404 ||
    code === "42P01" ||
    code === "42703" ||
    code === "42883" ||
    code?.startsWith("PGRST2")
  ) {
    return new SyncError(message, "config", status, code);
  }
  if (status === 429 || status >= 500) return new SyncError(message, "server", status, code);
  return new SyncError(message, "rejected", status, code);
}

type Resolution = "ignore-duplicates" | "merge-duplicates";

export class RestClient {
  private readonly base: string;
  private readonly fetch: typeof fetch;

  constructor(private readonly options: RestOptions) {
    this.base = options.url.replace(/\/+$/, "");
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  /** Inserts rows; on a conflict with `onConflict`, skips the row or updates it. */
  async insert(
    table: string,
    rows: readonly object[],
    options: { onConflict: string; resolution: Resolution },
  ): Promise<void> {
    if (rows.length === 0) return;
    const query = new URLSearchParams({ on_conflict: options.onConflict });
    await this.request("POST", `${table}?${query}`, rows, {
      Prefer: `resolution=${options.resolution},return=minimal`,
    });
  }

  /** Updates the rows matching `filter` (PostgREST operators, e.g. `{ id: "eq.<uuid>" }`). */
  async update(table: string, filter: Record<string, string>, values: object): Promise<void> {
    await this.request("PATCH", `${table}?${new URLSearchParams(filter)}`, values, {
      Prefer: "return=minimal",
    });
  }

  async select<T>(table: string, query: Record<string, string>): Promise<T[]> {
    return (await this.request("GET", `${table}?${new URLSearchParams(query)}`)) as T[];
  }

  async rpc<T>(fn: string, args: object = {}): Promise<T> {
    return (await this.request("POST", `rpc/${fn}`, args)) as T;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<unknown> {
    const token = await this.options.accessToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 30_000);
    let response: Response;
    try {
      response = await this.fetch(`${this.base}/${path}`, {
        method,
        headers: {
          ...(this.options.apiKey ? { apikey: this.options.apiKey } : {}),
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const reason = controller.signal.aborted ? "timed out" : (error as Error).message;
      throw new SyncError(`${method} ${path.split("?")[0]}: ${reason}`, "network");
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      let parsed: PostgrestError | undefined;
      try {
        parsed = JSON.parse(text) as PostgrestError;
      } catch {
        parsed = text ? { message: text.slice(0, 200) } : undefined;
      }
      const error = classify(response.status, parsed);
      if (error.kind === "auth") this.options.onUnauthorized?.();
      throw error;
    }
    return text ? JSON.parse(text) : null;
  }
}
