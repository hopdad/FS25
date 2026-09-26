import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { MOD_NAME } from "@farmlink/schema";

/** Steam app id of Farming Simulator 25, for the Proton prefix on Linux and Steam Deck. */
const FS25_STEAM_APP_ID = "2300320";
const GAME_FOLDER = "FarmingSimulator2025";

export interface Environment {
  platform: NodeJS.Platform;
  home: string;
  env: Record<string, string | undefined>;
  /** Windows' real Documents folder, which may be redirected to OneDrive. Injected for tests. */
  windowsDocuments?: () => string | undefined;
}

export interface Candidate {
  /** The FS25_FarmLink folder inside modSettings. */
  path: string;
  source: string;
}

export function currentEnvironment(): Environment {
  return {
    platform: process.platform,
    home: process.env.HOME ?? process.env.USERPROFILE ?? "",
    env: process.env,
    windowsDocuments: readWindowsDocumentsFolder,
  };
}

/**
 * Reads the Documents folder from the registry: new Windows installs often redirect it to OneDrive,
 * so %USERPROFILE%\Documents may not be where the game writes.
 */
export function readWindowsDocumentsFolder(): string | undefined {
  try {
    const output = execFileSync(
      "reg",
      [
        "query",
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders",
        "/v",
        "Personal",
      ],
      { encoding: "utf8", timeout: 3000, windowsHide: true },
    );
    const match = output.match(/Personal\s+REG_(?:EXPAND_)?SZ\s+(.+)/);
    if (!match?.[1]) return undefined;
    return expandWindowsVariables(match[1].trim(), process.env);
  } catch {
    return undefined;
  }
}

/** Expands %NAME% references the way the registry's REG_EXPAND_SZ values expect. */
export function expandWindowsVariables(
  value: string,
  env: Record<string, string | undefined>,
): string {
  return value.replace(/%([^%]+)%/g, (whole, name: string) => {
    const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
    return key !== undefined ? (env[key] ?? whole) : whole;
  });
}

function modSettingsIn(profileDir: string): string {
  return join(profileDir, "modSettings", MOD_NAME);
}

/** Every place the game's profile folder usually lives on this platform, most likely first. */
export function candidateRoots(environment: Environment): Candidate[] {
  const { platform, home, env } = environment;
  const out: Candidate[] = [];
  const add = (profileDir: string, source: string) => {
    const path = modSettingsIn(profileDir);
    if (!out.some((c) => c.path === path)) out.push({ path, source });
  };

  if (platform === "win32") {
    const documents = environment.windowsDocuments?.();
    if (documents) add(join(documents, "My Games", GAME_FOLDER), "registry Documents folder");
    const profile = env.USERPROFILE ?? home;
    add(join(profile, "Documents", "My Games", GAME_FOLDER), "%USERPROFILE%\\Documents");
    add(join(profile, "OneDrive", "Documents", "My Games", GAME_FOLDER), "OneDrive Documents");
  } else if (platform === "darwin") {
    add(join(home, "Library", "Application Support", GAME_FOLDER), "macOS Application Support");
  } else {
    for (const steam of [join(home, ".steam", "steam"), join(home, ".local", "share", "Steam")]) {
      add(
        join(
          steam,
          "steamapps",
          "compatdata",
          FS25_STEAM_APP_ID,
          "pfx",
          "drive_c",
          "users",
          "steamuser",
          "Documents",
          "My Games",
          GAME_FOLDER,
        ),
        "Steam Proton prefix",
      );
    }
  }
  return out;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Turns a user-supplied folder into the FS25_FarmLink folder. Accepts that folder itself, the
 * modSettings folder, or the game's profile folder (the one holding mods/ and savegame1/), which is
 * what a dedicated server's profile path usually points at.
 */
export function normalizeOverride(dir: string): string {
  if (basename(dir) === MOD_NAME) return dir;
  if (basename(dir) === "modSettings") return join(dir, MOD_NAME);
  if (isDirectory(join(dir, "modSettings"))) return modSettingsIn(dir);
  return dir;
}

export interface ResolvedRoot {
  root: string;
  source: string;
  candidates: Array<Candidate & { exists: boolean }>;
}

/**
 * The FS25_FarmLink folder to read. An explicit --dir or FARMLINK_DIR wins; otherwise the first
 * candidate that exists, or the most likely one when none does yet (the mod creates it on first
 * load).
 */
export function resolveRoot(environment: Environment, override?: string): ResolvedRoot {
  const candidates = candidateRoots(environment).map((c) => ({ ...c, exists: existsSync(c.path) }));
  const explicit = override ?? environment.env.FARMLINK_DIR;
  if (explicit) {
    return {
      root: normalizeOverride(explicit),
      source: override ? "--dir" : "FARMLINK_DIR",
      candidates,
    };
  }
  const found = candidates.find((c) => c.exists) ?? candidates[0];
  if (!found) {
    throw new Error(`no default location on ${environment.platform}; pass --dir`);
  }
  return { root: found.path, source: found.source, candidates };
}
