// The sync part of --doctor (P2): whether this bridge syncs, and how far the active save's event
// log has reached Supabase. It never prints tokens or the account's email address.

import type { Meta } from "@farmlink/schema";
import type { Check } from "./doctor";
import { readSupabaseConfig, SessionStore } from "./sync/auth";
import { SyncCursorStore } from "./sync/cursor";

const short = (id: string) => id.slice(0, 8);

export function syncCheck(options: {
  stateDir: string;
  env: Record<string, string | undefined>;
  saveId: string | undefined;
  meta: Meta | undefined;
}): Check {
  const check = (status: Check["status"], detail: string): Check => ({
    id: "sync",
    title: "Supabase sync: signed in, the event log uploaded",
    status,
    detail,
    phase: "P2",
  });
  const { config, error } = readSupabaseConfig(options.stateDir, options.env);
  if (error !== undefined) return check("fail", error);
  if (config === undefined) {
    return check("pending", "no Supabase project set up; the bridge works on the LAN only");
  }
  if (new SessionStore(options.stateDir).load(config.url) === undefined) {
    return check("pending", "not signed in: run farmlink-bridge --sign-in <your email>");
  }
  const { saveId, meta } = options;
  if (saveId === undefined) return check("pending", "signed in; no save folder yet");

  const cursor = SyncCursorStore.read(options.stateDir)?.saves[saveId];
  const heads = meta?.heads ?? {};
  let waiting = 0;
  for (const [branchId, head] of Object.entries(heads)) {
    waiting += Math.max(0, head - (cursor?.branches[branchId] ?? 0));
  }
  const parts = [`signed in; save ${short(saveId)}`];
  if (meta) {
    const synced = cursor?.branches[meta.branchId] ?? 0;
    parts.push(`current branch at seq ${synced} of ${heads[meta.branchId] ?? meta.lastSeq}`);
  }
  parts.push(waiting === 0 ? "nothing waiting" : `${waiting} lines not uploaded yet`);
  parts.push(cursor?.lastSyncedAt ? `last upload ${cursor.lastSyncedAt}` : "never uploaded");
  const refused = cursor?.rejected.length ?? 0;
  if (refused > 0) {
    const last = cursor?.rejected.at(-1);
    parts.push(`${refused} refused (last: seq ${last?.seq}, ${last?.error})`);
  }
  return check(refused > 0 ? "fail" : waiting === 0 ? "pass" : "pending", parts.join("; "));
}
