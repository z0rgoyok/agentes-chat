import type { Database } from "@agenteschat/db";
import type { JobDeps } from "./jobs";

/**
 * The shape each feature the right hand runs by itself plugs into the server with, and the list they add themselves
 * to. A lane is one file: it calls `defineLodiLane` once, and `right-hand-lanes.ts` imports it. From the list its
 * jobs get their handlers, its sweep runs on the worker's `rightHand` tick, its block joins the right hand's prompt in
 * a DM, and its switch shows on the right hand's page. Nothing else needs wiring.
 *
 * This module imports nothing at run time, so the prompt and the tools can ask which switches are live without
 * loading the lanes, which import half the engine.
 */

/** The switches on the right hand's page that belong to a lane. */
export const LODI_SWITCHES = ["digest", "reminders", "teamWatch", "welcomePeople"] as const;
export type LodiSwitch = (typeof LODI_SWITCHES)[number];

/** Who the right hand is talking to when a lane adds to its prompt: always its own DM with that person. */
export interface LodiPromptContext {
  orgId: string;
  /** The right hand. */
  agentId: string;
  personId: string;
}

export interface LodiLane {
  /** The switch that turns it off, on the right hand's page and through `set_team_week` or `update_workspace`. */
  switch: LodiSwitch;
  /**
   * False while the feature is not built: its switch stays off the page and out of the right hand's tools and prompt,
   * so nobody is offered a switch that does nothing. Its jobs, sweep and block are wired either way.
   */
  live: boolean;
  /** Its outbox jobs by kind. A handler is idempotent and reads its own switch: a job may run twice, or late. */
  jobs: Record<string, (deps: JobDeps, orgId: string, payload: Record<string, unknown>) => Promise<unknown>>;
  /** Queues what is due across every workspace, in one statement where it can. Returns how many jobs it queued. */
  sweep?: (db: Database, now: Date) => Promise<number>;
  /** A block of the right hand's prompt in its DM with this person, or "" for none. */
  promptBlock?: (db: Database, ctx: LodiPromptContext) => Promise<string>;
}

const lanes: LodiLane[] = [];

/** Adds a lane to the list, once, when its file loads. */
export function defineLodiLane(lane: LodiLane): LodiLane {
  lanes.push(lane);
  return lane;
}

/** Every lane, in the order of `LODI_SWITCHES`. */
export const lodiLanes = (): LodiLane[] =>
  [...lanes].sort((a, b) => LODI_SWITCHES.indexOf(a.switch) - LODI_SWITCHES.indexOf(b.switch));

/** The switches whose feature is built: the ones the right hand's page shows and its tools offer. */
export const liveLodiSwitches = (among = lodiLanes()): LodiSwitch[] => among.filter((l) => l.live).map((l) => l.switch);

/** Where a lane's failure is told. The server points it at its log and error reports when it starts. */
let report: (lane: LodiSwitch, error: unknown) => void = () => {};
export const reportLodiLaneErrors = (to: typeof report) => {
  report = to;
};

/**
 * The blocks the lanes add to the right hand's prompt in its DM with this person, empty ones left out. A lane whose
 * block fails adds none and is reported: the right hand still answers.
 */
export async function lodiPromptBlocks(db: Database, ctx: LodiPromptContext, among = lodiLanes()): Promise<string[]> {
  const blocks = await Promise.all(
    among.map(async (lane) => {
      try {
        return (await lane.promptBlock?.(db, ctx)) ?? "";
      } catch (error) {
        report(lane.switch, error);
        return "";
      }
    }),
  );
  return blocks.filter(Boolean);
}
