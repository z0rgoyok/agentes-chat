# 0233. Devices as extra capacity

- Status: Accepted (phase 1)
- Date: 2026-11-24
- Amends: ADR 0032's spill-over addendum (2026-11-12): which runs spill, when, where, and the switches
- Code: db `packages/db/src/schema/agents.ts` (`organization_settings.devices_help`, migration `0346_devices_help`),
  `schema/machines.ts` (`spill_own` is the switch; `spill_others` retired); engine `spill.ts` (`spillTarget`,
  `spillMayHelp`, `SPILL_AFTER_MS`, `SpillRecord`), `executor.ts` (`spillOver`, the room gate, the offline and paused
  branch of `brainUnavailable`, the re-entry look, `meta.spilled` in `withFallback`), `devices.ts` (`spill`,
  `devicesHelp`, `devicesHelpOn`, `setDevicesHelp`), `machine-clis.ts` (`installHelpClis`), `device-resolve.ts`
  (`autoComputer`, the free computers in `computer_status`), `sandbox-tools.ts` (`start_task` `computer: "auto"`);
  server `routes/devices.ts` (`PUT …/devices/help`, the PATCH starting installs); client `lib/devices.ts`
  (`spilledText`); web `devices/DevicePage.tsx`, `devices/DevicesSection.tsx`, `ComputerQueue.tsx`,
  `computer/ComputerDialog.tsx`, `pages/ConnectPage.tsx`, `ChatNotices.tsx` (`SpilledLine`); phone
  `features/devices/ComputerSection.tsx`, `features/devices/DevicesScreen.tsx`, `features/queue/QueueSheet.tsx`,
  `features/chat/StoppedLine.tsx` (`SpilledLine`)

## Context

A workspace's computer has a ceiling: memory, the line of runs waiting for it, and each sign-in's own concurrency. When
it is full, or away (offline, paused by its owner, moving to another server), every agent on it waits, even though
people's own computers are often online and idle. Spill-over (ADR 0032, 2026-11-12) let only one kind of run use them:
the first turn of a reply a person waits on, while the home computer is full, on a computer whose owner turned on
"Your replies can think here" (or "Other people's agents can think here").

Agents' asks, routines and long work never spilled, a home computer that was away never spilled, and a personal
computer could take other people's agents, whose commands run there as its owner.

## Decision

1. **One switch per computer**: "Help when the team's computer is full or away" (`machines.spill_own`, on by default,
   as before). Only whoever connected the computer turns it on; an admin may turn it off. `spill_others` is retired and
   nothing reads it.
2. **One switch per workspace**: admins can turn devices' help off for everyone (`organization_settings.devices_help`,
   on without a row). Off wins over every computer's own switch.
3. **Which runs**: a fresh turn (`turns === 0`, no computer turn yet in the claim) of a reply, an agent's ask, a
   routine's run or long work at its start. Never a mission's or a code session's turn (its worktree is at home), an
   agent with repositories (it works in its checkouts there), the right hand, or a turn only its own computer may
   finish.
4. **When**: the home computer is full (behind others in its line, or refused for room) — a person's reply looks at
   once, anything else after waiting `SPILL_AFTER_MS` (60 s) and then once per `SPILL_AFTER_MS` while it finds none
   (`spillLookedAt`: each look claims the run, so a full line never re-claims every run on every retry) — or away at
   the run's start: offline past the blip
   grace, or paused by its owner. A computer waking from standby is never away: the run waits for it.
5. **Where**: an online, unpaused computer of the workspace with commands on, its switch on, nothing waiting in its own
   line, never a server install (no OS user of the agent there). A person's own computer takes only its owner's agents;
   other people's agents only go to a computer marked the workspace's. This holds until agents' commands are isolated
   from the owner's files (ADR 0030 level 2). The person the run works for must be allowed to use the computer unless
   it is theirs.
6. **Sign-in**: the agent's owner's own sign-in on that computer, else the computer's own login when its owner is the
   agent's owner. Nothing else: no sign-in is copied between computers (it would add no capacity: limits are per
   account).
7. **Installs**: turning the switch on starts installing, with the vendor's installer as the person, the CLIs their
   agents think with that the computer lacks (`installHelpClis`, the existing `cli.install`).
8. **People see it**: the reply says where it thought and why, under it ("Thought on Bruno's MacBook: the team's
   computer was full"), as `meta.spilled` `{ to, from, cause: "full" | "away" }`. The agent's own computer dialog says
   which computers help while it is away.
9. **Agents see it**: `computer_status` lists the computers free to help now, and `start_task` takes
   `computer: "auto"`: the agent's own computer while it has room, else a free one that helps (same rules as 5).

## Consequences

- A busy or away team computer no longer stops a workspace whose people have computers online; the reply says so.
- A personal computer runs only its owner's agents, on its owner's plan. Other people's agents need a computer marked
  the workspace's, or isolation (phase 2).
- A spilled run keeps thinking there in its own session; if that computer goes, its home takes it in a fresh session
  (as before).
- Phase 2 (not built): isolation on personal computers (other people's agents there), and the wait line naming where a
  run will think.
