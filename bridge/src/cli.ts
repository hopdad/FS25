import { join } from "node:path";
import { parseArgs } from "node:util";
import { FILES, LiveVehicle } from "@farmlink/schema";
import { currentEnvironment, type Environment, resolveRoot } from "./config";
import { formatDoctor, runDoctor } from "./doctor";
import { formatVehicleFrame } from "./format";
import { BRIDGE_VERSION } from "./version";
import { LiveWatcher } from "./watch/live";
import { pickSave } from "./watch/saves";

const HELP = `FarmLink bridge ${BRIDGE_VERSION}

Usage:
  farmlink-bridge [--dir <folder>] [--save <saveId>] [--json]
  farmlink-bridge --doctor [--dir <folder>] [--json]

Prints every live_vehicle.json frame the FS25_FarmLink mod writes (P0).

Options:
  --dir <folder>   modSettings/FS25_FarmLink, the modSettings folder, or the game profile folder.
                   Defaults to FARMLINK_DIR, then the usual Documents location.
  --save <saveId>  Follow one save instead of the most recently active one.
  --json           Print raw JSON: one frame per line, or the doctor report.
  --doctor         Report paths, file freshness, the P0 exit criteria and the probe's answers.
  --observe <sec>  How long --doctor watches live_vehicle.json (default 5, 0 to skip).
  -v, --version    Print the version.
  -h, --help       Print this help.
`;

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
  /** Resolves when the process is asked to stop. */
  stopSignal: () => Promise<void>;
}

const processIo: Io = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  stopSignal: () =>
    new Promise((resolve) => {
      process.once("SIGINT", () => resolve());
      process.once("SIGTERM", () => resolve());
    }),
};

/** Follows the most recently active save and prints each new live vehicle frame. */
export async function follow(
  environment: Environment,
  options: { dir?: string; saveId?: string; json?: boolean; rescanMs?: number },
  io: Io,
): Promise<void> {
  const { root, source } = resolveRoot(environment, options.dir);
  io.err(`FarmLink bridge ${BRIDGE_VERSION}: reading ${root} (${source})`);

  let current: { saveId: string; watcher: LiveWatcher<LiveVehicle> } | undefined;
  let waitingShown = false;

  const choose = async () => {
    const save = await pickSave(root, options.saveId);
    if (!save) {
      if (!current && !waitingShown) {
        waitingShown = true;
        io.err("waiting for the game: no save folders yet (enable FS25_FarmLink and load a save)");
      }
      return;
    }
    if (current?.saveId === save.saveId) return;
    current?.watcher.stop();
    io.err(`following save ${save.saveId} (${save.meta?.saveName ?? "unnamed"})`);
    const watcher = new LiveWatcher({
      file: join(save.dir, FILES.liveVehicle),
      schema: LiveVehicle,
      onFrame: (frame, text) => io.out(options.json ? text.trim() : formatVehicleFrame(frame)),
      onInvalid: (error) => io.err(`dropped an invalid frame: ${error}`),
      onOffline: () => io.err("game offline: no live_vehicle.json update for 15 s"),
      onOnline: () => io.err("game online again"),
    });
    watcher.start();
    current = { saveId: save.saveId, watcher };
  };

  await choose();
  const rescan = setInterval(() => void choose(), options.rescanMs ?? 5000);
  await io.stopSignal();
  clearInterval(rescan);
  current?.watcher.stop();
  if (current) io.err(`stopped; ${JSON.stringify(current.watcher.stats)}`);
}

/** Runs the command line and returns the exit code. */
export async function main(
  argv: string[],
  io: Io = processIo,
  environment: Environment = currentEnvironment(),
): Promise<number> {
  let values: ReturnType<typeof parse>["values"];
  try {
    // `pnpm run doctor -- --dir x` forwards the "--" itself; there are no positionals to protect.
    values = parse(argv.filter((arg) => arg !== "--")).values;
  } catch (error) {
    io.err((error as Error).message);
    io.err("run with --help for usage");
    return 2;
  }

  if (values.help) {
    io.out(HELP);
    return 0;
  }
  if (values.version) {
    io.out(BRIDGE_VERSION);
    return 0;
  }
  if (values.doctor) {
    const observeMs = values.observe === undefined ? undefined : Number(values.observe) * 1000;
    if (observeMs !== undefined && !Number.isFinite(observeMs)) {
      io.err("--observe takes a number of seconds");
      return 2;
    }
    const report = await runDoctor({ environment, dir: values.dir, observeMs });
    io.out(values.json ? JSON.stringify(report, null, 2) : formatDoctor(report));
    return report.checks.some((c) => c.status === "fail") ? 1 : 0;
  }

  await follow(environment, { dir: values.dir, saveId: values.save, json: values.json }, io);
  return 0;
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      dir: { type: "string" },
      save: { type: "string" },
      json: { type: "boolean" },
      doctor: { type: "boolean" },
      observe: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
}
