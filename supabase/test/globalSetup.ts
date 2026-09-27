// Once per test run: find a Postgres server (DATABASE_URL, or a throwaway cluster), and build a
// template database holding the Supabase stand-ins and every migration. Each test file then clones
// the template into its own database, so files run in parallel without sharing rows.
//
// Without Postgres the SQL tests are skipped, unless REQUIRE_POSTGRES is set (CI sets it).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { TestProject } from "vitest/node";
import { type Cluster, databaseUrl, findPostgresBin, startCluster } from "./cluster";

declare module "vitest" {
  export interface ProvidedContext {
    /** Server URL (maintenance database), or null when no Postgres was found. */
    postgresUrl: string | null;
    templateDatabase: string;
  }
}

const here = fileURLToPath(new URL(".", import.meta.url));
const migrationsDir = join(here, "../migrations");
const TEMPLATE = "farmlink_template";

export function migrationFiles(): string[] {
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => join(migrationsDir, name));
}

export default async function setup(project: TestProject) {
  let cluster: Cluster | undefined;
  let serverUrl = process.env.DATABASE_URL ?? null;
  if (!serverUrl) {
    const bin = findPostgresBin();
    if (bin) {
      cluster = await startCluster(bin);
      serverUrl = cluster.url;
    } else if (process.env.REQUIRE_POSTGRES) {
      throw new Error("REQUIRE_POSTGRES is set, but there is no DATABASE_URL and no initdb");
    }
  }

  project.provide("postgresUrl", serverUrl);
  project.provide("templateDatabase", TEMPLATE);
  if (!serverUrl) return;

  const admin = new pg.Client({ connectionString: serverUrl });
  await admin.connect();
  try {
    await admin.query(`drop database if exists ${TEMPLATE}`);
    await admin.query(`create database ${TEMPLATE}`);
  } finally {
    await admin.end();
  }

  const template = new pg.Client({ connectionString: databaseUrl(serverUrl, TEMPLATE) });
  await template.connect();
  try {
    await template.query(readFileSync(join(here, "shim.sql"), "utf8"));
    for (const file of migrationFiles()) {
      try {
        await template.query(readFileSync(file, "utf8"));
      } catch (error) {
        throw new Error(`${file}: ${(error as Error).message}`);
      }
    }
  } finally {
    await template.end();
  }

  return async () => {
    if (cluster) {
      cluster.stop();
      return;
    }
    const cleanup = new pg.Client({ connectionString: serverUrl });
    await cleanup.connect();
    await cleanup.query(`drop database if exists ${TEMPLATE}`).finally(() => cleanup.end());
  };
}
