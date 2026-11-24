import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Database } from "@agenteschat/db";
import { createTestDatabase } from "@agenteschat/db/testing";
import { recordProcessVitals } from "@agenteschat/engine";
import { createLogger } from "../src/logger";
import { type BootTask, runBootTasks } from "../src/workers";

let db: Database;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDatabase());
});
afterAll(async () => {
  await close();
});

const log = createLogger("error");

test("boot work: in the only process, then in the worker; each one-off once per database, a failed one again", async () => {
  const ran: string[] = [];
  const tasks: BootTask[] = [
    { name: "backfill", once: true, run: async () => void ran.push("backfill") },
    { name: "check", run: async () => void ran.push("check") },
    {
      name: "broken",
      once: true,
      run: async () => {
        ran.push("broken");
        throw new Error("the provider was down");
      },
    },
  ];
  // A single process (self-hosting): no worker on the database, so it does the work.
  await runBootTasks({ db, role: "all", log }, tasks);
  expect(ran).toEqual(["backfill", "check", "broken"]);

  // A worker writes its vitals: app processes leave the work to it.
  const now = new Date();
  await recordProcessVitals(db, {
    id: crypto.randomUUID(),
    role: "worker",
    version: "test",
    startedAt: now,
    seenAt: now,
    rssBytes: 1,
    heapUsedBytes: 1,
    heapTotalBytes: 2,
  });
  await runBootTasks({ db, role: "all", log }, tasks);
  expect(ran).toEqual(["backfill", "check", "broken"]);

  // The worker's start: the backfill is done for this database; the check and the one that failed run again.
  await runBootTasks({ db, role: "worker", log }, tasks);
  expect(ran).toEqual(["backfill", "check", "broken", "check", "broken"]);
});
