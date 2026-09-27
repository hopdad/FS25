import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { EventEnvelope, FILES } from "@farmlink/schema";
import { describeIssue } from "../watch/files";

/** One line of the event log: the event, or why it could not be read. */
export type EventLine =
  | { ok: true; file: string; line: number; event: EventEnvelope }
  | { ok: false; file: string; line: number; error: string };

interface FileState {
  /** Bytes consumed: everything up to and including the last complete line. */
  offset: number;
  lines: number;
}

/** `<day>.ndjson`, or `<day>-<session>-<n>.ndjson` where the mod keeps files open (F1). */
const EVENT_FILE = /^(\d+)(?:-[0-9a-f]+-(\d+))?\.ndjson$/;

/** Event files in the order they were written: by game day, then segment. */
export function sortEventFiles(names: string[]): string[] {
  const key = (name: string): [number, number] => {
    const match = EVENT_FILE.exec(name);
    return [Number(match?.[1] ?? 0), Number(match?.[2] ?? 0)];
  };
  return names
    .filter((name) => EVENT_FILE.test(name))
    .sort((a, b) => {
      const [dayA, segA] = key(a);
      const [dayB, segB] = key(b);
      return dayA - dayB || segA - segB || a.localeCompare(b);
    });
}

/** Parses and validates one line against the event contract. */
export function parseEventLine(text: string, file: string, line: number): EventLine {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, file, line, error: `not JSON: ${(error as Error).message}` };
  }
  const parsed = EventEnvelope.safeParse(raw);
  if (!parsed.success) return { ok: false, file, line, error: describeIssue(parsed.error) };
  return { ok: true, file, line, event: parsed.data };
}

/**
 * Follows the mod's event log, `events/*.ndjson` in a save's folder. Each read returns the complete
 * lines added since the last one, file by file in the order they were written. A line counts once
 * its newline is there, so a batch caught mid-write is picked up whole on the next read.
 */
export class EventLogReader {
  private readonly files = new Map<string, FileState>();
  readonly dir: string;

  constructor(saveDir: string) {
    this.dir = join(saveDir, FILES.eventsDir);
  }

  /** Bytes consumed per file. */
  get offsets(): Record<string, number> {
    return Object.fromEntries([...this.files].map(([name, state]) => [name, state.offset]));
  }

  async read(): Promise<EventLine[]> {
    let names: string[];
    try {
      names = sortEventFiles(await readdir(this.dir));
    } catch {
      return [];
    }
    const out: EventLine[] = [];
    for (const name of names) {
      out.push(...(await this.readFile(name)));
    }
    return out;
  }

  private async readFile(name: string): Promise<EventLine[]> {
    const path = join(this.dir, name);
    const state = this.files.get(name) ?? { offset: 0, lines: 0 };
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      return [];
    }
    // The mod only ever appends; a shorter file was replaced, so start it over.
    if (size < state.offset) {
      state.offset = 0;
      state.lines = 0;
    }
    if (size === state.offset) {
      this.files.set(name, state);
      return [];
    }

    const chunk = Buffer.alloc(size - state.offset);
    const handle = await open(path, "r");
    try {
      await handle.read(chunk, 0, chunk.length, state.offset);
    } finally {
      await handle.close();
    }
    const end = chunk.lastIndexOf(0x0a);
    if (end < 0) {
      this.files.set(name, state);
      return [];
    }
    // A newline never occurs inside a UTF-8 sequence, so cutting after one is safe.
    const text = chunk.subarray(0, end + 1).toString("utf8");
    state.offset += end + 1;
    this.files.set(name, state);

    const out: EventLine[] = [];
    for (const rawLine of text.split("\n")) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line.trim() === "") continue;
      state.lines += 1;
      out.push(parseEventLine(line, name, state.lines));
    }
    return out;
  }
}
