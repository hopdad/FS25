import { createInterface } from "node:readline";
import { main } from "./cli";

const argv = process.argv.slice(2);

/**
 * A bridge started by double-clicking has its own console window, which closes the moment the
 * process exits. When serving fails on Windows, keep the window open so the reason can be read.
 */
function shouldPause(): boolean {
  const modes = ["--doctor", "--print", "--help", "-h", "--version", "-v"];
  return (
    process.platform === "win32" &&
    process.stdin.isTTY === true &&
    !argv.some((arg) => modes.includes(arg))
  );
}

async function pauseIfNeeded(code: number): Promise<void> {
  if (code === 0 || !shouldPause()) return;
  process.stderr.write("\nPress Enter to close this window.\n");
  const lines = createInterface({ input: process.stdin });
  await new Promise<void>((resolve) => lines.once("line", () => resolve()));
  lines.close();
}

main(argv)
  .catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    return 1;
  })
  .then(async (code) => {
    process.exitCode = code;
    await pauseIfNeeded(code);
  });
