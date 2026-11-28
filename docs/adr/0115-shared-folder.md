# 0115. A shared folder for the agents on a computer

- Status: Accepted
- Date: 2026-11-01
- Code: `apps/server/runner/shared-folder.ts` (folder, group, ACLs, `withShared`, `sharedSizeGb`), `apps/server/runner/agent-users.ts` (`joinShared` at an agent's first request, `PATH`), `apps/server/runner/daemon.ts` (`prepareShared`, `access()`, the load report), `apps/server/runner/access.ts` (`foldersFor`), `apps/server/runner/desktop-look.ts` (the file manager's bookmark), `packages/adapters/src/machine-protocol.ts` (`ALL_AGENTS`, `grantedTo`, `sharedFolderOf`, `MachineLoad.diskFreeGb`/`diskUse`/`sharedGb`), `packages/adapters/src/host-stats.ts` (`diskFigures`), `packages/engine/src/context.ts` (`sharedFolderText`), `packages/engine/src/machine-hub.ts` and `notification-producers.ts` (`notifyComputerDiskFull`), `packages/engine/src/machines.ts` (`disk` in the view), `apps/server/runner/disk-parts.ts` (what takes the disk); web `apps/web/src/components/Machines.tsx` (the row in Pastas liberadas), `apps/web/src/components/StorageSettings.tsx` (the computer's disk by kind)

## Context

Agents on one computer each work in their own folder, and in system mode (ADR 0057) as their own OS user, so nothing one of them fetches reaches another. A customer had three agents on one computer install the same CLIs, three times, and agents clone the same repositories and download the same datasets each for itself.

## Decision

1. **One shared folder per computer**, called `Shared` where a name shows.
   - **System mode**: `/srv/agentes/shared`, made by root as `install -d -m 2770 -o root -g agentes-shared`, with the default ACLs `g:agentes-shared:rwx,d:g:agentes-shared:rwX,d:m::rwX,d:o::-`, so what any agent makes there keeps the group and stays the group's to write whatever its umask. `bin/` is made inside with a umask, never a chmod. Root never chmods, chowns or follows anything inside the folder afterwards: an agent may have put a link anywhere there. Each agent's user joins the group at its first request after the runner starts (`usermod -aG`, which covers new and existing agents alike), and gets `~/shared`, a link made as the agent itself (a home that already has that name keeps it). On the server's own computer, where several organizations' runners share one machine, each has `/srv/agentes/shared-<machine id8>` and the group `agentes-sh-<id8>`, so nothing crosses organizations.
   - **Single-user mode** (a person's own computer, every OS): `<workspace>/shared`, no group or ACL: every agent is the same user there.
2. **Reached through the allowed folders** (ADR 0036 §8): the runner grants the folder to every agent with one grant whose agents are `*` (`ALL_AGENTS`). File tools, Claude Code's `--add-dir`, Codex's writable roots and the prompt follow from it with no path of their own. The grant is the session's (`access()`), never written to the config, so it can't be removed and comes back on every start; the desktop app leaves it out of its folder list and the web shows it as a row of its own.
3. **Install once for all agents**: `<home>/shared/bin` ends every agent launch's `PATH` (last, so a tool an agent put there never replaces the computer's own), and the prompt tells agents to install command-line tools others will use there, without root. A tool there runs as whichever agent calls it, with that agent's files and sign-ins, so the runner's own launches (Claude Code, Codex, sign-in commands, through `resolveCommand`) never look in it: the launcher names it in `AGENTES_SHARED_BIN` and the lookup skips it, even when the command is nowhere else.
4. **The prompt**: a block `# Shared folder on "<computer>"` after the agent's folders: look there first before downloading or cloning anything big; put there what others will need; in system mode, copy with `cp -r --no-preserve=mode` then delete (the default ACL caps the group's access to the mode a file is created with: a plain `cp` keeps the source's, 0644 or 0755, read-only to the others, and `mv` keeps its owner's group), or `chgrp -R --reference=<folder>` and `chmod -R g+rwX` on what is already there; a lock around clones into it (`flock` on Linux, a `mkdir` lock folder on a Mac or Windows); never credentials, `.env`, tokens, keys or sign-in folders; read a script before running it; `df -h` before more than 1 GB (on Windows, the disk's free space in words). The computer's `os` picks the commands, since single-user mode runs on every OS.
5. **Space**: the load report (`pong.load`, protocol 22) carries the workspace disk's free GB and share in use, and the shared folder's size, measured by `nice du -sk` every hour (no protocol number: an older runner just doesn't send them). The computer's page shows the folder's path, size and the free space. When a report crosses 85% in use, the workspace's admins (`configure`) get a `computer_disk_full` notification, in the inbox only; the server marks the stored load (`diskWarned`) and arms the warning again only under 80%, and a report without disk figures (a runner just started) keeps the last ones, so a restart or a disk hovering at the line notifies nobody again.

## Consequences

- Agents on one computer can read and change each other's shared work, by design: the folder is for what they choose to share. Their own folders, `/tmp` and ports stay private (ADR 0057).
- The runner changed: an older runner has no shared folder, and the prompt says nothing of one.
- agentes.chat Cloud's computers need the `acl` package in their image; without it the folder works, but files stay read-only to the group until an agent runs `chmod g+w`.
- A big shared folder costs one `du` walk an hour, at the lowest priority.

## Addendum (2026-11-11): the shared `bin/` is reached by full path in system mode

Replaces the `PATH` part of decision 3. In system mode every agent's user can write the shared `bin/`, and a tool runs as whichever agent calls it, with that agent's files and sign-ins. A tool found there by name would let one agent's file run as another, so:

- An agent launch's `PATH` is the computer's own folders only (`/usr/local/bin:/usr/bin:/bin`), for every process started through the agent's launcher: brains, commands, terminals, desktops and workers.
- `AGENTES_SHARED_BIN` still names the folder, and `resolveCommand` still skips it.
- The prompt tells agents the folder is not on their `PATH`: read a tool there first, then run it by its full path. They do so on their own, with no approval.

Single-user mode is unchanged: every agent is the same user there, and its `PATH` was never extended.

## Addendum (2026-11-21): files brought in become the group's

The default ACL covers only what is created in the folder. A file moved in keeps its mode and group, and one copied in (`cp`, `tar`, `unzip`, a renderer that copies its output) takes its source's mode, typically 0644. The other agents then can't write it, and only its owner may `chmod` it, so agents ended up running their own `chmod` loops. The prompt's advice (decision 4) wasn't enough.

- Every minute, in system mode, the runner (`shareAgentFiles` in `shared-folder.ts`) lists as root, with `find -P`, the owners of entries in the folder that the group can't change: not of the group, a folder without the setgid bit (made elsewhere, so without the default ACL), or a file without the group's read and write.
- Each listed agent then fixes its own entries as itself (`runuser`), at the lowest priority: `chgrp -h` to the group, `g+rwxs` and the default ACL on folders, `g+rwX` on files. Root still never changes anything inside the folder.
- The `find` walk costs a little CPU each minute. When nothing needs fixing, the runner starts no agent process.
- Computers that already exist are fixed at the first pass after their runner updates.

## Addendum (2026-11-26): what takes the disk, by kind

- In system mode on Linux the runner also measures what takes the workspace disk, by kind (`apps/server/runner/disk-parts.ts`): projects and code (the git cache and the checkouts found up to three folders deep in the workspace and the homes), apps and tools (`/usr/local`, `/opt`, the runner's home, container images, each home's `.local`, `.bun`, `.nvm`, `.cargo`, `.rustup`, `go`, `.pyenv`), the agents' files (the workspace, the agents' homes and sign-in stores, `/home`, `/root`), caches and temporary files (each home's `.cache`, `.npm` and Bun's cache, the agents' disk temp folders, `/var/cache`, `/var/tmp`, `/tmp`) and the system (`/usr`, `/boot`, `/etc`, `/var`). Whatever else is in use shows as Other.
- One `ionice -c3 nice -n 19 du -skx` over those paths, narrowest first: GNU `du` counts what two of its arguments share once, for the first, so a checkout inside an agent's folder counts as a project and only the rest as the agent's. Only paths on the workspace's disk are passed (an own host's VM keeps the workspace on a data disk of its own). It runs at the session's start and every 6 hours (`DISK_PARTS_MS`), and the result is kept in `disk-parts.json` in the runner's home, so a restart within those hours doesn't walk the disk again.
- `pong.load` carries it as `diskParts` (GB per kind) with the disk's size (`diskGb`), with no protocol number, as the other disk figures. The view's `disk` gains `sizeGb` and `parts`. Settings › Armazenamento shows the workspace's own computer under the files' storage: a bar by kind with a legend (each kind's amount, then what is free) and, from 85% in use, a line on what to do with a button that opens the right hand's DM with a request to clear caches and temporary files already written.
