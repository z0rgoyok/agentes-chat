# 0243. The agents' /tmp in memory has one budget; idle agents' leftovers and idle desktops go when memory is short

- Status: Accepted
- Date: 2026-11-25
- Amends: ADR 0096 §3 and ADR 0185 (each agent's /tmp was in a tmpfs of its own, up to half the RAM; its /tmp on disk
  failed every launch where its filesystem couldn't be made), ADR 0058 §1 (desktops parked only as one starts)
- Code: runner `agent-users.ts` (`tmpStep`, `agentRam`, `hashedRamStep`, `agentTmpMemoryBytes`, `idleTmpLines`),
  `service.ts` (`AGENT_TMP_POOL`, `AGENT_TMP_POOL_SHARE`), `daemon.ts` (`cleanIdleTmp`, the load sample),
  `desktop-session.ts` (`STALE_WORK_MS`, `sweep`, `restore`); adapters `machine-protocol.ts`
  (`MachineLoad.agentTmpRamGb`); tests `agent-users.test.ts`, `desktop-session.test.ts`, `isolation.root.test.ts`

## Context

Each agent's tmpfs was capped at half the RAM, so together they had no cap: a computer with several agents at work
for days held gigabytes of build trees and downloads in their /tmp, pages the kernel can't drop, only swap. With its
desktops' Terminals and dev servers up for days alongside, memory ran out, the load climbed as everything waited on
swap, and the agents' browser refused to open for want of memory. Desktops were parked only when another desktop or a
headed Chrome started, never while the computer was simply short; never when a Terminal ran a command; and a runner's
restart counted every desktop as just used.

## Decision

1. **One pool for all agents' /tmp in memory.** `/run/agentes-runner-tmp-pool`, a tmpfs of 20% of the RAM (root's,
   0700), holds each agent's /tmp at `<uid>`, bound at `<its tmpfs>/tmp` at its first launch after a boot. 20%: agents
   together may use 75% of the RAM, so at least 55% stays for their programs whatever /tmp holds; it is also the
   kernel's default room for unwritten file data (`vm.dirty_ratio`). Once it is full, writes in /tmp fail there with
   "no space", never by taking the computer's memory. Each agent's own tmpfs stays, for its /dev/shm, /run/lock and
   runtime dir: what is there is memory its running programs share, and goes with them.
2. **On disk where the host says so, and the pool where that can't be made.** With `agentTmpOnDisk` (ADR 0185) /tmp is
   on the agents' filesystem on the system disk, as before, whose small files live in the page cache, which the kernel
   takes back when memory is short: the design where temp files can't take the computer's memory and small ones stay
   fast. Where that filesystem can't be made (no loop devices, no `mkfs.ext4`), the launch now runs with /tmp in the
   pool instead of failing.
3. **What idle agents left goes.** Hourly, as root, for each agent with no process but its worker: what in its /tmp
   and /dev/shm nobody touched for 6 hours goes, through `systemd-tmpfiles --clean` (never through a link, never a
   socket in use). An agent at work keeps the 10 days of ADR 0096.
4. **Idle desktops go when memory is short.** Every minute's sweep parks, while less than 1.5 GiB is available, the
   desktops nobody watches or uses and nobody touched for an hour, least recently used first, as a new desktop's start
   does: a park ends its session, its screen server and with them its Terminals and apps, and keeps what was open for
   its next start. One with a command running in a Terminal, or an app the keeper can't vouch for, may go too once
   nobody touched it for a day (`STALE_WORK_MS`). A runner that takes a desktop back keeps when it was last used (its
   file, written at each sweep).
5. **Seen in the computer's report.** The load sample carries `agentTmpRamGb`: what the pool and the agents' own
   tmpfs hold now (system mode on Linux). No protocol number, as `oomKills`.
6. **No restart for it.** The step runs only at an agent's first launch after a boot, so the containers service's hash
   names it as it was before (`hashedRamStep`): this upgrade restarts no agent's containers.

## Consequences

- Agents share the pool: one that fills it leaves the others' /tmp full until it deletes or its files age out. That
  is the price of a cap; on disk (`agentTmpOnDisk`) the room is half the system disk's free space instead.
- An agent launched before the upgrade keeps its own tmpfs with its /tmp until the next boot.
- A dev server left in a desktop's Terminal nobody touched for a day ends when memory runs short.
- No machine protocol change.
