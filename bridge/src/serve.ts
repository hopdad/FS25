import { join } from "node:path";
import { type CommandRequest, type CommandResponse, LIVE_PORT } from "@farmlink/schema";
import type { Io } from "./cli";
import { type Environment, resolveRoot } from "./config";
import { type RunningServer, startServer } from "./http/server";
import { LiveHub } from "./live/hub";
import { SaveSession } from "./live/session";
import { fileLogger } from "./logfile";
import { lanAddresses, pageUrl, terminalQr } from "./net";
import { BridgeState, defaultStateDir } from "./state";
import { BRIDGE_VERSION } from "./version";
import { pickSave, type SaveFolder } from "./watch/saves";

export interface ServeOptions {
  dir?: string;
  saveId?: string;
  port?: number;
  /** Interface to listen on; every interface by default. */
  host?: string;
  /** Folder for bridge-state.json; the OS user config folder by default. */
  stateDir?: string;
  resetToken?: boolean;
  /** Print a QR code of the page URL (default true). */
  qr?: boolean;
  /** The phone page's HTML. */
  page: string;
  rescanMs?: number;
  /** Called once the server is listening; tests use it to find the port and token. */
  onListening?: (info: { port: number; token: string; urls: string[] }) => void;
}

/**
 * The bridge's normal mode: serves the phone page and follows the most recently active save,
 * switching when the game loads another one. Returns the exit code.
 */
export async function serve(
  environment: Environment,
  options: ServeOptions,
  io: Io,
): Promise<number> {
  const { root, source } = resolveRoot(environment, options.dir);
  const state = new BridgeState(options.stateDir ?? defaultStateDir(environment));
  if (options.resetToken) state.resetPairingToken();
  // Everything but the banner also goes to bridge.log; the banner holds the pairing link.
  const toFile = fileLogger(join(state.dir, "bridge.log"));
  const log = (line: string) => {
    io.err(line);
    toFile(line);
  };

  const hub = new LiveHub((alert) => log(`alert: ${alert.title}: ${alert.message}`));
  let session: SaveSession | undefined;
  const sendCommand = (request: CommandRequest): Promise<CommandResponse> =>
    session
      ? session.send(request)
      : Promise.resolve({ id: null, status: "rejected", message: "no save is loaded" });

  let server: RunningServer;
  try {
    server = await startServer({
      hub,
      token: state.pairingToken,
      page: options.page,
      sendCommand,
      host: options.host,
      port: options.port,
      log,
    });
  } catch (error) {
    const port = options.port ?? LIVE_PORT;
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      log(`port ${port} is in use: is another FarmLink bridge running? Pick another with --port.`);
    } else {
      log(`could not listen on port ${port}: ${(error as Error).message}`);
    }
    return 1;
  }

  const listenHost = options.host && options.host !== "0.0.0.0" ? options.host : undefined;
  const hosts = listenHost ? [listenHost] : lanAddresses();
  const urls = (hosts.length > 0 ? hosts : ["localhost"]).map((host) =>
    pageUrl(host, server.port, state.pairingToken),
  );
  log(`FarmLink bridge ${BRIDGE_VERSION}: reading ${root} (${source}); log in ${state.dir}`);
  if (options.resetToken) {
    log("new pairing token: pages opened with the old link must be reopened");
  }
  io.out("Open the live page on your phone, on the same Wi-Fi as this computer:");
  for (const url of urls) io.out(`  ${url}`);
  if (options.qr !== false && urls[0]) io.out(terminalQr(urls[0]));
  io.out(
    "Keep this window open while you play. Anyone with the link can see your farm and stop workers.",
  );
  options.onListening?.({ port: server.port, token: state.pairingToken, urls });

  let waitingShown = false;
  let choosing = false;
  const choose = async () => {
    if (choosing) return;
    choosing = true;
    try {
      switchTo(await pickSave(root, options.saveId));
    } finally {
      choosing = false;
    }
  };
  const switchTo = (save: SaveFolder | undefined) => {
    if (!save) {
      if (!session && !waitingShown) {
        waitingShown = true;
        log("waiting for the game: no save folders yet (enable FS25_FarmLink and load a save)");
      }
      return;
    }
    if (session?.saveId === save.saveId) return;
    session?.stop();
    log(`following save ${save.saveId} (${save.meta?.saveName ?? "unnamed"})`);
    session = new SaveSession({
      saveId: save.saveId,
      dir: save.dir,
      hub,
      numbering: state,
      log,
    });
    session.start();
  };

  await choose();
  const rescan = setInterval(() => void choose(), options.rescanMs ?? 5000);
  await io.stopSignal();
  clearInterval(rescan);
  session?.stop();
  await server.close();
  log("stopped");
  return 0;
}
