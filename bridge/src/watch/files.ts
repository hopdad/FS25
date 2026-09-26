import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import type { z } from "zod";

export type ReadResult<T> =
  | { ok: true; value: T; text: string; attempts: number }
  | {
      ok: false;
      reason: "missing" | "unreadable" | "parse" | "invalid";
      error: string;
      attempts: number;
    };

export interface ReadOptions {
  /** Extra attempts after the first when the file is mid-write. The spec asks for 3. */
  retries?: number;
  /** Wait between attempts. The spec asks for 50 ms. */
  delayMs?: number;
}

/** The first Zod issue as "path: message", which is enough to find the offending field. */
export function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "invalid";
  const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
  return `${path}: ${issue.message}`;
}

/**
 * Reads and validates a JSON file the mod writes in place. The mod has no atomic rename
 * (VERIFY_FIRST.md, 3), so a read can land mid-write and see an empty or cut-off file; those are
 * retried. A file that parses but fails validation is not retried: a complete write will not fix it.
 */
export async function readJsonFile<S extends z.ZodType>(
  path: string,
  schema: S,
  options: ReadOptions = {},
): Promise<ReadResult<z.infer<S>>> {
  const retries = options.retries ?? 3;
  const delayMs = options.delayMs ?? 50;
  let lastError = "";

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    if (attempt > 1) await sleep(delayMs);

    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return { ok: false, reason: "missing", error: `${path} does not exist`, attempts: attempt };
      }
      lastError = String(error);
      if (attempt <= retries) continue;
      return { ok: false, reason: "unreadable", error: lastError, attempts: attempt };
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch (error) {
      lastError = (error as Error).message;
      continue;
    }

    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        reason: "invalid",
        error: describeIssue(parsed.error),
        attempts: attempt,
      };
    }
    return { ok: true, value: parsed.data, text, attempts: attempt };
  }

  return { ok: false, reason: "parse", error: lastError, attempts: retries + 1 };
}
