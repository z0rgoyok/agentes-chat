# 0175. The right hand's computer: a seat per person

- Status: Accepted (built: engine, the shared client's lists, the web and the phone app's row; not yet run on a real
  system-mode computer, see "Before it ships"); amended 2026-11-13 (§3, §8, §9: a shared seat wherever others read,
  see "Amendment: the shared seat")
- Date: 2026-11-12
- Amends: ADR 0137 (§1 "it is on no computer", §4 and §13 "no computer", the 2026-11-12 amendment's "No computer
  yet"), ADR 0057 (§2: an OS user per id the server sends, not only per agent), ADR 0169 (§9: a seat has its
  containers service)
- Code: `packages/db/src/schema/agents.ts` (`right_hand_seats`), `packages/db/src/schema/runtime.ts`
  (`machine_tasks.scope_id`), `packages/db/src/schema/browser.ts` (`browser_handoffs.seat_user_id`), migration
  `0263_right_hand_seats`, `packages/engine/src/right-hand-seats.ts` (`seatOf`, `runSeat`,
  `machineScope`, `viewerScope`, `toolMachineId`, `seatState`, `screenPersonOf`, `seatScopes`, `seatLive`,
  `screenKey`), `packages/engine/src/machine-hub.ts` (`outgoing`, `isLockedTurn`, `agentsChanged`,
  `MachineStatus.mode`), `packages/engine/src/machines.ts` (`machineAgents`, `deletedAgentIds`, `machineViews`,
  `computerDriving`), `packages/engine/src/sandbox.ts` (`withConnectedMachine`), `machine-tasks.ts` (`taskScope`),
  `git/machine.ts`, `git/proxy.ts`, `browser/tools.ts`, `browser/status.ts`, `browser/handoff.ts` (`screenAccess`,
  `ofScreen`, `openHandoffOf`, `startTakeover`), `browser/live.ts`, `desktop.ts` (`desktopTarget`, `streamAccess`,
  `createDesktopControl`), `desktop/tools.ts`, `desktop/status.ts`, `standing.ts` (`agentHold`), `cancel.ts`
  (`stopOrgWork`), `tools/gateway.ts` and `right-hand.ts` (`RIGHT_HAND_NOT_OFFERED`, `RIGHT_HAND_COMPUTER_GRANTS`),
  `right-hand-prompt.ts` (`rightHandTools`), `organizations.ts` (`removeSeat` on leaving),
  `apps/server/runner/agent-users.ts` (`sweepAgent`)
- Tests: `packages/engine/test/right-hand-computer.test.ts`, `packages/engine/test/right-hand-screens.test.ts`,
  `packages/engine/test/right-hand-shared-seat.test.ts`

## Context

The right hand is one `agents` row per workspace that every member talks to (ADR 0137). It had every tool an agent
can have but a computer's: `sandbox:run`, `browser:use` and `desktop:use` were kept off it, because a computer keeps an
agent's files, browser profile and sign-ins under the agent's id, and one id would have put every member in the same
home. The owner decided it is a normal agent with extra powers, with a full Linux user of its own for each person.

## Decision

### 1. One row, a stored seat per person

The one row stays: `unique(org_id, handle)` leaves one `@lodi`, and about 140 files read "the workspace's right hand".
Each (workspace, person) gets a seat: a row of `right_hand_seats` with a random uuid, made on the person's first use
(`seatOf`, only for a member). The seat's id is what the computer takes for an agent's id, so in system mode (ADR 0057)
it gets `ag-<first 8 of the seat id>`: its own OS user, home (0700), worker, slice, sub-ids, browser profile and
sign-ins, by the machinery every agent already has. The runner learns nothing new.

The id is stored, not derived from the agent's and the person's ids: the runner names a user from the first 8 letters
and digits of an id, so anything that starts with the agent's id would give everyone the same user; and the computer
must be able to list seats and hear which are gone. A new seat's id is drawn again until its first 8 are no agent's
and no seat's, gone ones included (`newSeatId`): a computer never frees a user's name, and a clash there would leave
the person with no seat.

### 2. The agent's own id never reaches a computer, but for its locked turn

Every request to a computer goes out through one function of the hub (`outgoing`, on the socket's replica, across
replicas and for a task's resume). There, a request whose agent is the right hand's own row is refused
(`not_allowed`) unless it is its locked chat turn or what follows one: `brain.turn` with `permissions.mode: "chat"`,
`brain.steer`, `brain.route` (`isLockedTurn`). So a call site that still builds a request from the agent's id fails
loudly and sends nothing, instead of putting every member in one shared home. The check fails closed: when the
agent can't be read (the database is away), nothing is sent.

### 3. Who gets a seat

- **A run** gets the seat of the person behind it, in that person's own DM with it (`runSeat`: `personBehindCall`
  and `soleReader`). Stricter than `rightHandReader`: a routine's own run does not count as its creator here, since
  what a routine read may come from outside. A channel mention, a routine's run, a run a routine or an agent woke and
  a run with nobody behind it get no seat, and a computer tool answers with a plain line saying so and what to do
  instead (`NO_SEAT_MESSAGE`). Nothing is sent to the computer.
- **A person's own request** (watching, taking control, a terminal, the screen's state and picture) reaches the seat of
  whoever asks, through one function (`viewerScope`, called by `desktopTarget`). It takes who asks and never whose
  seat, so no route can name another person's. On the right hand, the checks of who may watch and drive
  (`screenAccess`, `computerDriving`) let a member through to their own seat and nobody to another's, admins
  included: an admin who opens it sees their own.
- **What narrows it.** The same switches as any agent's computer. A person needs the role key that gives them their
  own agents' computers (`own_computers`, on by default for everyone; `own_browsers` for its browser), so an admin
  who takes it from a role takes that role's seats too. The terminal needs the right hand's `sandbox:run` grant and
  the workspace's switch for commands, the desktop its `desktop:use` grant: turned off on its page, nobody gets that
  half, whatever their roles.
- **Asking is not opening.** The screen's state and picture never make a seat (`viewerScope` with `make` off): a
  person who only opens its conversation or its page leaves nothing on the computer. Opening a stream, taking
  control or a run's first request makes it.
- **Where.** Only on the workspace's own computer (managed, else the server's own: `workspaceHomeId`), and only when
  it says `mode: "system"`. Anywhere else a seat would be a folder, not a user, so there is none: a computer a person
  brought, a phone's host and a computer that runs every agent as one user are refused with their own lines.

`agents.machine_id` stays null for the right hand. About ninety places read that column as where an agent's plan
thinks (outages, plan usage, the router's lending, AI settings), and its brain is on the computer where the plan's
account is signed in (ADR 0137 §1). The tools read its computer through `toolMachineId` instead.

### 4. What goes to the seat

Commands and files (`withConnectedMachine`, so `run_code`, the file tools, uploads, pulls and skill scripts),
background tasks (`machine_tasks.scope_id` keeps the seat for the task's later status, output, cancel and resume:
`taskScope`), `git_clone` and its proxy credential, the browser tools, the desktop tools, a Vault key or a made
password (sealed to the seat's id, which is what its worker opens with), a person's streams, and the screen a
control stream is screened by (`Stream.scope`).

Its browser runs on the seat's desktop (`browserOnDesktop` reads the workspace's own computer for it), so the person
sees the same Chrome their right hand drives.

What the server remembers of a screen between calls is kept per seat too: the look memory of the browser and desktop
tools (`screenKey`) and the desktop's recent picture.

### 5. The computer's lists

- The `agents` frame of the workspace's own computer lists each live seat like an agent: the right hand's handle and
  look, the name "Lodi (Ana)", the person's language, and `containers: true` (its turns never run there, so its
  containers service is no way out of a sandbox). A seat just made is announced before its first request
  (`agentsChanged`).
- A member who leaves, or whose account is deleted, has their seat tombstoned (`removed_at`), and the frame's
  `deleted` list names it, so the runner stops its worker and containers and clears what its sign-ins hold. Coming
  back gives a new seat with an empty home. The list is also computed from memberships, so a membership removed any
  other way still counts.
- `GET …/machines` names the right hand among the agents of that computer when it is in system mode. The apps find an
  agent's computer there, so its row on the web and the phone ("Computador") opens the viewer's own seat with the
  components any agent's page uses.

### 6. Grants

`sandbox:run`, `browser:use` and `desktop:use` are grant rows it is made with (`RIGHT_HAND_COMPUTER_GRANTS`; the
migration gives them to every existing right hand). Rows, not scopes held in code, so its access tab turns them on
and off like any agent's, `request_permission` offers one that was taken away, and nothing about them is special.

### 7. The locked turn is unchanged

On a plan its turn is still the runner's `chat` mode as the shared thinking user: the CLI gets our bridge and nothing
else (ADR 0137 §4). Every computer tool is ours, served by the Tool Gateway on the server, which sends the request
to the seat. The CLI itself is not unlocked to work as the seat's user: a plan's sign-in is lent to one OS user at a
time, so the workspace's plan could not be lent to every seat.

### 8. What it is told

"# Your tools" has three wordings (`rightHandTools`, by `seatState`): with a seat, that this conversation has a
computer that is this person's own place; in a channel or a run nobody asked for, that it has one only in a person's
private conversation; with no computer of the workspace's own in system mode, or with every tool of a computer turned
off for it, that it has none here. With a seat it is also told that its browser shows on its desktop, that the person
can take control there and is asked there (`desktop_ask_person`), and that the shared folder is everyone's. "What you
can do" keeps naming no browser, clone or typed login only when the run has no seat.

### 9. Handoffs are per seat

A person takes control of their own seat's desktop, and the right hand asks a person onto it (`desktop_ask_person`),
like any agent's. Each seat is another screen, so a handoff of the right hand carries whose seat it is
(`browser_handoffs.seat_user_id`, null for every other agent) and one is open per screen, not per agent: two people
hold their own at once.

- Every read of an agent's handoffs goes through one condition (`ofScreen`): for the right hand it takes a person
  and matches only that person's rows, and a caller that names nobody gets nothing. A person's request names
  themselves; a run's tool names the person whose seat it uses (`screenPersonOf`). So one person's take-over never
  hides another's screen, pauses another's run, moves into another's conversation or makes another's run read its
  screen again.
- A handoff reached by its id (read, take, done, cancel) is refused in the one access check (`screenAccess`) unless
  it is the asker's own seat's, an admin's included.
- The desktops' control on each server follows the seat too: a change names its person, and only that person's
  streams switch between watching and control.
- Its browser has no handoff of its own. A take-over of it is refused (`requireBrowserControl`) and
  `browser_ask_person` is not offered: the window is on the seat's desktop, and both happen there.

### 10. What stops it

- **A hold.** A computer knows a seat by the seat's id, so the hold read for a request (`agentHold`) follows a seat
  to the right hand: held, none of its seats takes new work. Stopping its work (`stopOrgWork`) ends every seat's
  desktop.
- **A person who leaves.** The frame's `deleted` list names their seat, and the runner kills every process of that
  OS user (`sweepAgent`), so nothing they left running in a terminal outlives their membership. A task of theirs
  the computer cut is not started again (`seatLive`).

## What is not in this change

- **No live view of its browser apart from its desktop.** One view per agent goes to everyone watching, and the right
  hand's browser is a different one per person: `watch` answers "unavailable" for it. The seat's desktop shows it.
- **Folders granted on a computer**, **missions** and **devices people brought** are not for it: the first two would
  send the agent's id, so their tools are not offered to it (`RIGHT_HAND_NOT_OFFERED`); the third is refused by name.
- **`claude` and `codex` background tasks** need a sign-in the seat does not have: `start_task` says so and what to
  do instead. Shell tasks run.
- **Work in the background** (`work_in_background`) and a routine's own run act with a routine's authority, so they
  get no seat.
- **The shared folder is not closed to seats.** See "Consequences". Closing it needs the runner to tell a seat's user
  from an agent's (a new field, so a protocol version), and is an open decision.

## Consequences

- One Linux user, and possibly a Chrome and a desktop, per member, sharing the agents' memory. Users are never removed
  from a computer (ADR 0057), so a departed member's home stays on disk with its worker stopped.
- The shared folder joins every user, so two seats, and a seat and an agent, can exchange files there, and a member
  with a terminal reads and writes what agents leave in it. Its prompt says the folder is everyone's and to put
  nothing of the person's there unless they ask; the page's line claims only what holds (who may watch and control).
- A member's name is in the OS user's description ("Lodi (Ana)"), which every user of that computer can read. They
  are members of one workspace, who see each other's names anyway, and the computer's own lists need to tell seats
  apart.
- In their own DM a run reads web pages and files while it can act as that person on their seat. Outside content
  marks the run as before (ADR 0117).
- On a plan every command goes through the server.

## Amendment (2026-11-13): the shared seat

### Context

§3 gave it a computer only in a person's own conversation with it. In a channel, on a widget and in a routine that
reports to a channel it had none and was told to hand the work on. The owner decided it has a computer like any
agent, everywhere.

### Decision

- **One more seat per workspace, shared.** A row of `right_hand_seats` whose `user_id` is `shared`
  (`SHARED_SEAT`), with a stored id of its own, so on the workspace's computer it is one more Linux user with its own
  home, worker, browser profile and desktop ("Lodi (shared)"). No migration: the column has no foreign key, no person's
  id is that word, and the table's index (one live row per workspace and owner) keeps two first uses at once to one
  seat. It is made on first use and only where a person's seat is (the workspace's own computer, in system mode).
- **Which seat a run works in is decided in one place** (`runSeat`), from who is behind the run and where its work
  is read, never from what the model says:
  - a person's own seat only in their own DM with it, where they alone read, and only when they are the person
    behind the run;
  - no seat where one person alone reads and that person is not behind the run: a run nobody is behind in their DM
    (another agent's message, an event from a connected app, a routine's report) and a routine's own run that
    reports there, whoever made it and with or without `toDrive`. Its computer tools answer with a plain line
    (`UNASKED_SEAT_MESSAGE`) and nothing is sent to the computer;
  - the shared seat everywhere else: a channel and any thread in one, whoever started it; a widget's refresh, wherever
    its routine was set up; a routine that reports where others read.
  Work in the background is the same run going on, so it stays in the seat that run had. This replaces §3's "a
  channel mention... get no seat" and the background item of "What is not in this change". **A routine that reports
  in its creator's own DM keeps §3's answer: no seat.** Its run may carry text from outside (inbound mail, a webhook,
  the web), and whoever manages routines may change its trigger without taking it over, so a seat there would put a
  person's files and signed-in browser behind a run nobody watches. `rightHandReader` gives such a run nothing of that
  person's either (it answers null in the routine's room and for the run its report wakes), and the Vault already
  refuses it keys. The shared seat is not the answer for it: a private routine's work would then sit where the
  workspace reads. The same holds for any run nobody is behind in a person's own DM: it reads that person's private
  conversation, so it gets neither their seat nor the shared one.
- **Nothing crosses.** A run's request to the computer is built from `runSeat` alone (`machineScope`), so a run in
  the shared seat never carries a person's seat id, and the reverse. That covers commands and files, background
  tasks, `git_clone`, the browser, the desktop, a Vault key sealed to the seat, and the screen's look memory
  (`screenKey`, per seat). A task kept for a seat (`machine_tasks.scope_id`) is listed, read and stopped only by a
  run that works in that seat. Nothing copies or mounts one home into another: the OS users keep them apart, and what
  the shared folder gives every agent is all they share. A person's Vault items, mailbox and memory keep their own
  gates and never follow a seat.
- **The hub guard is unchanged.** The agent's own id is still refused for anything but its locked turn: the shared
  seat goes out under its own id.
- **Handoffs.** The shared seat's screen is one, like any agent's: its handoffs are the rows of the right hand with no
  `seat_user_id`, read through the same condition (`ofScreen` with `SHARED_SEAT`). `desktop_ask_person` from a run in
  it asks who may drive it. A handoff's view says it is that seat's (`seat: "shared"`), so the apps keep its state
  apart from a person's own.
- **Who opens it.** Whoever may open any agent's computer there, by the same rule (`screenAccess`, `computerDriving`
  with `shared`): the admins of computers (`control_computers`) and the right hand's owner, plus the person an open
  handoff was asked of. A person who only has a run of their own going on with it does not, the run an open handoff
  is bound to included (`seesScreenAsTheirs`): the seat holds every channel's work, not only theirs. The audit rows
  of a terminal, a watched or controlled screen and a picture say `seat: "shared"` when it was this seat. A person's own request still names nobody's seat: the routes take
  `seat=shared` or nothing, and nothing opens another person's.
- **Its end.** It is tombstoned when the right hand loses its last computer grant (`setAgentAccess`: a scope, or one
  of its tools left on by name) and when the workspace's own computer is removed (`detachMachine`). Opening a screen
  or a terminal whose kind is off for it is refused before any seat is made (`desktopTarget`), so an ended seat stays
  ended. The `deleted` list then names it, so the computer kills its
  processes and stops its worker like a removed member's, and the next use starts another one with an empty home. It
  has no membership to lose, so the membership rule of `removedSeatIds` leaves it alone.
- **Lists.** The `agents` frame lists it with the others. `GET …/machines` says where it is (`sharedSeatOf`) only to
  who may open it. A hold and a stop reach it like every seat (`seatScopes`).
- **What it is told** (§8). The wording for a channel is replaced: there it has a computer, its shared place, shared
  with the whole workspace, so nothing private belongs there, and what a person keeps in their own place is not
  reachable from it.
- **Screens.** The row on its page and its dialog still show the viewer's own seat. On the computer's page, where
  admins open each agent's computer, the shared seat is a row of its own ("Lodi (shared)", with what it is for) with
  Open beside it, on the web and the phone. The dialog and the phone's screen opened from it say so in their title,
  and everything they read and do goes there (`SeatContext`). In a conversation, the cards of its work (its browser,
  its screen, a request for help) read and act on the place that work is on: the shared one anywhere but the viewer's
  own DM with it (`ConversationSeat`, the client's mirror of `runSeat`), so a card in a channel never shows or stops
  the viewer's own place.

### Consequences

- Everything any channel, widget or background run leaves on the shared seat is readable by every other run there
  and by whoever may open it, private channels included. Its prompt and its row say so. It is one seat, not one per
  channel.
- The shared seat's browser is signed in for everyone who can reach the right hand in a channel: a sign-in made there
  is used by whoever asks next.
- A routine that reports in its creator's own DM, and any run nobody asked for there, has no computer: work that
  needs one is handed to another agent, or waits for the person to ask in that conversation.
- The shared seat is used by every member who can mention the right hand, by agents that ask it and by runs fed from
  outside (a routine that reports in a channel, a widget's refresh), like any agent's computer.
- `keep_running` (ADR 0176) sends the agent's own id, which reaches no computer, so the right hand is not offered it
  (`RIGHT_HAND_NOT_OFFERED`) until holds know seats.
- A seat that is gone is no longer used, but its home stays on the computer's disk under an OS user nothing runs as:
  no seat reads it, root on that computer can.
- Removing the workspace's own computer ends the shared seat in the database, but that computer's socket is closed
  as revoked and never hears the list: its processes there are swept only if the same computer is paired again.
- A grant taken away through a card ends the seat in the database at once, and the computer hears with its next
  `agents` frame; the access page's own save sends that frame at once.

## Before it ships

Nothing here was run on a real system-mode computer. The checks are listed with the change's hand-over: two seats get
two users with 0700 homes that cannot read each other's files, processes or browser profiles; a plan's chat turn still
runs as the thinking user and its tool call lands in the asker's seat; a person takes control of their own seat's
desktop while another watches theirs; a removed member's processes are killed and their worker and containers stop;
a single-user runner is refused cleanly.
