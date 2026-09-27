import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { FILES, LIVE_PORT, LiveVehicle, ProbeReport } from "@farmlink/schema";
import { type Environment, type ResolvedRoot, resolveRoot } from "./config";
import { eventChecks } from "./doctorEvents";
import { ledgerChecks } from "./doctorLedger";
import { collectLive, type LiveReport, liveChecks } from "./doctorLive";
import { syncCheck } from "./doctorSync";
import { defaultStateDir } from "./state";
import { BRIDGE_VERSION, runtimeName } from "./version";
import { readJsonFile } from "./watch/files";
import { LiveWatcher, type LiveWatcherStats } from "./watch/live";
import { listSaves } from "./watch/saves";

/** The P0 exit criterion for the cost of one live write. */
export const WRITE_BUDGET_MS = 0.5;
/** A live file older than this means the game is not running. */
const GAME_RUNNING_WITHIN_MS = 15000;

export type CheckStatus = "pass" | "fail" | "pending";

export interface Check {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  /** Checks without a phase belong to P0. */
  phase?: "P1" | "P2";
}

export interface DoctorReport {
  bridge: { version: string; runtime: string; platform: string; arch: string };
  root: ResolvedRoot & { exists: boolean };
  saves: Array<{
    saveId: string;
    saveName: string | null;
    modVersion: string | null;
    gameVersion: string | null;
    mode: string | null;
    beat: number | null;
    metaAgeSec: number | null;
    liveAgeSec: number | null;
    meta: string;
    live: string;
  }>;
  activeSaveId: string | null;
  observation: (LiveWatcherStats & { durationMs: number }) | null;
  probe: { ageSec: number | null; error: string | null } | null;
  live: LiveReport;
  checks: Check[];
  sync: string;
}

export interface DoctorOptions {
  environment: Environment;
  dir?: string;
  /** How long to watch live_vehicle.json when the game is running. 0 skips it. */
  observeMs?: number;
  /** Where bridge-state.json lives; the user config folder by default. */
  stateDir?: string;
  /** Port to look for a running bridge on; null skips the check. */
  serverPort?: number | null;
  now?: () => number;
}

type Json = Record<string, unknown>;

/** Reads a dotted path out of loosely typed probe data. */
function get(value: unknown, path: string): unknown {
  let current = value;
  for (const key of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Json)[key];
  }
  return current;
}

const show = (value: unknown): string =>
  value === undefined ? "missing" : typeof value === "string" ? value : JSON.stringify(value);

const ageSec = (now: number, mtimeMs: number | undefined) =>
  mtimeMs === undefined ? null : Math.round((now - mtimeMs) / 100) / 10;

async function observe(file: string, durationMs: number) {
  const watcher = new LiveWatcher({ file, schema: LiveVehicle, pollMs: 50, onFrame: () => {} });
  watcher.start();
  await new Promise((resolve) => setTimeout(resolve, durationMs));
  watcher.stop();
  return { ...watcher.stats, durationMs };
}

async function readAppendTest(root: string): Promise<string> {
  try {
    const text = (await readFile(join(root, FILES.probeDir, "append_test.txt"), "utf8")).replace(
      /\r\n/g,
      "\n",
    );
    if (text === "first\nsecond\n") return "append works";
    if (text === "second\n") return "append truncates like w";
    if (text === "first\n") return "append refused";
    return `unexpected content ${JSON.stringify(text)}`;
  } catch {
    return "append_test.txt missing";
  }
}

async function readHandleTest(root: string): Promise<string | undefined> {
  try {
    return await readFile(join(root, FILES.probeDir, "handle_test.txt"), "utf8");
  } catch {
    return undefined;
  }
}

function checkLoaded(report: DoctorReport): Check {
  const valid = report.saves.filter((s) => s.meta === "ok");
  if (!report.root.exists) {
    return {
      id: "loaded",
      title: "Mod loads and resolves the modSettings path",
      status: "pending",
      detail: `${report.root.root} does not exist yet: enable FS25_FarmLink and load a savegame`,
    };
  }
  return {
    id: "loaded",
    title: "Mod loads and resolves the modSettings path",
    status: valid.length > 0 ? "pass" : "fail",
    detail:
      valid.length > 0
        ? `${valid.length} save folder(s) with a valid meta.json under ${report.root.root}`
        : "the folder exists but holds no valid meta.json",
  };
}

function checkUpdates(report: DoctorReport): Check {
  const title = "live_vehicle.json updates cleanly in single-player";
  const o = report.observation;
  if (o === null) {
    return {
      id: "updates",
      title,
      status: "pending",
      detail: "the game is not running; run --doctor while sitting in a vehicle",
    };
  }
  const expected = Math.floor(o.durationMs / 1000) - 1;
  const clean = o.tornReads === 0 && o.invalid === 0 && o.frames >= expected;
  return {
    id: "updates",
    title,
    status: clean ? "pass" : "fail",
    detail: `${o.frames} frames in ${o.durationMs / 1000} s, ${o.tornReads} torn, ${o.invalid} invalid, ${o.retriedReads} needed a retry`,
  };
}

function checkWriteCost(meta: Json | undefined, probe: unknown): Check {
  const title = `Live write costs under ${WRITE_BUDGET_MS} ms`;
  const stats = meta?.stats as Json | undefined;
  const writes = stats?.liveWrites;
  const avg = stats?.liveWriteAvgMs;
  const max = stats?.liveWriteMaxMs;
  const timer = get(probe, "sections.liveWrites.timer");
  if (typeof avg !== "number" || typeof writes !== "number" || writes === 0) {
    return {
      id: "cost",
      title,
      status: "pending",
      detail: "no timed writes yet: play for a minute, save, then run --doctor",
    };
  }
  if (timer === null || timer === undefined) {
    return {
      id: "cost",
      title,
      status: "pending",
      detail: "the game offers no precise timer to FarmLink; see probe.json clock section",
    };
  }
  return {
    id: "cost",
    title,
    status: avg < WRITE_BUDGET_MS ? "pass" : "fail",
    detail: `average ${avg} ms, max ${show(max)} ms over ${writes} writes (timer ${show(timer)})`,
  };
}

function probeChecks(probe: unknown, appendResult: string): Check[] {
  const s = (path: string) => get(probe, `sections.${path}`);
  const answered = (id: string, title: string, detail: string, done: boolean): Check => ({
    id,
    title,
    status: done ? "pass" : "pending",
    detail,
  });

  const modes = (s("files.ioModes") ?? {}) as Json;
  const fileDetail = [
    `io.open w=${show(modes.w)} a=${show(modes.a)} r=${show(modes.r)} rb=${show(modes.rb)}`,
    appendResult,
    `createFile ${show(s("files.engineWrite.existsAfter"))}`,
    `XMLFile round trip ${show(s("files.xmlRoundTrip.result"))}`,
    `deleteFile plain kept=${show(s("files.delete.plain.existsAfter"))} doubled-slash kept=${show(s("files.delete.doubledSlash.existsAfter"))}`,
  ].join("; ");

  const events = (s("ai.events") ?? []) as Json[];
  const reasons = events.filter((e) => e.kind === "stopped").map((e) => show(e.reason));
  const harvestLiters = s("field.harvestLiters");
  const saves = (s("save.saves") ?? []) as Json[];
  const addMoneyCalls = s("money.addMoneyCalls");

  return [
    answered("item1", "1. Engine file API", fileDetail, modes.w !== undefined),
    answered(
      "item2",
      "2. modSettings directory",
      `g_modSettingsDirectory=${show(s("paths.g_modSettingsDirectory"))}; g_currentModSettingsDirectory=${show(s("paths.g_currentModSettingsDirectory"))}; resolved from ${show(s("paths.resolvedFrom"))}`,
      s("paths.resolvedFrom") !== undefined,
    ),
    answered(
      "item3",
      "3. Atomic rename",
      `os.rename=${show(s("rename.osRename"))} ${show(s("rename.osRenameTest"))}; renameFile=${show(s("rename.renameFile"))}`,
      s("rename.osRename") !== undefined,
    ),
    answered(
      "item4",
      "4. addMoney and MoneyType",
      `addMoney calls ${show(addMoneyCalls)}, Farm.changeBalance calls ${show(s("money.changeBalanceCalls"))}, outside addMoney ${show(s("money.changeBalanceOutsideAddMoney"))}; ${((s("money.moneyTypes.types") ?? []) as unknown[]).length} money types`,
      typeof addMoneyCalls === "number" && addMoneyCalls > 0,
    ),
    answered(
      "item5",
      "5. Combine fill gain and field lookup",
      `hook on ${show(s("field.harvestHookVehicleTypes"))} vehicle types, ${show(harvestLiters)} liters seen ${show(s("field.litersByFarmlandAndFillType"))}; here ${show(s("field.here"))}`,
      typeof harvestLiters === "number" && harvestLiters > 0,
    ),
    answered(
      "item6",
      "6. AI start and stop",
      `${events.length} events; stop reasons ${reasons.length > 0 ? reasons.join(", ") : "none yet"}`,
      reasons.length > 0,
    ),
    answered(
      "item7",
      "7. Career save hook",
      `hook installed ${show(s("save.hookInstalled"))}; ${saves.length} saves; farmLink.xml written ${show(saves.at(-1)?.farmLinkXmlExists)}`,
      saves.some((save) => save.farmLinkXmlExists === true),
    ),
    answered(
      "item9",
      "9. Lua dialect",
      `${show(s("runtime.version"))}, LuaJIT ${show(s("runtime.luajit"))}, goto ${show(s("runtime.gotoStatement"))}`,
      s("runtime.version") !== undefined,
    ),
  ];
}

/** Collects everything support needs: paths, saves, file freshness, the P0 criteria and the probe. */
export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const now = options.now ?? Date.now;
  const resolved = resolveRoot(options.environment, options.dir);
  const root = { ...resolved, exists: existsSync(resolved.root) };
  const folders = await listSaves(root.root);

  const saves: DoctorReport["saves"] = [];
  for (const folder of folders) {
    const live = await readJsonFile(join(folder.dir, FILES.liveVehicle), LiveVehicle);
    saves.push({
      saveId: folder.saveId,
      saveName: folder.meta?.saveName ?? null,
      modVersion: folder.meta?.modVersion ?? null,
      gameVersion: folder.meta?.gameVersion ?? null,
      mode: folder.meta?.mode ?? null,
      beat: folder.meta?.beat ?? null,
      metaAgeSec: ageSec(now(), folder.metaMtimeMs),
      liveAgeSec: ageSec(now(), folder.liveMtimeMs),
      meta: folder.meta ? "ok" : (folder.metaError ?? "missing"),
      live: live.ok ? "ok" : live.error,
    });
  }

  const active = folders[0];
  let observation: DoctorReport["observation"] = null;
  const observeMs = options.observeMs ?? 5000;
  if (
    active?.liveMtimeMs !== undefined &&
    now() - active.liveMtimeMs < GAME_RUNNING_WITHIN_MS &&
    observeMs > 0
  ) {
    observation = await observe(join(active.dir, FILES.liveVehicle), observeMs);
  }

  const probePath = join(root.root, FILES.probeDir, FILES.probe);
  const probeRead = await readJsonFile(probePath, ProbeReport);
  let probe: DoctorReport["probe"] = null;
  if (probeRead.ok || probeRead.reason !== "missing") {
    let probeAge: number | null = null;
    try {
      probeAge = ageSec(now(), (await stat(probePath)).mtimeMs);
    } catch {}
    probe = { ageSec: probeAge, error: probeRead.ok ? null : probeRead.error };
  }
  const probeData = probeRead.ok ? probeRead.value : undefined;

  const stateDir = options.stateDir ?? defaultStateDir(options.environment);
  const sync = syncCheck({
    stateDir,
    env: options.environment.env,
    saveId: active?.saveId,
    meta: active?.meta,
  });
  const live = await collectLive({
    saveDir: active?.dir,
    stateDir,
    serverPort: options.serverPort === undefined ? LIVE_PORT : options.serverPort,
    now: now(),
  });

  const report: DoctorReport = {
    bridge: {
      version: BRIDGE_VERSION,
      runtime: runtimeName(),
      platform: process.platform,
      arch: process.arch,
    },
    root,
    saves,
    activeSaveId: active?.saveId ?? null,
    observation,
    probe,
    live,
    checks: [],
    sync: sync.detail,
  };

  report.checks = [
    checkLoaded(report),
    checkUpdates(report),
    checkWriteCost(active?.meta as Json | undefined, probeData),
    ...(probeData
      ? probeChecks(probeData, await readAppendTest(root.root))
      : [
          {
            id: "probe",
            title: "Verify-first items 1 to 6",
            status: "pending" as const,
            detail: "no _probe/probe.json yet: load a savegame with the mod enabled",
          },
        ]),
    ...liveChecks(live),
    ...ledgerChecks(probeData, await readHandleTest(root.root)),
    ...(await eventChecks(active?.dir, active?.meta)),
    sync,
  ];
  return report;
}

const MARK: Record<CheckStatus, string> = { pass: "PASS", fail: "FAIL", pending: "TODO" };

export function formatDoctor(report: DoctorReport): string {
  const lines: string[] = [];
  const b = report.bridge;
  lines.push(`FarmLink bridge ${b.version} (${b.runtime}, ${b.platform}/${b.arch})`, "");
  lines.push(`Folder: ${report.root.root}`);
  lines.push(
    `  from ${report.root.source}; ${report.root.exists ? "exists" : "does not exist yet"}`,
  );
  for (const c of report.root.candidates) {
    lines.push(`  candidate ${c.exists ? "found  " : "missing"} ${c.path} (${c.source})`);
  }
  lines.push("", `Saves (${report.saves.length}):`);
  for (const s of report.saves) {
    const active = s.saveId === report.activeSaveId ? "*" : " ";
    lines.push(
      `${active} ${s.saveId} ${s.saveName ?? "(unnamed)"} | mod ${s.modVersion ?? "?"} on game ${s.gameVersion ?? "?"} | ${s.mode ?? "?"}`,
    );
    lines.push(
      `    meta.json ${s.meta}, ${s.metaAgeSec ?? "-"} s old, beat ${s.beat ?? "-"} | live_vehicle.json ${s.live}, ${s.liveAgeSec ?? "-"} s old`,
    );
  }
  if (report.probe) {
    lines.push(
      "",
      `Probe: _probe/probe.json ${report.probe.error ?? "ok"}, ${report.probe.ageSec ?? "-"} s old`,
    );
  }
  const section = (heading: string, checks: Check[]) => {
    lines.push("", heading);
    for (const check of checks) {
      lines.push(`  [${MARK[check.status]}] ${check.title}`);
      lines.push(`         ${check.detail}`);
    }
  };
  section(
    "P0 exit criteria and verify-first items:",
    report.checks.filter((c) => c.phase === undefined),
  );
  section(
    "P1 live page and commands:",
    report.checks.filter((c) => c.phase === "P1"),
  );
  section(
    "P2 questions, answered in the same session, and the event log:",
    report.checks.filter((c) => c.phase === "P2"),
  );
  const state = report.live.bridgeState;
  lines.push(
    `  bridge-state.json: ${state.commandEpoch ? `epoch ${state.commandEpoch}, next command ${state.nextCommandId}` : "not created yet"} (${state.path})`,
  );
  lines.push("", `Supabase sync: ${report.sync}`);
  return lines.join("\n");
}
