// The event log part of --doctor (P2): whether the mod's event lines parse, and whether each
// branch's seqs run on without a gap.

import type { Meta } from "@farmlink/schema";
import type { Check } from "./doctor";
import { EventLogReader } from "./events/reader";
import { SequenceCheck } from "./events/sequence";

const short = (id: string) => id.slice(0, 8);

export async function eventChecks(
  saveDir: string | undefined,
  meta: Meta | undefined,
): Promise<Check[]> {
  const check = (status: Check["status"], detail: string): Check[] => [
    {
      id: "events",
      title: "Event log: every line valid, no seq gaps",
      status,
      detail,
      phase: "P2",
    },
  ];
  if (saveDir === undefined) return check("pending", "no save folder yet");

  const reader = new EventLogReader(saveDir);
  const lines = await reader.read();
  if (lines.length === 0) {
    return check(
      "pending",
      "no events/*.ndjson yet: load a savegame with a mod build that writes the event log",
    );
  }

  const sequence = new SequenceCheck();
  const invalid: string[] = [];
  for (const line of lines) {
    if (line.ok) sequence.add(line.event);
    else invalid.push(`${line.file}:${line.line} ${line.error}`);
  }
  const files = Object.keys(reader.offsets).length;
  const branches = sequence.summary;
  const current = meta ? branches.find((branch) => branch.branchId === meta.branchId) : undefined;
  const plural = (count: number, word: string, suffix = "s") =>
    `${count} ${word}${count === 1 ? "" : suffix}`;
  const parts = [
    `${plural(lines.length, "line")} in ${plural(files, "file")} on ${plural(branches.length, "branch", "es")}`,
  ];
  if (current && meta) {
    parts.push(
      `current branch ${short(current.branchId)} at seq ${current.last} (meta.json: ${meta.lastSeq})`,
    );
  }
  const mode = meta?.stats?.events?.mode;
  if (mode) parts.push(mode === "append" ? "appending" : "append refused, files kept open");
  const problems: string[] = [];
  if (invalid.length > 0) {
    problems.push(`${invalid.length} invalid: ${invalid.slice(0, 3).join("; ")}`);
  }
  if (sequence.gaps.length > 0) {
    const gaps = sequence.gaps
      .slice(0, 3)
      .map((gap) => `${short(gap.branchId)} ${gap.after + 1}-${gap.next - 1}`)
      .join(", ");
    problems.push(`${sequence.gaps.length} gaps (${gaps})`);
  }
  if (sequence.duplicates > 0) problems.push(`${sequence.duplicates} seqs written twice`);
  return check(
    problems.length > 0 ? "fail" : "pass",
    [...parts, ...(problems.length > 0 ? problems : ["no gaps"])].join("; "),
  );
}
