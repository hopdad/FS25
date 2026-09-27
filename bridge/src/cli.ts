import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { PAGE_HTML } from "@farmlink/live-ui/page";
import { FILES, LIVE_PORT, LiveVehicle } from "@farmlink/schema";
import { currentEnvironment, type Environment, resolveRoot } from "./config";
import { formatDoctor, runDoctor } from "./doctor";
import { formatVehicleFrame } from "./format";
import { type ServeOptions, serve } from "./serve";
import { defaultStateDir } from "./state";
import { signIn, signOut } from "./sync/setup";
import { BRIDGE_VERSION } from "./version";
import { LiveWatcher } from "./watch/live";
import { pickSave } from "./watch/saves";

const HELP = `FarmLink bridge ${BRIDGE_VERSION}

Usage:
  farmlink-bridge [--dir <folder>] [--save <saveId>] [--port <n>] [--host <address>]
  farmlink-bridge --print [--dir <folder>] [--save <saveId>] [--json]
  farmlink-bridge --doctor [--dir <folder>] [--json]
  farmlink-bridge --sign-in <email> | --sign-out

Serves the live page to your phone on the local network and relays worker commands to the
FS25_FarmLink mod. Prints the page's address and a QR code to scan.

Options:
  --dir <folder>    modSettings/FS25_FarmLink, the modSettings folder, or the game profile folder.
                    Defaults to FARMLINK_DIR, then the usual Documents location.
  --save <saveId>   Follow one save instead of the most recently active one.
  --port <n>        Port for the page and the WebSocket (default ${LIVE_PORT}).
  --host <address>  Listen on one address only (default: every interface).
  --state <folder>  Where bridge-state.json lives (default: your user config folder).
  --reset-token     Make a new pairing token; links opened with the old one stop working.
  --no-qr           Do not print the QR code.
  --print           Print each live_vehicle.json frame instead of serving (the P0 mode).
  --json            With --print, raw JSON lines; with --doctor, the report as JSON.
  --doctor          Report paths, file freshness, the P0 exit criteria and the probe's answers.
  --observe <sec>   How long --doctor watches live_vehicle.json (default 5, 0 to skip).
  --sign-in <email> Sign in to your FarmLink account with a code sent by email, so the bridge
                    syncs your saves' history. Needs the project in supabase.json or in
                    FARMLINK_SUPABASE_URL and FARMLINK_SUPABASE_ANON_KEY.
  --sign-out        Stop syncing and forget the sign-in.
  -v, --version     Print the version.
  -h, --help        Print this help.
`;

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
  /** Resolves when the process is asked to stop. */
  stopSignal: () => Promise<void>;
  /** One line typed into the console; absent when there is none. */
  readLine?: () => Promise<string>;
}

const processIo: Io = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  stopSignal: () =>
    new Promise((resolve) => {
      process.once("SIGINT", () => resolve());
      process.once("SIGTERM", () => resolve());
    }),
  readLine: () =>
    new Promise((resolve) => {
      const lines = createInterface({ input: process.stdin });
      lines.once("line", (line) => {
        lines.close();
        resolve(line);
      });
      lines.once("close", () => resolve(""));
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

export interface MainOptions {
  /** The phone page's HTML; the built live-ui page by default. */
  page?: string;
  onListening?: ServeOptions["onListening"];
}

/** Runs the command line and returns the exit code. */
export async function main(
  argv: string[],
  io: Io = processIo,
  environment: Environment = currentEnvironment(),
  options: MainOptions = {},
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
    const report = await runDoctor({
      environment,
      dir: values.dir,
      observeMs,
      stateDir: values.state,
      serverPort: values.port === undefined ? undefined : Number(values.port),
    });
    io.out(values.json ? JSON.stringify(report, null, 2) : formatDoctor(report));
    return report.checks.some((c) => c.status === "fail") ? 1 : 0;
  }

  const stateDir = values.state ?? defaultStateDir(environment);
  if (values["sign-in"] !== undefined) {
    const email = values["sign-in"].trim();
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) {
      io.err("--sign-in takes your email address");
      return 2;
    }
    return signIn({ stateDir, env: environment.env, email }, io);
  }
  if (values["sign-out"]) return signOut({ stateDir, env: environment.env }, io);

  if (values.print) {
    await follow(environment, { dir: values.dir, saveId: values.save, json: values.json }, io);
    return 0;
  }

  const port = values.port === undefined ? undefined : Number(values.port);
  if (port !== undefined && !(Number.isInteger(port) && port >= 0 && port <= 65535)) {
    io.err("--port takes a port number");
    return 2;
  }
  return serve(
    environment,
    {
      dir: values.dir,
      saveId: values.save,
      port,
      host: values.host,
      stateDir: values.state,
      resetToken: values["reset-token"],
      qr: !values["no-qr"],
      page: options.page ?? PAGE_HTML,
      onListening: options.onListening,
    },
    io,
  );
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
      print: { type: "boolean" },
      port: { type: "string" },
      host: { type: "string" },
      state: { type: "string" },
      "reset-token": { type: "boolean" },
      "sign-in": { type: "string" },
      "sign-out": { type: "boolean" },
      "no-qr": { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
}
