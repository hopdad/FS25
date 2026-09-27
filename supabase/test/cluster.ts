// A throwaway Postgres cluster for the SQL tests: initdb into a temp folder, start it on a free
// local port, and remove it afterwards. Used when DATABASE_URL is not set. As root (in containers)
// the server has to run as the `postgres` user, because Postgres refuses to start as root.

import { execFileSync, spawnSync } from "node:child_process";
import { chownSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Cluster {
  url: string;
  stop(): void;
}

/** The same server, another database. */
export function databaseUrl(serverUrl: string, database: string): string {
  const url = new URL(serverUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

function hasInitdb(dir: string): boolean {
  return existsSync(join(dir, "initdb"));
}

/** The folder holding initdb and pg_ctl: PG_BIN, then pg_config, then Debian's layout, then PATH. */
export function findPostgresBin(): string | undefined {
  const fromEnv = process.env.PG_BIN;
  if (fromEnv && hasInitdb(fromEnv)) return fromEnv;

  const pgConfig = spawnSync("pg_config", ["--bindir"], { encoding: "utf8" });
  const bindir = pgConfig.status === 0 ? pgConfig.stdout.trim() : "";
  if (bindir && hasInitdb(bindir)) return bindir;

  const debian = "/usr/lib/postgresql";
  if (existsSync(debian)) {
    const versions = readdirSync(debian)
      .filter((name) => /^\d+$/.test(name))
      .sort((a, b) => Number(b) - Number(a));
    for (const version of versions) {
      const dir = join(debian, version, "bin");
      if (hasInitdb(dir)) return dir;
    }
  }

  const which = spawnSync("sh", ["-c", "command -v initdb"], { encoding: "utf8" });
  const onPath = which.status === 0 ? which.stdout.trim() : "";
  return onPath ? join(onPath, "..") : undefined;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("no free port"));
      });
    });
  });
}

export async function startCluster(bin: string): Promise<Cluster> {
  const asRoot = process.getuid?.() === 0;
  const dir = mkdtempSync(join(tmpdir(), "farmlink-pg-"));
  const data = join(dir, "data");
  if (asRoot) {
    const { uid, gid } = postgresIds();
    chownSync(dir, uid, gid);
  }
  // As root, run every server command as the postgres user; otherwise as ourselves.
  const run = (command: string, args: string[]) => {
    const [file, argv] = asRoot
      ? ["runuser", ["-u", "postgres", "--", join(bin, command), ...args]]
      : [join(bin, command), args];
    execFileSync(file, argv, { stdio: "pipe" });
  };

  run("initdb", ["-D", data, "-U", "postgres", "--auth=trust", "--encoding=UTF8", "--no-locale"]);
  const port = await freePort();
  const options = `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=off`;
  run("pg_ctl", ["-D", data, "-o", options, "-l", join(dir, "server.log"), "-w", "start"]);

  return {
    url: `postgres://postgres@127.0.0.1:${port}/postgres`,
    stop() {
      try {
        run("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

function postgresIds(): { uid: number; gid: number } {
  const id = (flag: string) => Number(execFileSync("id", [flag, "postgres"], { encoding: "utf8" }));
  return { uid: id("-u"), gid: id("-g") };
}
