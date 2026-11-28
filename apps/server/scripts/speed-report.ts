/**
 * Time per kind of work (`speed-report.ts` in the engine) as a table, for the people who run the server. Reads only.
 *
 *   bun run report:speed [--days 7] [--org <workspace id>] [--brain claude_code]
 *
 * In the server's container: `docker compose exec agentes bun run report:speed`.
 */
import { parseArgs } from "node:util";
import { loadConfig } from "@agenteschat/config";
import { createDatabase } from "@agenteschat/db";
import { coldCauses, preTurnSyncs, speedRuns, speedSummary, speedTable } from "@agenteschat/engine";

const { values } = parseArgs({
  options: { days: { type: "string", default: "7" }, org: { type: "string" }, brain: { type: "string" } },
});
const days = Number(values.days);
if (!Number.isFinite(days) || days <= 0 || days > 31) {
  console.error("--days takes 1 to 31");
  process.exit(2);
}
if (values.org && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(values.org)) {
  console.error("--org takes a workspace's id");
  process.exit(2);
}

const config = loadConfig();
const database = createDatabase({ url: config.DATABASE_URL, poolMax: 1 });
try {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  const runs = await speedRuns(database.db, {
    from: from.toISOString(),
    to: to.toISOString(),
    orgId: values.org ?? null,
    brain: values.brain ?? null,
  });
  const title = `Person-started runs, last ${days} days${values.brain ? `, ${values.brain}` : ""}${values.org ? ", one workspace" : ""}: ${runs.length}`;
  console.log(speedTable(title, speedSummary(runs), coldCauses(runs), await preTurnSyncs(database.db)));
} finally {
  await database.close();
}
