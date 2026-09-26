import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { FILES, Meta } from "@farmlink/schema";
import { readJsonFile } from "./files";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SaveFolder {
  saveId: string;
  dir: string;
  meta?: Meta;
  metaError?: string;
  metaMtimeMs?: number;
  liveMtimeMs?: number;
  /** The newest of the folder's file times: how recently the game wrote to this save. */
  lastActivityMs: number;
}

async function mtime(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return undefined;
  }
}

/** Every `<saveId>/` folder under the root, most recently active first. */
export async function listSaves(root: string): Promise<SaveFolder[]> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }

  const saves = await Promise.all(
    entries
      .filter((name) => UUID.test(name))
      .map(async (saveId): Promise<SaveFolder> => {
        const dir = join(root, saveId);
        const metaPath = join(dir, FILES.meta);
        const [metaMtimeMs, liveMtimeMs, meta] = await Promise.all([
          mtime(metaPath),
          mtime(join(dir, FILES.liveVehicle)),
          readJsonFile(metaPath, Meta, { retries: 2 }),
        ]);
        return {
          saveId,
          dir,
          meta: meta.ok ? meta.value : undefined,
          metaError: meta.ok ? undefined : meta.error,
          metaMtimeMs,
          liveMtimeMs,
          lastActivityMs: Math.max(metaMtimeMs ?? 0, liveMtimeMs ?? 0),
        };
      }),
  );
  return saves.sort((a, b) => b.lastActivityMs - a.lastActivityMs);
}

/** The save the game wrote to most recently, or a specific one when saveId is given. */
export async function pickSave(root: string, saveId?: string): Promise<SaveFolder | undefined> {
  const saves = await listSaves(root);
  if (saveId) return saves.find((s) => s.saveId === saveId);
  return saves[0];
}
