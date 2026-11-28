# 0228. Quiet when nobody looks, and CLIs held to what works

- Status: Accepted
- Date: 2026-11-24
- Amends: ADR 0036 (the desktop window keeps running the site out of sight), ADR 0070 (the sounds' audio context),
  ADR 0025 and ADR 0059 (what a computer reports about its CLIs and their sign-ins)
- Issues: #949, #1278 (the app at rest); #680, #739, #691, #1133 (CLI turns that fail without saying why)
- Code (§6): providers `packages/providers/src/cli-pins.ts` (`CLI_PINS`, `parseCliPins`, `CLI_NO_SELF_UPDATE`),
  `scripts/cli-pins.ts`, `.github/workflows/cli-pins.yml`; adapters `machine-protocol.ts` (`CLI_COPIES_PROTOCOL`,
  `clis.pins`, `hello.clis`, `cli.fetch`); runner `apps/server/runner/cli-copies.ts` (`CliCopies`, `progressGate`),
  `executors.ts` (`setCliPick`, `pickedCli`), `daemon.ts`, `handlers.ts`, `connection.ts`; engine `cli-fetch.ts`
  (`fetchesCli`, `storeCliFetch`, `retryCliFetch`), `machine-hub.ts`, `brain-settings.ts`, `brains/*`; server
  `routes/machines.ts`; client `lib/cli-fetch.ts`, `lib/activity.ts` (`preparingCli`), `realtime/machines.ts`
  (`cliFetchOf`); web `components/ai/CliFetchLine.tsx`; phone `features/ai/CliFetchNote.tsx`
- Code: ui `packages/ui/src/sight.ts` (`watchSight`, `sight`, `onSight`, `IDLE_MS`, `<html data-sight>`),
  `agent/live.ts` (`agentMotion`, `wakeLiveAgents`), `components/Avatar.tsx`, `sky/engine.ts`; web `main.tsx`,
  `desktop.css` (`html[data-sight="away"|"hidden"]`), `lib/sounds.ts` (`releaseLater`); providers
  `packages/providers/src/cli-floors.ts` (`CLI_FLOORS`, `cliVersionProblem`, `CLI_UPDATE_COMMAND`); adapters
  `machine-protocol.ts` (`model_unavailable`, `empty_answer`, Codex's `loggedIn`/`authMethod`/`plan`); engine
  `brains/select.ts` (`cli_outdated`), `brains/claude-code.ts`, `brains/codex.ts`, `brains/failure-causes.ts`,
  `runs.ts`, `executor.ts`, `brain-settings.ts`, `right-hand.ts`; db `schema/machines.ts` (type only); runner
  `apps/server/runner/codex-sign-in.ts`, `codex-account.ts`, `accounts.ts`, `executors.ts`, `daemon.ts`, `brain.ts`;
  web `components/ai/CliMissing.tsx`, `ConnectAiSteps.tsx`, `pages/agent/brain/BrainDialog.tsx`; phone
  `features/ai/ConnectAiSteps.tsx`, `features/right-hand/SettingsCard.tsx`

## Context

People reported the desktop app heavy at rest. On a Windows laptop left alone, its web view used about 117% of one
core and kept the GPU process busy (#949); on a Mac the output device showed as playing for as long as the app was
open (#1278). The causes were in the site the window loads (ADR 0036), not in the window:

- The agent avatars' shared loop asked for every frame of the screen (144 a second on a 144 Hz display) as long as
  any avatar was mounted, and redrew every visible agent at rest about 12 times a second for its blinks and turns.
  The sidebar always shows agents, so it never stopped.
- The window keeps running its page hidden and in the background (throttling is off so conversations stay live), so
  that loop and the stylesheets' endless loops (typing dots, pulses, shimmers) went on with nobody looking. Only the
  skies stopped, and only Linux's software renderer stopped the loops.
- The sounds' audio context, once switched on by the first click, stayed running: it held the device and fed it
  silence.

At the same time, turns on a computer's CLIs failed in ways nobody could act on: a CLI too old for what we pass it,
a model the sign-in doesn't serve ending the turn with a code, a CLI that ended with nothing, and Codex signed in with
an API key never counting as signed in (#680).

## Decision

### 1. One "is anyone looking" state

`watchSight` (started once by the web app) follows the page's visibility, the window's focus, the pointer and the
person's input, and says one of `hidden` (out of sight), `away` (another window has the focus and the pointer isn't
over this one), `idle` (in sight, no key, click, touch, wheel or pointer move for two minutes) or `present`. The
pointer over the window counts as looking: a window on a second screen, watched while typing in another. `<html
data-sight>` carries it to the stylesheets. Everything that moves on its own follows it:

- **Skies** stand still whenever it isn't `present` (they had their own focus checks and idle timer; both are gone).
- **Agents** (`agentMotion`): present, an agent at work, waiting on someone, making a face or following the gaze
  moves at the full rate, and one under the pointer at rest's rate; an agent at rest or asleep is drawn once in its
  still pose (reduced motion's). Idle, only an agent at work moves: one waiting on someone who isn't at the computer
  would move for hours. Away or hidden, none moves. With nothing moving the loop stops and asks for no frame; a state
  change, the pointer, an avatar scrolling into view or someone looking again starts it.
- **Stylesheet loops** end their round while `away` or `hidden` (`animation-iteration-count: 1`, as the software
  renderer already did); what plays once still plays. Not when merely `idle`: someone reading while an agent works
  still sees it working.

### 2. Audio only to play

The audio context is suspended 1.5 s after the last sound ends and resumed to play the next one. The first click or
key still switches audio on (the browsers' rule); after that the app turns it on by itself. A sound that would start
more than a second late doesn't play.

### 3. A version floor per CLI, judged on the server

`CLI_FLOORS` names, per CLI, the oldest version the code needs and versions known to be broken for us. The server
judges the versions the runner already reports, so changing the list takes a server deploy, never a runner release.
Claude Code is held below 2.1.206 (every command of a turn goes through our permission prompt tool, which crashed on
a cold start before it) and Codex below 0.164.0 (a chat turn turns off that version's features by name). A version
line with no number in it is never held back.

Where its computer fetches the CLI itself (§6) a floor is never in the way: the runner runs its own pinned copy.
Elsewhere (system mode, an older runner, no build for that system) a CLI under its floor shows as `cli_outdated` with
the floor and how to update it: Claude Code and Codex offer "Update" through the installer that already installs them,
the others show the command. A run for it waits (wait code `cli_outdated`) without sending the turn, and resumes when
the runner reports the update.

### 4. Failures that say what to do

Two causes join a provider failure: `model_unavailable` (the sign-in or its endpoint doesn't serve the model) and
`empty_answer` (the CLI ended its turn with nothing). Claude Code's runner reports the first itself; for every CLI the
server also reads both from the CLI's own words, so older runners need no update, and a server that doesn't know a
cause drops it. A model refused before any work gets one retry on the CLI's default model in a fresh session; the
refusal is remembered per sign-in for 10 minutes (6 hours for a ChatGPT plan's model list) so it isn't picked again.
A model that can't be retried reads as the provider's "model unavailable", and an empty turn as "ask again, or update
the program".

### 5. Codex's own sign-in from Codex

The runner reads how the computer's own Codex is signed in from Codex's app-server (`account/read`, no token refresh):
a ChatGPT sign-in with its plan, an API key, or a model provider of the person's own config that needs no OpenAI
sign-in. `codex login status` is the fallback, believed only when it reports a sign-in (it now accepts an API key).
The server offers that Codex as the computer's own account, as it does for Claude Code.

### 6. One way to every coding CLI: a pinned build, fetched on demand

The same for Claude Code, Codex, Cursor, OpenCode, Grok Build and the Antigravity CLI, with no case of its own:

- **The pins.** `CLI_PINS` (`@agenteschat/providers/cli-pins`) names, per CLI, one version and each system's build
  (macOS, Linux with glibc or musl, Windows; arm64 and x64 where the vendor has them) at the vendor's own https
  address, with the vendor's hash of it (Claude Code's manifest, Codex's and OpenCode's release assets, the
  Antigravity CLI's manifests) or, where the vendor publishes none (Cursor, Grok Build), the hash taken when pinning.
  The server sends its list after every `welcome` (`clis.pins`, protocol 86); the runner keeps the last one in its home
  and has the same list built in, so it works with an older server or none. A new pin is a server deploy, never a
  runner release.
- **The runner.** The person's own copy runs when it is at the pinned version or newer. Otherwise, where the CLI is
  wanted (an account of it on the computer, the person's older copy, a turn or a sign-in asking), the runner fetches
  the pinned build itself, checks the hash (a mismatch is never used), unpacks it aside and moves it in whole under its
  own home, and every call of that CLI's command runs it. The person's install is never touched. One fetch per CLI at
  a time; a failure waits 30 minutes unless someone asks again. Every process the runner starts runs with each CLI's
  self-update switched off (`CLI_NO_SELF_UPDATE`), so the version checked is the one that runs.
- **System mode** (amended, protocol 88). Each agent is its own OS user, so a CLI is the computer's only when every
  agent's user can start it: root's look is run again as a stand-in agent (no groups, the PATH all agents share) and,
  where that misses, as each agent through its launcher (its groups, its own `~/.local/bin`). One only root starts
  (root's own `~/.local/bin`, a link into `/root`) is left out of `executors` as `broken: home_only`, so no picker,
  receipt or device page says it is ready. The computer's setup still installs the agents' CLIs and they update
  themselves, so the runner fetches its pinned build only where no agent reaches any copy at all, wanted as above or
  asked for by the apps' Install (`cli.install`, Claude Code and Codex) or Try again: in `/opt/agentes-runner/clis`,
  root's and closed to every other user's writes, linked from `/usr/local/bin` where nothing else is there.
- **Who knows.** `hello.clis` says which CLIs the runner fetches on its system and where each fetch stands; `cli.fetch`
  frames tell a fetch as it goes (at most once a second or every 5%), when it is ready, or why it failed (`offline`,
  `hash_mismatch`, `no_build`, `disk_full`, `failed`). The server keeps them with the computer (`executors.copies`),
  sends them to the apps (`machine.updated` with `cliFetch`) and keeps the turns waiting for that CLI there alive.
- **The apps.** A CLI the computer fetches is no reason to refuse it (`fetchesCli`): not installed, too old or broken
  there, it can be chosen and its turn goes; the runner fetches first. While it comes, the run's live line in the
  conversation says "Preparando o Claude Code no MacBook… 45%" (`prepare_cli`), and the agent's brain settings and the
  account's row in Contas de IA show the same line with the kit's meter, on the web and the phone. A failure says why
  in plain words with "Tentar de novo" (`POST …/machines/{machineId}/clis/{cli}/fetch`), which asks for the fetch now.
- **Keeping up.** `scripts/cli-pins.ts` reads each vendor's latest stable release and rewrites the pins; the `cli-pins`
  workflow runs it daily and opens a pull request, never merged by itself. The Antigravity CLI's comes from the
  manifest per platform its own installers read (`install.sh`, `install.ps1`), with Google's sha512.

### 7. Windows, like the others

Every one of the six vendors makes a Windows build (x64 and arm64), so all six think on Windows: `brainRunsOn` follows
the pin list (a system is refused only where its vendor makes no build). A Windows runner older than each CLI needs
there is too old for it (`runner_old`, `WINDOWS_FROM` and the specs' `windowsProtocol`): Grok Build from
`GROK_WINDOWS_PROTOCOL` (ADR 0142), the Antigravity CLI from `ANTIGRAVITY_WINDOWS_PROTOCOL` (ADR 0143), Cursor from
`CLI_COPIES_PROTOCOL`, its sign-in too. Each account's sign-in stays in its own folder where the CLI allows it:

- **Cursor** keeps it in the Windows Credential Manager unless told to use a file, then in `%APPDATA%\Cursor\auth.json`
  (its CLI's own credentials module, read in its 2026.11.22 Windows package): the account's env has
  `AGENT_CLI_CREDENTIAL_STORE=file` and `APPDATA` at its folder. Its Windows package is Node and its `index.js`; the
  runner starts `node.exe index.js` itself (`launch` in the pin), never its `.cmd` launcher, whose cmd.exe and
  PowerShell line is too short for a prompt and requotes it.
- **Grok Build** keeps it in `auth.json` under `GROK_HOME` everywhere; its Windows build has no keyring code at all.
- **The Antigravity CLI** keeps it in the Windows user's one Credential Manager, whatever its home: a Windows computer
  has one Gemini account (ADR 0143 §3, protocol 84). The account's folder is still its home (`USERPROFILE`), so its
  settings and our MCP server come from there.
- **Checked, not trusted.** A Windows sign-in of Cursor counts only once its file is in the account's folder
  (`signInFileOnWindows`); one that went to the Credential Manager instead is refused in plain words, so two accounts
  never become one.
- **Git for Windows** is Claude Code's shell there (Git Bash). Where the person has none, the runner fetches MinGit,
  Git for Windows' portable build (its release's sha256), as one more pin (`git`, Windows only, wanted where Claude Code
  is) before Claude Code's turn or sign-in, and points `CLAUDE_CODE_GIT_BASH_PATH` at it; MinGit ships GNU bash as
  `usr\bin\sh.exe` only, so the program is a copy named `bash.exe` (`from` in the pin), which runs as full bash. Its
  fetch shows as Claude Code's ("Preparando o Git no PC… 45%") and holds Claude Code's turns while it comes.
- **Prompts** fit Windows' command line (32,767 characters with the program and its other arguments): past 24,000 the
  engine's context loses its middle, as past 120,000 elsewhere.
- **Unpacking** uses Windows' own `System32\tar.exe` (bsdtar, which reads zips), never a GNU tar on the PATH.

## Consequences

- At rest the app draws nothing: no frame loop, no stylesheet loop out of sight, no audio device held. The fix ships
  with the server (the desktop window loads the site), so no desktop release is needed.
- Agents at rest no longer blink or turn on their own; they come alive at work, waiting on you, reacting, or under the
  pointer.
- Every computer outside system mode runs the CLI version agentes.chat chose and checked, fetched only when it is
  needed; nobody is sent to a terminal to install or update one. Where it can't be fetched, a CLI too old for us
  stops failing turns: its agents wait and the person gets one action to fix it.
- A computer may hold a CLI twice (the person's older one and the runner's), which takes disk space.
- Not done here: the loading screen's own avatar loop and minimum time (`apps/desktop`, a desktop release), the
  window's throttling setting (the page now stops its own motion instead), and reading sign-ins through each CLI's
  protocol beyond Codex. The one-click `cli.install` stays for runners before protocol 86.
