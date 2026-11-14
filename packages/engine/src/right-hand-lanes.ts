import type { Database } from "@agenteschat/db";
import type { JobDeps } from "./jobs";
import { type JobHandlers, PermanentJobError } from "./outbox";
import { lodiLanes } from "./right-hand-lane";
import { enqueueTeamWeeks } from "./team-week";
// Each lane adds itself to the list as its file loads.
import "./approvals-digest";
import "./right-hand-follow";
import "./right-hand-welcome";
import "./team-watch";

/**
 * Where the server reads the right hand's lanes from: the job handlers and the worker's sweep. Each takes the lanes
 * as its last argument, so a test plugs in one of its own. Only the top of the server imports this file: it loads
 * every lane, and a lane imports half the engine.
 */

const orgOf = (job: { kind: string; orgId: string | null }) => {
  if (!job.orgId) throw new PermanentJobError(`job ${job.kind} needs an organization`);
  return job.orgId;
};

/** The lanes' jobs as outbox handlers. */
export function lodiLaneHandlers(deps: JobDeps, lanes = lodiLanes()): JobHandlers {
  const handlers: JobHandlers = {};
  for (const lane of lanes)
    for (const [kind, run] of Object.entries(lane.jobs))
      handlers[kind] = async (job) => {
        await run(deps, orgOf(job), job.payload);
      };
  return handlers;
}

/**
 * What the right hand has due everywhere: the day's and the week's cards, then each lane's sweep. One failing does not
 * hold the others back: it is thrown once all ran. Returns how many jobs were queued.
 */
export async function enqueueRightHandChecks(db: Database, now = new Date(), lanes = lodiLanes()): Promise<number> {
  const sweeps = [enqueueTeamWeeks, ...lanes.flatMap((l) => (l.sweep ? [l.sweep] : []))];
  const results = await Promise.allSettled(sweeps.map((sweep) => sweep(db, now)));
  const failed = results.find((r) => r.status === "rejected");
  if (failed) throw failed.reason;
  return results.reduce((n, r) => n + (r.status === "fulfilled" ? r.value : 0), 0);
}
