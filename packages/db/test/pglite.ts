import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { sql } from "drizzle-orm";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { type Database, migrateInSteps, migrationsFolder } from "../src/client";
import * as schema from "../src/schema";
import { tracingLogger, trackTransactions } from "../src/trace";

/**
 * Fresh database with all migrations applied, for tests.
 *
 * - Default: in-memory PGlite (with pgvector) inside the test process; nothing to install.
 * - With `TEST_DATABASE_URL` set: a throw-away database on a real PostgreSQL
 *   server, created per call and dropped on close (docs/adr/0003-testing-with-pglite.md).
 *
 * `pglite` is exposed for tests that exercise LISTEN/NOTIFY directly.
 */
export async function createTestDatabase(): Promise<{ db: Database; close: () => Promise<void>; pglite?: PGlite }> {
  const serverUrl = process.env.TEST_DATABASE_URL;
  if (serverUrl) return createOnServer(serverUrl);

  const client = new PGlite({ extensions: { vector }, loadDataDir: await migratedTemplate() });
  const db = trackTransactions(drizzlePglite(client, { schema, casing: "snake_case", logger: tracingLogger }));
  return { db: db as unknown as Database, close: () => client.close(), pglite: client };
}

/**
 * Test databases differ from production here alone. A new channel's agents answer in a thread (migration 0325), but
 * hundreds of tests pin answers in a channel's main timeline; the thread tests turn `reply_in_threads` on themselves,
 * and the 0325 test reruns that migration to check the production default.
 */
const TEST_DEFAULTS = `alter table channels alter column reply_in_threads set default false`;

/**
 * Migrations run into a template database whose data directory is then loaded by every fresh database (much
 * faster than migrating each time). The template is kept in this process and in a file in the system's
 * temporary folder, named after the migrations and the PGlite version: `bun test --parallel` gives every test
 * file modules of its own, so without the file each one would migrate again.
 */
let template: Promise<Blob> | undefined;
function migratedTemplate(): Promise<Blob> {
  template ??= loadTemplate().catch((error) => {
    // A failed build is not kept: the next database tries again.
    template = undefined;
    throw error;
  });
  return template;
}

async function loadTemplate(): Promise<Blob> {
  const file = join(tmpdir(), `agenteschat-test-template-${templateKey()}.tar`);
  if (existsSync(file)) return new Blob([readFileSync(file)]);

  const client = new PGlite({ extensions: { vector } });
  const template = drizzlePglite(client, { schema, casing: "snake_case" });
  await migrateInSteps(template, migrationsFolder);
  await template.execute(sql.raw(TEST_DEFAULTS));
  const dump = await client.dumpDataDir("none");
  await client.close();
  // Written beside its final name and moved there: a process starting meanwhile never reads half a file.
  const partial = `${file}.${process.pid}.${crypto.randomUUID()}`;
  writeFileSync(partial, Buffer.from(await dump.arrayBuffer()));
  renameSync(partial, file);
  return dump;
}

/** What the template depends on: every migration, their journal and the PGlite version this package pins. */
function templateKey(): string {
  const hash = createHash("sha256");
  const pins = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  hash.update(JSON.stringify([pins.dependencies, pins.devDependencies]));
  hash.update(TEST_DEFAULTS);
  hash.update(readFileSync(join(migrationsFolder, "meta", "_journal.json")));
  for (const name of readdirSync(migrationsFolder).sort()) {
    if (name.endsWith(".sql")) hash.update(name).update(readFileSync(join(migrationsFolder, name)));
  }
  return hash.digest("hex").slice(0, 32);
}

/**
 * Runs one migration's statements again, as the migrator does, on rows a test wrote. It is found by its name,
 * which a renumbering keeps.
 */
export async function runMigration(db: Database, name: string) {
  const file = readdirSync(migrationsFolder).find((f) => f.endsWith(`_${name}.sql`));
  if (!file) throw new Error(`No migration named ${name}`);
  const statements = readFileSync(join(migrationsFolder, file), "utf8").split("--> statement-breakpoint");
  for (const statement of statements) await db.execute(sql.raw(statement));
}

/** The statements `read` sent to the database, each on one line. */
export async function issuedBy(read: () => Promise<unknown>) {
  const issued: string[] = [];
  const logged = tracingLogger.logQuery;
  tracingLogger.logQuery = (query?: string) => {
    issued.push((query ?? "").replace(/\s+/g, " ").trim());
    logged();
  };
  try {
    await read();
  } finally {
    tracingLogger.logQuery = logged;
  }
  return issued;
}

/**
 * A partial index's condition as the database prints it and a statement as it was sent, brought down to the same
 * words: no casts, brackets or spaces, nor the alias `s` of the indexed rows. The planner reads rows through a partial
 * index only when the statement holds the index's condition, so a test compares the two.
 */
export const conditionWords = (text: string) => text.replace(/::\w+|[()\s]|\bs\./g, "").toLowerCase();

async function createOnServer(serverUrl: string) {
  const name = `agenteschat_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = postgres(serverUrl, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${name}`);

  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  const client = postgres(url.toString(), { max: 5, onnotice: () => {} });
  const db = trackTransactions(drizzlePostgres(client, { schema, casing: "snake_case", logger: tracingLogger }));
  await migrateInSteps(db, migrationsFolder);
  await db.execute(sql.raw(TEST_DEFAULTS));

  return {
    db: db as unknown as Database,
    close: async () => {
      await client.end({ timeout: 5 });
      await admin.unsafe(`drop database if exists ${name} with (force)`);
      await admin.end({ timeout: 5 });
    },
  };
}
