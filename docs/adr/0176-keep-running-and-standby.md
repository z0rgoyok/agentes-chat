# 0176. Agents say what must keep running, and a runner can stand by

- Status: Proposed
- Date: 2026-11-12
- Amends: ADR 0161 (an operator puts the workspace's computer to sleep: the runner can now stand by instead of
  stopping), ADR 0029 (background tasks end, a hold doesn't)

## Context

An agent leaves programs running on its computer that must keep answering while nobody uses it: a bot waiting for
messages, a tunnel, a small server called from outside, a job on its own timer, a page in its browser that must stay
live. Nothing says so. People can't see what runs for them, and whoever decides whether a computer may sleep (an
operator's control plane, ADR 0161) can only guess from its CPU, which a quiet program barely uses.

Operating systems settled this long ago: a program that must not be interrupted takes a lock that names who holds it
and why, ends with the program, and can be listed (`systemd-inhibit`, `caffeinate -w`, `powercfg /requests`).

And when an operator pauses a computer, ADR 0161 stops the runner first, so the server sees it leave. That stop also
closes the agents' Chrome, so a page that was live is gone when the computer comes back.

## Decision

### 1. `keep_running`

A computer tool of the agent (scope `sandbox:run`, approvals as `start_task`'s: `sensitive` where the workspace asks
for every command, and the agent's approvals level, ADR 0173). Listing its holds and ending one ask nobody there, as
`list_tasks` and `cancel_task` don't (`asksNobody`). Arguments:

- `what` (up to 80 characters, what people read), `why` (up to 200);
- one of `pid` (one of the agent's own programs: the hold ends when it exits), `browser: true` (its browser, with the
  page it shows, which must be open, and always with `until`), or `until` alone (an ISO time, at most 7 days ahead).
  `until` also bounds a program's hold;
- `hold` (a hold's id) changes that hold, its words kept unless new ones are given: a new `until` keeps it longer;
- `end` (a hold's id) ends it; no arguments lists the agent's holds.

The same pid, or the browser, again changes that hold instead of adding one. An agent has at most 10 live holds.
The tool is offered on a Linux computer whose agents are each their own OS user (`hello.mode`, ADR 0058 §10) and whose
runner speaks `KEEP_RUNNING_PROTOCOL` (61): anywhere else every call would be refused. Its description lists the
agent's holds now and those that ended in the last 7 days with why, so the next turn after a restart sees "the
computer restarted".

### 2. The lock on the computer

The runner (system mode, under systemd) takes each hold as root, in a scope in the agent's slice named after the hold
(`agents.slice/agents-<uid>.slice/agentes-keep-<hold id>.scope`):

```
systemd-run --scope --unit=agentes-keep-<hold id> --slice=agents-<uid>.slice -- \
  systemd-inhibit --what=idle --mode=block --who=agentes.chat --why=keep_running <wait>
```

- Never through the agent's launcher, and never as the agent's user. The agent's view may hide the system bus the
  lock needs (a configured network hook can), and a process of the agent's uid outside that view would show the agent
  the computer's own files through `/proc/<pid>/root`. The agent can't end the lock itself.
- `<wait>` ends with what the hold binds to: the program's `/proc/<pid>/stat` gone, a zombie, or with another start
  time than when it was held (as root, `kill -0` would go on holding a pid used again by another process), looked at
  once a second; its browser's slice (`agents-<uid>-browser.slice`) empty three looks in a row, two seconds apart (a
  Chrome moving to the desktop isn't a close); or `sleep` for the time. The runner also ends a hold at its `until`.
  The program's name in its stat file is the agent's to choose, so root's shell cuts everything up to the last `) `,
  globs nothing, and runs its tools by absolute path.
- `idle` is the lock that says "don't do what you do when idle". It is also the one block lock an agent's own program
  may take without an admin (systemd's default polkit policy); a guard reads those the same way.
- No words of the agent's go in the lock: every user may list them. The words stay on the server, and an operator's
  guard ties a lock to its hold by its scope.
- A program's pid must be the agent's: its owner is the agent's uid and its cgroup is under the agent's slice
  (`not_allowed` otherwise). Its start time is kept, so a pid used again by another process is never signaled.
- While its browser is held, the agent's worker never closes it as idle or moves it to or from its desktop, and a
  browser's hold always ends (`until`, at most 7 days ahead). A newer Chrome on disk waits for the hold a day at most
  from when the worker first saw it, renewed or not: then the browser restarts on it as an unheld one does (on its
  page, with its profile, once nobody watches it and the agent ran no command for 10 minutes). Chrome's updates are its
  security fixes, on a browser that is on the open web.
- Changing a hold takes its lock again (the scope's name is the hold's): meanwhile the old lock going isn't the hold
  ending, and its browser stays kept.
- The scopes outlive the runner. `<runner home>/holds.json` keeps what each one holds, so a runner that restarts goes on
  with the holds still living and reports those that ended meanwhile. The file names its boot: after the computer
  restarts nothing of it holds, and nothing is reported ended, so the server takes a time's hold again.

### 3. The server's record

`machine_holds` (migration 0256): the hold's id (the runner's too), its organization, agent, computer and run, `what`,
`why`, `pid`, `browser`, `until`, and how it ended (`exited`, `expired`, `stopped_by_person`, `ended_by_agent`,
`restarted`) with who stopped it. The server asks the computer first and writes the row once it holds, so a hold
people see is one the computer holds; a change the computer holds undoes an end it reported meanwhile. A hold whose
`until` passed with no word from the computer (away meanwhile) ends `expired` at that time once the server next reads
it, as any end does. Audit: `machine.hold_started`, `machine.hold_changed`, `machine.hold_ended`; each also tells the
apps (`machine.holds`).

A live hold counts as use of the computer (`machineActivity`'s `busy`, which an operator reads to decide when it
sleeps, ADR 0161), as a running task does, so the server never reports a computer idle under one.

On the wire (protocol 61): `keep.start { holdId, pid?, browser?, until? }`, `keep.end { holdId, stop? }`, the runner's
`keep.ended { holdId, reason }` when one ends by itself, and `hello.holds { live, ended }`. At each hello the server
reconciles: a live hold the computer no longer holds ends with the reason it gives, or as `restarted`; a time's hold is
taken again for its time left (after a restart or a move); a hold the computer holds that ended here meanwhile ends
there too, and one a person stopped while it was away stops its program or browser then (`stop`). A runner before
protocol 61 holds none.

### 4. People see it, and may stop it

"Kept running" on the agent's computer, on the web (its fact sheet's row under the computer, and a count in the
computer dialog's head whose menu has each line) and on the phone (its profile, under the computer's picture, and a
button on the computer's screen opening the same list): each hold's `what`, which agent kept it, since when and until
when ("until it stops", "until its browser closes", "until Fri 18:00"). The words never say awake, sleep or pause:
people see what runs for them, whatever the computer does.

`GET …/agents/{agentId}/holds` for whoever may watch the agent's computer. Stop
(`DELETE …/agents/{agentId}/holds/{holdId}`) for whoever may use it as the agent (`mayDriveComputer`) and for the
admins of computers (`control_computers`), in the hold's ⋯: the hold ends and what it held stops, its program signaled
(SIGTERM, SIGKILL 10 s later, each only while it is still the same process by its start time) or its browser closed.
A computer away learns it, and stops it, at its next hello.

### 5. What agents are told

One line in their capabilities, true in every workspace whatever its computer does while nobody uses it: a program
that must keep working while nobody uses the computer (a bot, a tunnel, a server called from outside, a job on its own
timer, a page in its browser that must stay live) gets `keep_running`, jobs that end go in `start_task`, schedules in a
routine, and a hold ends once it's no longer needed. Nothing about computers sleeping or turning off.

### 6. Standby

`agentes-runner standby [--minutes <n>]` and `agentes-runner resume`, for whoever pauses the computer: in standby the
running runner drops its link to the server (as on any disconnect: what ran on it is aborted, so the server sees the
computer leave) and its live views, and keeps everything else running: background tasks, the agents' Chrome and
desktops, their programs and holds. `resume` dials at once.

- The ask is a file in the runner's home (`standby.json`), which the runner reads every second and answers in
  `standby-ack.json`. The commands wait for that answer (20 s at most), and exit 0 once nothing there links to the
  server, or the resume was taken. An older runner answers `Unknown command`.
- It lapses by itself after `n` minutes (5 by default, 60 at most) of the computer's own running time (`os.uptime`,
  which a paused computer doesn't count), unless asked again; another boot's ask is void. A runner nobody resumes
  comes back.
- A runner that starts during a standby stays in it.

## Consequences

- Whoever decides whether a computer may sleep reads each hold as a standard lock, from any program on the computer,
  not only ours, and can tell ours apart by their scopes.
- A pause no longer has to close the agents' Chrome: an operator that stands the runner by keeps its live pages.
- A program's hold ends with a restart even when a service brings the program back: the program still runs, but people
  no longer see it as kept running. The agent sees it ended, and why, in its next turns.
- A time's hold ends silently at its time. The agent sees it listed with its end every turn before then.
- A lock needs logind. Where it refuses, the tool says the computer refused the lock.
- Root processes run in the agent's slice (the lock and its wait): a guard that looks for the agent's own programs
  tells them apart by their scope.

## Addendum (2026-11-27): no standby while an agent's turn runs (protocol 93)

A standby drops the link, and the guard asks for it before its last census, so a pause asked while an agent's turn ran cut that turn even when the census then called the pause off. From `HELD_TURN_PROTOCOL` the runner turns a new ask down while a turn runs there (`refusesStandby`): `standby-ack.json` carries `refused` with why, `agentes-runner standby` prints it and exits 1, and the guard reads that as a refused pause (`sleepBlocked`). That ask stays void after the turn ends; the next pause asks again. A renewal while in standby and a resume are as before.
