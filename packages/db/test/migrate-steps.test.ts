import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { migrateInSteps, migrationsFolder } from "../src/client";

const migrations = readMigrationFiles({ migrationsFolder });
/** 0215 adds channel_kind's `task`, and 0229 uses it: a server from before 0215 meets both in one update. */
const beforeTask = migrations.findIndex((m) => m.sql.some((s) => s.includes("ADD VALUE 'task'")));
/** The migration that builds the outbox's indexes, and so must not hold the queue's writes while it does. */
const beforeBusy = migrations.findIndex((m) => m.sql.some((s) => s.includes('"outbox_created_idx"')));
/** The indexes it builds concurrently. */
const BUSY = "array['outbox_created_idx', 'outbox_run_jobs_idx', 'agent_run_steps_tool_calls_idx']::regclass[]";

/** Why Postgres refuses the pending migrations as Drizzle's own migrate runs them: all in one transaction. */
const refusal = (db: Parameters<typeof migrate>[0]) =>
  migrate(db, { migrationsFolder }).then(
    () => "",
    (e: Error & { cause?: Error }) => e.cause?.message ?? e.message,
  );

test("a database several versions behind migrates in one go, enum values added and used on the way", async () => {
  expect(beforeTask).toBeGreaterThan(0);
  const pg = new PGlite({ extensions: { vector } });
  const db = drizzle(pg);
  try {
    await migrateInSteps(db, migrationsFolder, beforeTask);
    expect(await refusal(db)).toContain('unsafe use of new value "task"');
    await migrateInSteps(db, migrationsFolder);
    const { rows } = await pg.query<{ n: number }>("select count(*)::int as n from drizzle.__drizzle_migrations");
    expect(rows[0]?.n).toBe(migrations.length);
  } finally {
    await pg.close();
  }
}, 180_000);

test("an index of a busy table is built in no transaction, and again when a build left it invalid", async () => {
  expect(beforeBusy).toBeGreaterThan(0);
  const pg = new PGlite({ extensions: { vector } });
  const db = drizzle(pg);
  const state = async () => {
    const { rows } = await pg.query(
      `select (select count(*)::int from drizzle.__drizzle_migrations) as applied,
              (select count(*)::int from pg_index where indexrelid = any (${BUSY}) and indisvalid) as valid`,
    );
    return rows[0];
  };
  try {
    await migrateInSteps(db, migrationsFolder, beforeBusy);
    expect(await refusal(db)).toContain("CONCURRENTLY cannot run inside a transaction block");
    await migrateInSteps(db, migrationsFolder, beforeBusy + 1);
    expect(await state()).toEqual({ applied: beforeBusy + 1, valid: 3 });
    // Builds that were cut short: their indexes are there, invalid, and the migration unrecorded.
    await pg.exec(
      `update pg_index set indisvalid = false where indexrelid = any (${BUSY});
       delete from drizzle.__drizzle_migrations where created_at = ${migrations[beforeBusy]?.folderMillis}`,
    );
    await migrateInSteps(db, migrationsFolder);
    expect(await state()).toEqual({ applied: migrations.length, valid: 3 });
  } finally {
    await pg.close();
  }
}, 180_000);
