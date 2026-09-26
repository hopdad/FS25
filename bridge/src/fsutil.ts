import { rename as renameFile, rm, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

/** Errors Windows reports while another process has the target open. */
const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES"]);
const BACKOFF_MS = [25, 50, 100, 200, 400, 800];

export interface AtomicWriteOptions {
  /** Waits between rename attempts; the number of entries is the number of retries. */
  backoffMs?: readonly number[];
  /** Injected for tests. */
  rename?: (from: string, to: string) => Promise<void>;
}

/**
 * Replaces a file the game reads. The text goes to a temporary file that is then renamed over the
 * target, so the game sees the old file or the new one, never half of one. On Windows the rename
 * fails with EPERM or EBUSY while the game has the file open (PLAN_REVIEW.md, risks), so it is
 * retried with backoff. Returns how many rename attempts it took.
 */
export async function writeFileAtomic(
  path: string,
  text: string,
  options: AtomicWriteOptions = {},
): Promise<number> {
  const backoff = options.backoffMs ?? BACKOFF_MS;
  const rename = options.rename ?? renameFile;
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, text, "utf8");
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temporary, path);
      return attempt + 1;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const delay = backoff[attempt];
      if (code === undefined || !RETRYABLE.has(code) || delay === undefined) {
        await rm(temporary, { force: true });
        throw error;
      }
      await sleep(delay);
    }
  }
}
