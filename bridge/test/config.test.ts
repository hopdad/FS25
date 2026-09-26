import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  candidateRoots,
  type Environment,
  expandWindowsVariables,
  normalizeOverride,
  resolveRoot,
} from "../src/config";

const GAME = join("My Games", "FarmingSimulator2025", "modSettings", "FS25_FarmLink");

const windows = (documents?: string): Environment => ({
  platform: "win32",
  home: "C:\\Users\\sam",
  env: { USERPROFILE: "C:\\Users\\sam" },
  windowsDocuments: () => documents,
});

describe("candidateRoots", () => {
  it("puts the registry's Documents folder first on Windows, then the usual spots", () => {
    const paths = candidateRoots(windows("D:\\OneDrive\\Docs")).map((c) => c.path);
    expect(paths).toEqual([
      join("D:\\OneDrive\\Docs", GAME),
      join("C:\\Users\\sam", "Documents", GAME),
      join("C:\\Users\\sam", "OneDrive", "Documents", GAME),
    ]);
  });

  it("does not list the same folder twice", () => {
    const paths = candidateRoots(windows(join("C:\\Users\\sam", "Documents"))).map((c) => c.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("uses Application Support on macOS", () => {
    const [first] = candidateRoots({ platform: "darwin", home: "/Users/sam", env: {} });
    expect(first?.path).toBe(
      join(
        "/Users/sam",
        "Library",
        "Application Support",
        "FarmingSimulator2025",
        "modSettings",
        "FS25_FarmLink",
      ),
    );
  });

  it("looks inside the Proton prefix on Linux and Steam Deck", () => {
    const paths = candidateRoots({ platform: "linux", home: "/home/deck", env: {} }).map(
      (c) => c.path,
    );
    expect(paths).toHaveLength(2);
    expect(paths[0]).toContain(join("compatdata", "2300320", "pfx", "drive_c"));
    expect(paths[0]?.endsWith(join("Documents", GAME))).toBe(true);
  });
});

describe("expandWindowsVariables", () => {
  it("expands %VAR% case-insensitively and leaves unknown names alone", () => {
    const env = { UserProfile: "C:\\Users\\sam" };
    expect(expandWindowsVariables("%USERPROFILE%\\OneDrive\\Documents", env)).toBe(
      "C:\\Users\\sam\\OneDrive\\Documents",
    );
    expect(expandWindowsVariables("%NOPE%\\x", env)).toBe("%NOPE%\\x");
  });
});

describe("normalizeOverride", () => {
  it("accepts the FS25_FarmLink folder, the modSettings folder or the profile folder", () => {
    const profile = mkdtempSync(join(tmpdir(), "profile-"));
    mkdirSync(join(profile, "modSettings"));
    const target = join(profile, "modSettings", "FS25_FarmLink");
    expect(normalizeOverride(target)).toBe(target);
    expect(normalizeOverride(join(profile, "modSettings"))).toBe(target);
    expect(normalizeOverride(profile)).toBe(target);
    expect(normalizeOverride("/somewhere/else")).toBe("/somewhere/else");
  });
});

describe("resolveRoot", () => {
  it("prefers --dir, then FARMLINK_DIR", () => {
    const env = { ...windows(), env: { USERPROFILE: "C:\\Users\\sam", FARMLINK_DIR: "/srv/fs" } };
    expect(resolveRoot(env, "/games/FS25_FarmLink")).toMatchObject({
      root: "/games/FS25_FarmLink",
      source: "--dir",
    });
    expect(resolveRoot(env)).toMatchObject({ root: "/srv/fs", source: "FARMLINK_DIR" });
  });

  it("takes the first candidate that exists, or the likeliest when none does", () => {
    const home = mkdtempSync(join(tmpdir(), "home-"));
    const macEnv: Environment = { platform: "darwin", home, env: {} };
    const expected = join(
      home,
      "Library",
      "Application Support",
      "FarmingSimulator2025",
      "modSettings",
      "FS25_FarmLink",
    );
    expect(resolveRoot(macEnv).root).toBe(expected);
    expect(resolveRoot(macEnv).candidates[0]?.exists).toBe(false);
    mkdirSync(expected, { recursive: true });
    expect(resolveRoot(macEnv).candidates[0]?.exists).toBe(true);
  });
});
