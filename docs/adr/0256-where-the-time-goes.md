# 0256. Where the time goes: each run's time by stage group, charted

- Status: Accepted (built: the stages each run keeps, the operator API's read and the trace's waterfall, for an
  operator's console to chart)
- Date: 2026-11-26
- Builds on: ADR 0254 (time per task, the kind of an ask), the run timings (`GET /analytics/run-timings`, a claim's
  stages in `agent_runs.profiles`)
- Code: engine `profile.ts` (`computerTurnParts`, `spanUnionMs`), `executor.ts` (the stages it marks),
  `run-timings.ts` (`STAGE_GROUPS`, `stageGroupOf`, `runWaterfall`), `stage-breakdown.ts`
  (`operatorStageBreakdown`); server `operator/analytics.ts` (`GET /analytics/stage-breakdown`), `operator/runs.ts`
  (the trace's `waterfall`)

## Context

A claim keeps its stages (`router`, `room_wait`, `claim`, `context`, `model#N`, `turn_end#N`, `persist`, `events`),
and a computer turn its runner's measures (`initMs`, `firstEventMs`, `firstTokenMs`). A person's wait for a reply on a
computer brain is mostly one stage, `model#N`, which held the update of the agent's checkouts before the turn, the
CLI's start, its wait for the model's first byte, the tools it ran and the model writing, all in one number. An API
model's tool calls ran inside the next turn's `model#N`. A wait for a computer that was offline or signed out was in no
stage. Where a reply's time went could be told for one run, by hand, and not charted.

## Decision

1. **Every stage that matters is kept per run, by name.** A computer turn's `model#N` keeps its steps as `parts`, its
   shares of the stage in the order a turn reaches them: `pre_turn_sync` (the brain's `code` phase, timed for every run),
   `cli_init` (a cold start's `initMs`, or the runner's own wait before it handed an open process the turn, `sentMs`, whichever is longer), `cli_first_byte` (the first streamed message, else the first event, less the
   start), `tools` (ours from their `tool_call` to their `tool_result` steps on the database's clock, the brain's own
   from `tool_started` to their end on the server's, each set's overlaps counted once) and `model_write`, the rest. Each
   share is cut to what the stage has left, so they add up to it. An API model's calls are a stage of their own,
   `tools#N`, between its turns. A wait for a computer for any reason but room is `waits`, before the claim, as
   `room_wait` is.
2. **Eight groups** (`STAGE_GROUPS`, one color each in a chart): `waits` (room and the rest), `context` (router, claim,
   context), `pre_turn_sync`, `cli_init`, `cli_first_byte`, `model_write` (an API turn whole too), `tools`, `finish`
   (the turn's checks, saving, events, and any name the code doesn't write).
3. **`GET /analytics/stage-breakdown?from&to[&orgId]`** under the operator token: each run's time by group, summed in
   the database a row per run, then each group's runs, median and p90 over the runs that spent time in it, overall, per
   UTC day, per kind (the ask's, ADR 0254; `agent` for another agent's message, `background` for routines and long
   work), per brain and per model (20), and the 25 slowest runs with their groups, for a drill-down. 2 days at most
   across workspaces (a day there is some tens of thousands of runs and a few seconds), 31 in one: a console reads a
   day a call.
4. **The trace's `waterfall`**: a run's claims as one timeline, each stage (a computer turn's steps drawn one after the
   other) with its group, its start from the first claim's and its time.

## Consequences

- A slow reply's time shows where it went (its checkouts, the CLI's start, the first byte, tools, the model), per day,
  kind of ask, brain and model, and a slow run opens on its own timeline.
- Tools run while a computer turn's model waits on them: a turn's steps are its shares, so a waterfall draws them one
  after the other though they interleaved. A tool of ours and one of the brain's own at the same moment count twice.
- One more read of the steps at the end of each computer turn (its tool calls' two steps), and one more stage per API
  turn that called tools.
- Profiles kept before this have no steps: their `model` stage reads as `model_write`.
