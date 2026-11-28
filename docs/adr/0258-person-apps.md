# 0258. Agents use the person's own apps, on every connected computer, through the accessibility tree

- Status: Accepted
- Date: 2026-11-26
- Amends: ADR 0031 §7 (the owner's real desktop), §1a's `owner_desktop` and §15 for apps on a person's computer
- Builds on: ADR 0054 (the screen layer), ADR 0062 (the agent's own desktop), ADR 0255 (OS permission waits)
- Code: `packages/adapters/src/machine-protocol.ts` (`PERSON_APPS_PROTOCOL` 94, `apps.run`, `APPS_COMMANDS`, `AGENT_DESKTOP_VERSION`, `AGENT_DESKTOP_SHA256`, `hello.apps`), `apps/server/runner/apps.ts` (`AppControl`), `handlers.ts`, `daemon.ts` (`appsStop`), `packages/engine/src/desktop/person-apps.ts` (`apps_list`, `apps_read`, `apps_act`, `agentPersonAppsStatus`), `packages/adapters/src/runner-control.ts` (`ControlStatus.apps`, `apps.stop`), `apps/desktop/src/windows/Popover.tsx` (`AppUseRow`), `apps/desktop/scripts/fetch-agent-desktop.ts`, `.github/workflows/desktop.yml`

## Context

ADR 0031 §7 kept the person's real desktop behind two opt-ins, a session approval and a signed native helper we would write. Nobody turned it on, so an agent on a person's Mac or Windows computer could run commands and drive its own browser, but not use Mail, Finder, a spreadsheet or any app without an API. The product rule is now that a connected computer just works: an agent that may use it may use its apps.

`agent-desktop` (Vercel Labs, Apache-2.0, v1.3.1) is a Rust CLI that reads an app's accessibility tree (AX on macOS 13+, UI Automation on Windows 10 1809+, AT-SPI on Linux) as JSON with a ref per element (`@<snapshot>:eN`), and acts on a ref through the accessibility API without moving the pointer or taking focus ("headless", its default). Every command prints one JSON envelope with typed errors (`STALE_REF`, `AMBIGUOUS_TARGET`, `PERM_DENIED`, `POLICY_DENIED`) and whether a retry is safe. Its releases are archives with a `checksums.txt`; the macOS one carries a helper that must sit beside the binary.

## Decision

1. **On by default.** Every connected computer whose runner works as the person's own user (never system mode, where agents are their own users) serves the person's apps: macOS, Windows, and Linux with a graphical session. Every agent that may use that computer and run code (`desktop:use` with Run code, both default grants, the organization's code environment on) gets the tools. No switch, no per-app grant, no session approval. The commands switch doesn't gate it: using apps acts as the person, as ADR 0031 §12 says plainly.
2. **Shipped like agent-browser.** The desktop app carries `agent-desktop` (and `agent-desktop-macos-helper` on macOS) as Tauri sidecars, the pinned release checked against `AGENT_DESKTOP_SHA256`, re-signed with our Developer ID so macOS credits Accessibility to agentes.chat. A runner installed from the terminal downloads the same archive into `<runner home>/bin/agent-desktop-<version>/`, checked before unpacking.
3. **One command at a time, with the runner's flags.** `apps.run` names one of `APPS_COMMANDS` (reads, ref actions, `press` to one app, `launch`, `close-app`) and its arguments; the runner allows only its own flag list. Never `--headed` (real input), coordinates, pointer or held-key commands, `--force`, a window by id, `--activate`, sessions, the clipboard, the MCP server. The person's mouse and keyboard are never taken. Text to type goes on stdin.
4. **agentes.chat is never controllable.** An app named like ours (name, bundle id, executable) is refused, and so is the person's web browser (Chrome, Safari, Firefox, Edge, Arc and the rest, by name and bundle id): our web app runs there signed in as the person, under tab titles that don't name us ("#general · Acme"). Agents browse in their own browser. A read of either, or of any window whose title names agentes.chat (a snapshot's window or tree, a find's match path), is dropped, and a ref acts only when that agent's own snapshot of an allowed app gave it. An agent must never click its own approval. The CLI inherits none of its own `AGENT_DESKTOP_*` variables from the runner's environment.
5. **Approvals as the level says.** `apps_act` is sensitive except for calls that can't send, pay, publish or delete: typing, filling, focusing, scrolling, opening, and clicks on elements whose names carry none of those words in our 14 languages. A click on Send, Pay, Publicar or 削除, Enter or Delete pressed in an app, any shortcut with a modifier other than Shift (Mail sends on cmd+shift+d), and typed text with a line break ask a person at the default level; an agent that never asks never asks; one that always asks asks for every action. Where every command asks first, every action does.
6. **Seen and stoppable on the computer.** While an agent acts in an app the desktop app's menu bar says "<Agent> is using <App>" with Stop, and its icon wears the ring. Stop refuses that agent's next commands in the apps for ten minutes.
7. **OS permission.** `PERM_DENIED` becomes ADR 0255's Accessibility wait in the app; the agent reads the same sentence as for a command. No screenshots, so no Screen Recording.
8. **Customer content.** Snapshots are what the person's apps show: the runner never logs what the CLI prints, keeps each agent's snapshots in a state root of its own under the runner's home, and the agent reads them as untrusted screen text.
9. **The loop.** The tools teach read → act → read: `apps_read` (the app's elements with refs, or only those matching `find`, or inside a `root`), `apps_act` (one action, answered with the app read again), `apps_list`.

## Consequences

- An agent on a person's computer can now work in any app with an accessibility tree, through any brain, without the person's pointer.
- Approvals bind by element words, not by meaning: a plain "OK" that confirms a delete isn't caught. An unlisted browser showing a page of ours whose title doesn't name us isn't caught either; reading its address bar is the upgrade. The judge's costly question is the upgrade if that shows up.
- Custom-drawn apps (games, some Electron canvases) expose little; the agent says so.
- Agents with commands could already script apps; this makes it visible, limited to headless actions, and approved where it matters.
