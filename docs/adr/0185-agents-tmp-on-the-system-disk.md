# 0185. Each agent's /tmp on the system disk

- Status: Accepted (built: core's runner, off unless a computer's config turns it on). The agentes.chat Cloud turns
  it on per host, one VM first
- Date: 2026-11-14
- Amends: ADR 0096 §3 (each agent's /tmp was in its tmpfs, in memory)
- Code: runner `agent-users.ts` (`agentRam`, `DISK_TMP`, the `tmpOnDisk` of `systemLauncher` and
  `containersCommand`), `service.ts` (`AGENT_DISK_TMP_ROOT`, `AGENT_TMP_CLEANUP`), `config.ts` (`agentTmpOnDisk`),
  `daemon.ts` (`configFromGrant`); tests `agent-users.test.ts`, `system-mode.test.ts`, `isolation.root.test.ts`

## Context

ADR 0096 gave each agent one tmpfs of its own (`/run/agentes-runner-tmp/<uid>`, up to half the RAM) holding its /tmp,
its /dev/shm, its /run/lock and its runtime dir. The kernel can't drop a tmpfs's pages, only swap them out, so what
programs leave in /tmp holds that much RAM until they delete it or the computer restarts: a build tree or a few GiB of
downloads in one agent's /tmp are a few GiB of RAM no other agent or VM can use. /dev/shm is different: it is memory
that processes share (Chrome's renderers among them), which only RAM serves well.

A folder on the system disk alone would trade that for the disk: nothing would bound what agents leave there, and the
system's own services (apt, journald, a provisioner's state) share that disk's blocks and inodes. ext4 keeps 5% of the
blocks for root, and no inodes for anyone.

## Decision

1. **A switch, per computer, off by default.** `"agentTmpOnDisk": true` in the runner's `config.json` puts each agent's
   /tmp on the system disk. The runner reads it in its own home and in the computer's (`/var/lib/agentes-runner`), so
   one line there covers every organization's runner on the server's own computer, whose homes are
   `<state>/orgs/<orgId>`. Without it, or with a config that can't be read, the launch is exactly as before. Pairing
   again keeps it, as it keeps the other settings only root writes there. Whatever provisions the computer sets it as
   root. A later change can make it the default once it has run on real computers.
2. **A filesystem of the agents' own.** `/var/cache/agentes-runner-tmp` (0700, root's) holds `image` and its mount,
   `fs`. At the first launch on disk after a boot, under the lock, root makes `image` anew, a sparse file of half what
   that disk has free for users, as an ext4 with no journal (nothing in it outlives the boot), no reserve and one inode
   per 4 KiB block, and mounts it at `fs` (`loop,discard,nosuid,nodev`). Each agent's /tmp is `fs/<uid>`, root's and
   1777 as the tmpfs's folder was. So agents can't take the system's inodes or more than half its free room, deleting
   gives the room back to the disk at once (`discard`), and each boot starts from an empty filesystem. A new file every
   time, never the old one rewritten: an agent still bound into an earlier one keeps it. It is on the system disk, never
   under a workspace path (`/home`, `/srv/agentes`, `/var/lib/agentes-runner*`…), which a host may keep on a data disk
   that moves and backups copy. Its /dev/shm, /run/lock and runtime dir stay in its tmpfs.
3. **Chosen once a boot.** The launch's first step, as root on the computer, mounts the agent's tmpfs at its first
   launch after the computer starts, under a lock, and then binds its folder on disk at `<tmpfs>/tmp`, which each
   launch's own mount namespace binds over /tmp as before. A later launch finds the tmpfs and changes nothing, so all of
   an agent's processes see one /tmp until the next boot, whatever the switch says meanwhile.
4. **The boot frees it.** systemd-tmpfiles' boot run removes `image` before any agent starts (`r!`: a later `--remove`
   leaves it), so a computer switched back to memory doesn't keep its room; the first launch on disk removes it too.
   What is 10 days old goes meanwhile, through the agent's tmpfs, as in its other folders. `service install --system`
   writes the line with the others (`/etc/tmpfiles.d/agentes-runner.conf`), and the installer runs that at every
   upgrade.
5. **The computer's own /tmp** (Debian 13 mounts a tmpfs there, `tmp.mount`) is left as it is: agents never see it,
   and it is the operator's to keep in memory or not (`systemctl mask tmp.mount`, from the next boot).

## Consequences

- On disk, an agent's /tmp grows on the disk, and the part it uses is page cache, which the kernel takes back when
  memory is short. A program that writes a large file to /tmp writes it to the disk.
- All agents' /tmp together get at most half of what the disk had free at the boot's first launch on disk, and one
  agent can fill it for the others, as one tmpfs of half the RAM each could fill the memory. If the rest of the disk
  fills meanwhile, writes in /tmp fail too.
- It needs loop devices and `mkfs.ext4` (e2fsprogs): without them, as in an unprivileged container, every launch on
  disk fails with mount's or mkfs's error, and removing the switch puts the next launch back in memory, no reboot
  needed, since nothing was mounted.
- An upgrade changes no launch, so it restarts no containers service. A change of the switch restarts each agent's
  containers service at its next `ensureContainers` (its command's hash covers the step), though the agent's /tmp moves
  only at the next boot.
- No machine protocol change.
