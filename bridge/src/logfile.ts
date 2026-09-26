import { appendFileSync, renameSync, statSync } from "node:fs";

/** Past this size the log moves to `<name>.1`, replacing the previous one. */
const MAX_BYTES = 1_000_000;
/** How many lines to write between size checks. */
const CHECK_EVERY = 50;

/**
 * Appends timestamped lines to a log file, for a bridge that runs for days in a window nobody
 * reads. Never throws: a log that cannot be written must not stop the bridge.
 */
export function fileLogger(
  path: string,
  now: () => Date = () => new Date(),
): (line: string) => void {
  let written = CHECK_EVERY;
  return (line) => {
    try {
      if (++written >= CHECK_EVERY) {
        written = 0;
        let size = 0;
        try {
          size = statSync(path).size;
        } catch {
          // no log yet
        }
        if (size > MAX_BYTES) renameSync(path, `${path}.1`);
      }
      appendFileSync(path, `${now().toISOString()} ${line}\n`);
    } catch {
      // full disk or a locked file: keep serving
    }
  };
}
