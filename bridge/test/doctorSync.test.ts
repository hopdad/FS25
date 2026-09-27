import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Meta } from "@farmlink/schema";
import { describe, expect, it } from "vitest";
import { syncCheck } from "../src/doctorSync";
import { SessionStore } from "../src/sync/auth";
import { SyncCursorStore } from "../src/sync/cursor";
import { BRANCH_ID, meta, SAVE_ID, tempRoot } from "./fixtures";

const URL = "https://example.supabase.co";
const env = { FARMLINK_SUPABASE_URL: URL, FARMLINK_SUPABASE_ANON_KEY: "anon-key-0123456789abcdef" };
const FORK = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

function signedIn(): string {
  const stateDir = tempRoot();
  new SessionStore(stateDir).save({
    v: 1,
    url: URL,
    userId: "3b9a7c1e-2d4f-4e6a-8b0c-1d2e3f4a5b6c",
    email: "farmer@example.com",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    expiresAt: 0,
  });
  return stateDir;
}

const heads = meta({ lastSeq: 40, heads: { [BRANCH_ID]: 40, [FORK]: 12 } }) as Meta;

describe("--doctor's sync line", () => {
  it("says the bridge works on the LAN only without a project, and what is wrong with a bad one", () => {
    const stateDir = tempRoot();
    expect(syncCheck({ stateDir, env: {}, saveId: SAVE_ID, meta: heads })).toMatchObject({
      id: "sync",
      status: "pending",
      detail: "no Supabase project set up; the bridge works on the LAN only",
      phase: "P2",
    });
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "supabase.json"), "{ not json");
    expect(syncCheck({ stateDir, env: {}, saveId: SAVE_ID, meta: heads }).status).toBe("fail");
    expect(syncCheck({ stateDir: tempRoot(), env, saveId: SAVE_ID, meta: heads }).detail).toBe(
      "not signed in: run farmlink-bridge --sign-in <your email>",
    );
  });

  it("counts the lines not uploaded yet on every branch, without naming the account", () => {
    const stateDir = signedIn();
    const cursor = new SyncCursorStore(stateDir);
    cursor.advance(SAVE_ID, { [BRANCH_ID]: 35, [FORK]: 12 }, new Date("2026-09-27T10:00:00Z"));
    const behind = syncCheck({ stateDir, env, saveId: SAVE_ID, meta: heads });
    expect(behind).toMatchObject({
      status: "pending",
      detail:
        "signed in; save 6f1c2d3e; current branch at seq 35 of 40; 5 lines not uploaded yet; last upload 2026-09-27T10:00:00.000Z",
    });
    expect(JSON.stringify(behind)).not.toMatch(/farmer@example\.com|secret/);

    cursor.advance(SAVE_ID, { [BRANCH_ID]: 40 }, new Date("2026-09-27T10:05:00Z"));
    expect(syncCheck({ stateDir, env, saveId: SAVE_ID, meta: heads }).status).toBe("pass");

    cursor.reject(SAVE_ID, [{ branchId: BRANCH_ID, seq: 17, error: "HTTP 400 23514: check" }]);
    expect(syncCheck({ stateDir, env, saveId: SAVE_ID, meta: heads })).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("1 refused (last: seq 17, HTTP 400 23514: check)"),
    });
  });
});
