import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeFileAtomic } from "../src/fsutil";
import { tempRoot } from "./fixtures";

function failing(code: string, times: number) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    rename: async (from: string, to: string) => {
      calls++;
      if (calls <= times) throw Object.assign(new Error(`${code}: busy`), { code });
      await rename(from, to);
    },
  };
}

describe("writeFileAtomic", () => {
  it("replaces the file and leaves no temporary file behind", async () => {
    const dir = tempRoot();
    const path = join(dir, "commands.xml");
    writeFileSync(path, "old");
    expect(await writeFileAtomic(path, "new")).toBe(1);
    expect(readFileSync(path, "utf8")).toBe("new");
    expect(readdirSync(dir)).toEqual(["commands.xml"]);
  });

  it("retries while Windows reports the file as in use", async () => {
    const dir = tempRoot();
    const path = join(dir, "commands.xml");
    const fake = failing("EPERM", 2);
    expect(await writeFileAtomic(path, "text", { rename: fake.rename, backoffMs: [1, 1, 1] })).toBe(
      3,
    );
    expect(readFileSync(path, "utf8")).toBe("text");
  });

  it("gives up after the last backoff and cleans up", async () => {
    const dir = tempRoot();
    const path = join(dir, "commands.xml");
    const fake = failing("EBUSY", 10);
    await expect(
      writeFileAtomic(path, "text", { rename: fake.rename, backoffMs: [1, 1] }),
    ).rejects.toThrow("EBUSY");
    expect(fake.calls).toBe(3);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("does not retry errors that waiting cannot fix", async () => {
    const dir = tempRoot();
    const fake = failing("ENOSPC", 1);
    await expect(
      writeFileAtomic(join(dir, "commands.xml"), "text", { rename: fake.rename, backoffMs: [1] }),
    ).rejects.toThrow("ENOSPC");
    expect(fake.calls).toBe(1);
  });
});
