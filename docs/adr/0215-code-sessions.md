# 0215. Code sessions: a request in its own worktree, on the Code page

- Status: Proposed (being built)
- Date: 2026-11-20
- Extends: 0021 and 0077 (code tools on the agent's computer), 0025 (connected computers), 0032 (computer brains),
  0044 (a mission's worktree), 0058 and 0065 (the agent's desktop and terminal), 0042 (phones), 0145 (a task's
  conversation is a thread of its own), 0156 (the GitHub App)
- Code: db `packages/db/src/schema/code.ts` (`code_sessions`), migration `0321_code_sessions.sql` (`channel_kind`
  gains `code`); engine `packages/engine/src/code-sessions.ts` (`createCodeSession`, `prepareCodeSession`,
  `ensureCodeSessionsOn`, `codeAgentSql`, `worksInSessions`, `codeSessionContext`, `codeSessionBrief`, `admitCodeMembers`,
  `codeSessionDiff`, `codeSessionGit`, `codeSessionGitLog`, `codeSessionFiles`, `codeSessionFile`,
  `recordCodeSessionPr`, `codeStartOptions`), `messages.ts` (the session's agent
  answers like a DM; who is named joins), `jobs.ts` (never routed), `executor.ts` and `run-tools.ts` (the run's place),
  `brains/select.ts` (the place as a computer brain's computer and folder), `sandbox-tools.ts` (the code tools in the
  place), `tools/gateway.ts` (`CODE_SESSION_HIDDEN_TOOLS`), `sandbox.ts` (`codeRunning`), `context.ts` (the session's
  brief), `notification-producers.ts` (`codeSessionId`); server
  `apps/server/src/routes/app/code-sessions.ts`, `engine.ts` (the computer-online hook); client
  `packages/client/src/code/*`, `lib/work-context.ts` (`CodeConversation`); web `apps/web/src/components/code/*`,
  routes `org.$orgId.code.index.tsx` and
  `org.$orgId.code.$sessionId.tsx`, the sidebar tool `code`

## Context

People who program with agents work today in a tool of their own beside the chat: one terminal or window per task,
each in its own git worktree, the diff and the running app beside the conversation with the coding CLI. agentes.chat
already has every hard part of that: computers connected to the workspace with an OS user per agent (0025, 0057), the
agents thinking there with a coding CLI (0032) or with the workspace's models and their code tools (0021, 0077), a
mission's own worktree and branch (0044), the agent's
screen live with take-over (0058, 0065), phones the agents use (0042), PRs and approvals (0156). What is missing is a
place that puts them together around one request, and is as simple as typing into the CLI.

The page must work for any stack and any git flow: not only web projects, not only GitHub with pull requests and CI.

## Decision

### 1. A session is a request in its own worktree, with its own conversation

`code_sessions` holds the request's repository (`owner/name`), the agent, its computer, the branch
(`agentes/<handle>/<slug>-<4 hex>`: under the agent's own prefix, the only new branches the git proxy lets it push),
the base it started from, the worktree's folder (`.worktrees/c-<short id>` in the agent's folder) and its state
(`preparing`, `ready`, `failed`, `removed`).

Its conversation follows the task's model (0145): a channel of kind `code` (private, never listed) with one root
message (`meta.codeSession`), and the session is that thread's replies, so runs, steering, stop, approvals, live
events, receipts and the thread screen work unchanged. People are members of the channel: who opened it, and whoever
is named there with `@` (`admitCodeMembers`); agents named there join it too. Its faces stand in the header: whoever
opened it, or an admin, takes someone out, anyone else leaves (`removeChannelMember`, which lets a code session be
left and always keeps its own agent and whoever opened it). An agent called in reads, reviews and tests: its brief says
where the worktree is beside its own folder when they share the computer (`agentFolderOf`, the runner's folder name),
and to ask the session's agent otherwise.

A session may also start with no repository: a name with no owner (`hello-world`) is a project only on the agent's
computer, `projects/<name>` in its folder, made with `git init` on first use (or adopted with its files in a first
commit when the folder is there). Its session has the same worktree, diff and terminal; with no remote, the person
asks for a commit or a merge into the project's base branch in words, never a push or a pull request. A clone that
fails for want of GitHub access is said in the person's words with that way out (`errorCode: github_access`).

### 2. Its agent answers like in a DM, once its worktree is ready

What names nobody in the session goes to the session's agent (`codeAgentSql` in the `task_agent` step of
`insertMessageWithRuns`, `meta.forTask`), never to the router (`jobs.ts`). Before the worktree is ready nothing runs:
the request waits, and `prepareCodeSession` hands the newest person's message to the agent as one run once it is.

Who the agent answers holds here as anywhere (its audience and `talk_to_agents`, `canTalkTo`): only someone it answers
opens a session with it or is offered it (`createCodeSession`, `codeStartOptions`), a person called in whom it doesn't
answer reads the session and is told so when they write, and the message that waited for the worktree is the newest
of someone it answers (`releaseRequest`). Since the router never decides here, a message nobody answers (that person's,
one that waits for the worktree, one for a person) has its receipt settled when it is posted (`message.routed` with
nobody), so the apps never wait for a decision.

### 3. The worktree is the mission's, made for any request

`prepareCodeSession` clones or updates the repository's checkout through the git proxy (`git.sync`, `cloneOnMachine`)
and makes the worktree with the runner's `mission.worktree` op (0044: `.env` files copied, `info/exclude`), on the
agent's computer. Offline, paused or an older runner: it stays `preparing` and `ensureCodeSessionsOn` tries again when
the computer is back. The project's install is not run by the server: the agent's first turn is told the runner's
setup command (from the lockfile) and runs it like a person would.

A run in the session works in the worktree, whichever brain it thinks with: the session is the run's place
(`codeSessionContext`: the session's computer, from its row, and the worktree, relative to the agent's folder), read
once when the run starts (the executor, or the bridge for a computer brain's calls and its tasks' calls) and carried
on its tool context (`ToolContext.codeSession`). Every piece that runs something reads that place, never the brain's
kind:

- a computer brain's turn (`resolveBrain`) runs on that computer and opens in that folder, like a mission's: it never
  spills over to another computer, the pre-turn checkout sync of chat turns doesn't apply, and a warm start carries
  the session's flag (`brain.warm`'s `codeSession`, in the runner's process signature), so the turn finds a process
  with the session's tools. A worktree missing on the computer fails the turn and the session (its retry makes it
  again, `loseCodeWorktree`), never a fresh session in the agent's folder;
- our code tools (`run_code`, `start_task`, `read_file`, `write_file`, `list_files`, `import_file`) work in that
  folder when the call runs on the session's computer (`sessionFolder`, decided on the computer the call reached): a
  relative path is inside the worktree, never climbs out of it, comes back relative to it, and a path already given
  from the agent's folder is taken as it is; a script runs from there; `import_file`'s default goes under `.agentes/`,
  out of git; a task works on the session's branch (`branch` is refused there), and a Codex task keeps the agent's
  folder writable as its turns do;
- the Tool Gateway leaves what doesn't belong in a session out of every brain's tools, neither listed nor called
  (`CODE_SESSION_HIDDEN_TOOLS`: the Drive's file tools, the suggestion of a session, and `propose_mission`, since a
  session is already the place of its work, §6, §11).

The place holds only while the worktree is ready on the computer the agent uses now. Otherwise the session's own agent
has none, and reads why (`unavailable`: still being prepared, gone, or on a computer it left): its computer tools
refuse with those words and a computer brain's turn fails (`code_session_unavailable`), never working in the agent's
own folder or on a computer it no longer belongs to. An agent called in works in its own folder.
Who may have a session is one check (`worksInSessions`): a computer for the worktree, and a way to work in it there:
a computer brain brings its own shell, any other brain needs to be allowed to run code (`codeRunning`, the same rule
`run_code` and the desktop's tools apply: the grant, the workspace's code environment, the agent's computer). A
session takes any model.

The run also gets a brief naming the repository, branch, base and folder, and how to work there
(`codeSessionBrief`, the same for every brain; each tool's own description says how to use it): among it, that its screen is the session's preview, so what can be looked at it serves on
localhost and opens in its browser itself, looks at and fixes before saying it's done (the browser opens only http
and https), never asking the person to open it. Where the repository has no name for commits, the agent's goes in its
config once the worktree is made (`ensureGitIdentity`): the CLI commits with plain `git commit`.

### 4. The page: a list, a home in the agents' sky, and a session

- **List**: the sessions I take part in, grouped by repository, with their state in words (`preparing`, `working`,
  `waiting for you`, `ready`, the PR) and the change's size.
- **Home**: the field in the middle of the agents' fine sky (the agent page's cover sky). Over the field the page's
  title ("Coding mode", in the brand's face, as an added line of a diff: a block with a top and a side in the agent's
  own dithered material, which drops on "− Chat mode" as the home opens and knocks it off; a Beta tag beside it), and over it the agent
  picked in the field drawn in cubes from its own avatar (each pixel of the engine's drawing a cube, the avatar's tones
  through the sky's dither, plain WebGL: `agent-voxel.ts`, `CodeHomeAgent`). As the home opens the figure builds
  itself, each cube dropping into place from its foot up, while the title and the field rise into place
  under it; nothing waits for the build, and with reduced motion all of it is simply there. It turns a little toward
  the pointer, blinks with its face, and its cursor (the browser's, ADR 0040 §7.2) glides in as the last cube lands and
  waits beside it. The three stand in the middle of the sky; a window too short for them shows the title and the field
  alone, a browser without WebGL the flat avatar. Writing and Enter opens a session with the picked agent and
  repository (the last ones used come back); the computer is the agent's own, so there is nothing else to pick.
- **Session**: the conversation under its header (its name, who is in it and its menu: its state is the list's and the
  line over the composer's, its branch the Git tab's), with the agent's model (the DM's picker, changed in place)
  and its plan's limits under the composer like a coding CLI's status line, and a side panel with the kit's tabs, Git,
  Files and Screen, and a Terminal under any of them. The list, the conversation and the terminal's height drag, each
  kept on the device, and a session squeezed
  by the window folds the app's sidebar to its rail until the room comes back (`usePageRoom`, as beside a live file's
  conversation):
  - **Git**: read with `git` in the worktree as its agent (the runner's `exec`, read-only commands), again every few
    seconds while it works (`codeSessionGitLog`); each read is cut at 20 s on the computer and answered within 25 s,
    under the apps' own wait for a read, so a computer busy with the agent's work reads as slow (`machine.timeout`),
    never as the server being away: the branch and what it came from, the whole change since the base
    (committed or not, new files included), what isn't committed as `git status` letters it (with its lines), and the
    branch's commits since the base as a line of nodes. Any row opens its diff in place (an uncommitted file's, a
    commit's `git show`, everything's), unified or side by side from the diff's own head. The sky rises behind it from
    the panel's foot, with the agent standing on it.
  - **Files**: the worktree's tree, the files git tracks and the new ones it doesn't ignore (`ls-files -co
    --exclude-standard`), changed ones marked with the Git tab's letters and their folders open at first, and a search
    by path. A file opens in a tab beside the conversation (`codeSessionFile`): never one git ignores, a `.env` one or
    one reached through a link out of the worktree (each step resolved on the computer), only its first 512 KB, and a
    binary one only said to be one.
- **A beta notice, once.** The first time a person opens the Code page on a browser (`CodeBetaDialog`), a dialog
  says the mode is in beta: the title's block drops on the home's sky, and what the mode is reads as a diff, the
  lines it adds and the ones it takes away. Every way out goes on.
- **Tabs beside the conversation.** Under the session's header: the conversation, each open file, each diff opened from the Git tab (a change, a commit, the whole branch; a file's diff
  opens the file itself) and each terminal the person opens there (a shell of its own, as the drawer's); the ones off screen stay as they are, and the open
  files and terminals come back with the session on that browser.
- **A terminal knows the agent's sign-in.** A terminal as the agent (the drawer's, a tab's) starts with the one
  variable that points Claude Code or Codex at the account the agent thinks with (`AccountManager.terminalEnv`), so
  the CLI typed there is signed in as its turns are; who may open that terminal already is who may reach that
  sign-in (0059 §8). Read when the shell starts: after the agent's account changes, a new terminal has the new one.
  Not for an account root keeps for several agents or a plan's key (they never leave root for a shell), nor for the
  CLIs that keep their sign-in under the XDG folders, which the shell's other programs read too.
- **A terminal outlives the page.** Each terminal of a session has a name on the person's browser (its tab's, the
  drawer's), sent with its open (`keep`, protocol 77, the person's id put in front by the server): the runner keeps
  its shell when the viewer's socket drops and the same name comes back to it, shown its last output (256 KB) and
  sized again so a full-screen program redraws. Closing the tab ends the shell (`end`); nobody back in 30 minutes
  ends it too, and the limits per agent count it meanwhile. The tabs of terminals come back with the session's.
- **A person edits a file.** A file's tab is an editor (CodeMirror 6, loaded with the first file: line numbers, the
  language its name says, undo, search). Whoever is in the session and its agent answers saves (`saveCodeSessionFile`, `PUT …/file`), since
  they could ask its agent for the same change: written as the agent by the runner's own file op (the file's mode
  kept, never into a `.git` folder), only over a file the session shows whole. A read says what the file holds
  (`rev`, git's blob hash) and a save says which one it started from: a file the agent wrote meanwhile is refused
  (`code_session.file_changed`) and the person chooses, theirs over it or the computer's. With nothing unsaved the
  tab follows the computer while the agent works. The agent isn't told of a save: the change is in the worktree and
  in `git status`, where its tools read it.
  - **Screen**: the agent's computer as its computer dialog shows it (live, "Take control", full screen; a Mac's
    browser page). The worktree's server runs there on a port only that agent reaches (0096), so its screen is the
    preview. It stands in the agents' fine sky; where the person may use phones (0042), a picker offers them. The
    conversation's browser and desktop cards are one line there ("See on Screen", `ScreenPanelContext`), and the panel
    turns to the screen once as the agent starts using it.
  - **Terminal**: a drawer at the panel's foot, under the diff or the screen, opened and closed by its switch beside
    the tabs: a shell on the agent's computer opened in the worktree (the terminal of 0058 §6, with a folder), for
    running a script; the AI doesn't run there. Where the computer's terminal is off, it offers the app's way to turn it
    on (`ToolOffWayOut`: whoever paired it turns it on there, anyone else asks them). Only who may drive that computer opens it, and a server that screens
    sessions keeps terminals off. The stream takes a `cwd` (`TERMINAL_CWD_PROTOCOL`, 76) that the server sets from the
    session (`/api/terminal?…&session=`, checked with `requireCodeSession`) and the runner resolves inside the agent's
    folder; an older runner opens the shell in the agent's folder and the pane says so (`cwd_ignored`). The pane is
    xterm (keystrokes as binary frames, `resize` as text) and lives on while another tab shows.

### 5. Git through the agent, so any host and flow works

There is no git button: the person asks the session's agent in words in the conversation (commit, push, open the pull
request, merge), and it does it with the tools it already has, on any host, or the person runs it in the terminal.
Nothing about a session changes the rules: a merge stays an approval (`merge` is always sensitive), asked in the
conversation like any other. The Git tab reads where the branch stands (`codeSessionGit`). With CI on GitHub, a
failing check on the session's branch comes back to the agent as a notice in the session, so it reads the log and
fixes it.

### 5a. Keys

The page's keys, with ⌘ on Apple platforms and Ctrl elsewhere, none one the browser keeps for itself (`shortcuts.ts`):
⌘P finds a file of the open session (the Files tab and its search), ⌘J shows or hides its terminal, ⌥⌘N starts a new
session (the home with the caret in its field), ⌥⌘↑ and ⌥⌘↓ open the session above or below in the list. The page
catches them on their way down, before the focused control's own keys; each piece answers its own, and the buttons say
theirs in their tooltips.

### 6. Claude Code's own subagents and skills, and the repository's

A session's turn tells the runner it is one (`codeSession` on `brain.turn`): on the agent's own Claude Code (not a
shared sign-in, not the owner's MCP servers, which already keep everything) the turn also gets `Agent` (its
subagents, with the turn's tools and permission mode), `Task` (its name before 2.1.63) and `Skill`. The worktree's
`.claude/agents`, `.claude/skills` and `.claude/commands` load as a plugin (`--plugin-dir`, `repoPlugin`): copied
into the turn's folder as regular files only, never through a link, each Markdown file without the frontmatter keys
that would act outside the turn's checks (`hooks`, `mcpServers`, `permissionMode`, `allowed-tools`), and nothing
else of the checkout's `.claude/`, so its settings (hooks, allow rules, env) stay unread as ADR 0117 wants. Only on a
Claude Code the runner knows takes the plugin (2.1.63 or newer, `REPO_PLUGIN_MIN_CLAUDE`).

The turn also gets `Workflow`, Claude Code's scripted workflows of subagents, with `enableWorkflows` in the runner's
own settings for the turn: the CLI still offers it only where the account's plan has it. A workflow's call is one
line in the session ("Ran a workflow" and what it does: its name, else its script's `meta`), its subagents' work
inside it. While they work, subagents and workflows are in plain sight: the runner reads the CLI's task events
(`tool_progress` on the wire, `agent.tool.progress` to the apps) and the conversation shows each subagent's call now,
a workflow's agents and how many are done; the line over the composer and the list say it in words. A turn waits for
the work it started in the background (up to an hour), so its result reaches the conversation. A call whose work goes
on in the background ends, live and on the trail, when that work ends, with that time.

Files and pictures stay in the session's panel: `upload_file` and `export_file` aren't given to any brain in a
session (`CODE_SESSION_HIDDEN_TOOLS`, applied by the Tool Gateway's list and call), a screenshot taken with `share`
isn't shown there (`shareSavedFile`), and its brief says not to paste screenshots.

### 7. The brain's own tool calls, one line each

In a code session each call the CLI makes on its own (read, search, edit, write, run, fetch) is one line of the run's
work, as in a terminal: a `context` step `cliTool` (`packages/engine/src/cli-tools.ts`: verb, target relative to the
worktree, counts such as lines added and removed or tests passed, an output excerpt masked), written when the call
ends. A `context` row keeps them out of every Tool Gateway reader (cost brakes, outbound checks, other runs' context,
continuation). Live, `agent.step` carries the line at its start (the runner now sends the input with `tool_started`)
and at its end (`ended`, `failed`). In a session's conversation the agent's work is the conversation itself: it
shows with the work summary off, whichever brain did it (`CodeConversation` around the conversation's rows,
`useShowsWork` in the apps), in a block closed like every other (the diff and the screen say what changed). Elsewhere they stay off the trail (ADR 0032
addendum: a row per call on every turn of every chat is not worth its writes). A run that answers on the way lists
under each reply only the work that led to it (`replySteps`, and the reply's own summary counted from the reply
before), and in a session the computer's permission check that let a command through at once is no line of its own
(the command is the brain's own line, or a subagent's work); one that waits on a person or refuses stays.

### 8. A failing check comes back to the agent

The GitHub App subscribes `check_run`. A check that completes failed, timed out or waiting on an action, on an
`agentes/` branch, becomes a `github_check` notice in the open session on that branch (its thread, from its agent,
waking it with trigger `dm`): which check, on which PR or commit, the link and the check's own output as outside text.
It asks the agent to read the log, fix it in the worktree, run what failed, push again and say what it changed, or to
say so when the change didn't cause it. Once per session, commit and check name. The session keeps the pull request
opened from its branch (`open_pull_request`, and `pull_request` opened or merged).

### 9. Notifications

A message in a session notifies as in a channel thread, named by the session (`label`) and with `codeSessionId`, so
the apps open it on the Code page.

### 10. On the phone

The phone app has Code as a row of You, with the same API and the conversation as the chat's own thread screen
(real navigation: each place a pushed screen with the system's back).

- The list leads with the sessions that wait on the person, then the rest by project, each with its agent's face. A
  working session says what its agent does there right now, in words with its orbit: the agents' status line, only
  while that work is in this session's channel. Otherwise its state in words. A row opens the session's conversation.
- A new session is a pushed form (what to do, the agent, where it works). "Where to work" is its own pushed screen,
  and starting replaces the form with the conversation.
- The conversation hides the root as a task's does. Its pill, marked with the code's symbol, shows the session's name,
  then its state and branch (without the agent's `agentes/<handle>/` prefix), and opens its code. It says "working"
  from the live run at once and reads the session again when the run ends. The bar holds one button besides "…", the
  agent's computer (the computer screen the phone already has): with two, a 393-point phone left the pill a few
  letters of the name. The "…" is the session's: who is in it, its pull request, closing it.
- The session's code is one pushed screen with Git and Files as a segmented control: where the branch stands, its
  changes and its commits. Folders, read-only files, diffs and who is in the session are screens of their own.
- The app hears `code_session.updated`, as the web does.

### 11. A session suggested in the chat

When a person asks an agent that can have a session (`worksInSessions`) to change code in a project (fix a bug,
build or refactor something) in a conversation outside a session, the agent suggests a session instead of changing the
project there. Questions, explanations and quick looks it still answers in the conversation. A task's conversation
and a mission's thread are already the place for their work (a mission has a worktree of its own): there it never
suggests one and makes the change as before.

- `suggest_code_session` (`code-suggestions.ts`) takes the project (`owner/name` on GitHub or a project's name on the
  computer) and a short title, and is checked as a session would be (the agent's repository list, a project's name).
  It is listed only for those agents, in runs a person can answer, and hidden in a session (`CODE_SESSION_HIDDEN_TOOLS`);
  "How you work" says when to use it only where it applies (`CODE_SESSION_LINE`). It talks, it doesn't work: it isn't
  a step of the reply's work, and a run that only suggested hasn't started the change.
  "How you work" asks for it before `work_in_background`; a run that moved itself to the background first still
  answers the person's request, so it may suggest, and its report carries the card where they asked.
- The suggestion rides on the agent's reply (`meta.codeSuggestion`, as a mission's link does): the project, the title,
  the words of the message the run answered and who wrote them. The apps draw it as the chat's request card, kind
  `code` ("Sugere uma sessão de código"), with "Ver o pedido" opening those words, "Abrir sessão" and "Fazer aqui".
- Only the person who asked decides; anyone else reads who it waits for. "Abrir sessão" makes the session as that
  person, their words its first message and the suggestion's title its name, and remembers the message it came from
  (`meta.codeSession.from` on the root): the session's page leads back to it ("Aberta da sua conversa com o Leo"), for
  whoever can open that conversation. The suggestion is taken first (`opening`), so a second click opens nothing; a
  session that can't open leaves it waiting again, and the error says why.
- "Fazer aqui" keeps the work in the conversation: the agent is told and woken there. Either way the agent reads what
  was chosen as a `proposal_result` notice, which people never see (the card says it). Each change of the card reaches
  the apps as `code.suggestion`.

### 12. Code only where it has anything

Most workspaces have no agent that programs, and for them Code would be an empty page in every menu. The overview says
whether it has anything for the person (`OrgOverview.code`, `hasCodeWork`): an agent they can start a session with
(`worksInSessions`, not archived) or an open session they take part in, whose agent may have left since.
Only then do the apps offer it (`offersCode`, `offeredTools`): the sidebar's More and its setup dialog, ⌘K, and Eu on
the phone. A person who put Code in the sidebar's list keeps it there. The address still opens the page, which says
what is missing, and a session's links keep working.

### 13. Any git host, and in the person's name (addendum 2026-11-24, ADR 0227)

A session works on a repository of any git host the workspace connected: GitHub's `owner/name`, or another host's with
the host first (`gitlab:group/project`, `bitbucket:workspace/repo`, a git server's `git:team/project.git`), by name or
by its address. A project only on the computer stays a plain name.

When the person who asked connected that host as their own account (ADR 0099), the session's work on its repository
goes out as them: the commits are authored with their name and the host's no-reply address for the account, the
branch is pushed with their token, and the pull request is opened with it. Their token stays on the server; the
agent's computer gets a name and an address for that turn. A host refusing their token, a run nobody asked for or a
person with no account there: the workspace's connection, as before (ADR 0227 §5).

## Consequences

- No new runner op for the worktree or the diff: the session reuses `mission.worktree` and `exec`. The terminal's
  folder needs a newer runner (protocol 76); an older one opens the shell in the agent's folder and says so. Claude
  Code's subagents and the repository's skills need a runner that reads `codeSession`; an older one runs the turn as
  before.
- Apps registered before this need "Check run" ticked on GitHub; until then no check comes back (Settings says so).
- A branch that keeps failing wakes the agent at each push that fails again, within its budgets; no other cap yet.
- Sessions need an agent on a computer with git access to the repository, thinking there with a coding CLI or with
  any model allowed to run code.
- Cursor, Grok Build and the Antigravity CLI run their shells in a sandbox that writes only in the turn's folder and
  temp: in a session that is the worktree, whose git data stays in the checkout beside it, so a commit from their
  own shell may be refused. Their brief says to commit with `run_code` then (the runner's shell, in the worktree),
  where the agent may run code; otherwise the person commits in the terminal. Codex's sandbox takes the agent's whole
  folder, checkout included, and Claude Code and OpenCode have none of their own.
- The conversation is a thread like a task's: the phone app shows it with its own thread screen (§10), so a session
  reached from a notification opens the same way as from Code.
- Out of this first version: several agents writing in one session at once (one writes, the others read and review),
  a lead agent splitting work into child worktrees, line comments on the diff sent together, and a diff per turn with
  undo.
