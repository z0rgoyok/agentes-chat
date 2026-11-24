# 0209. Agents' own Docker daemon and KVM, each as its own user

- Status: Accepted (built)
- Date: 2026-11-20
- Amends: 0169 (§1: `docker` is Docker's own rootless daemon where the computer has it, Podman's elsewhere; §4: every
  launch's `DOCKER_HOST` is that daemon's socket, `CONTAINER_HOST` stays Podman's)
- Code: runner `agent-users.ts` (`rootlessDocker`, `dockerUnits`, `CONTAINERS_START`, `containersCommand`'s `docker`,
  the launcher's `docker`, `joinKvm`), `mcp.ts` (`mcpScopeFromEnv`'s `rootlessContainers`); adapters
  `command-policy.ts` (`CommandScope.rootlessContainers`, `hostAccess`); engine `mission-commands.ts` (`scopeOf`),
  `context.ts` (`containersText`); tests `agent-users.test.ts`, `permission-prompt.test.ts`, `bad-actor.test.ts`,
  `computer-profile.test.ts`, `turn-context.test.ts`

## Context

Agents build images, run compose stacks, Docker-in-Docker and kind, and run Android emulators and other KVM guests.
Podman's Docker API covers most of `docker`, but not buildx and BuildKit as Docker ships them, nor every compose and
SDK corner. Real root on a computer agents share can't be given per agent: root there reaches every home, the
firewall and the runner. Root inside a user namespace, and VMs of one's own through `/dev/kvm`, can.

## Decision

1. **Each agent its own rootless dockerd**, where the computer has Docker's rootless install (`docker`, `dockerd`,
   `dockerd-rootless.sh` and `rootlesskit`: Docker's `docker-ce`, `docker-ce-cli`, `docker-ce-rootless-extras`,
   `docker-buildx-plugin`, `docker-compose-plugin`). It runs in the agent's containers service (ADR 0169 §3), as a user
   unit of the agent's user manager: everything that service gives Podman holds for it (the agent's network, slice,
   home, delegated cgroup, nosuid view, the bounding set without NET_ADMIN and NET_RAW). Root never runs a Docker
   daemon for agents and nobody joins the `docker` group.
2. **Started on first use.** Three units, written by the service's start into the agent's runtime dir at every start
   (`dockerUnits`), where systemd reads them after the agent's own `~/.config/systemd/user`: `docker-api.socket`
   listens on `/run/user/<uid>/docker.sock` (0600), and each connection is `docker-api@.service`, `docker system
   dial-stdio` to the daemon's own socket, which requires `docker.service`, `dockerd-rootless.sh` (`Type=notify`). The
   first connection starts the daemon, so an agent that never uses Docker never pays its memory (about 60-100 MB).
   `docker system dial-stdio`, not systemd-socket-proxyd, which up to systemd 257 drops a stream half-closed one way
   (`docker exec -i … < file`). Once started it stays until the service stops (a restart of the computer, a hold, the
   agent leaving): an idle stop would end detached containers. The agent may mask the socket or replace any unit.
3. **Its network is the agent's**: rootlesskit's network through pasta (`DOCKERD_ROOTLESS_ROOTLESSKIT_NET=pasta`, port
   driver `implicit`), which runs as the agent's uid in the agent's network, so every per-uid rule and proxy holds as
   for Podman (ADR 0169 §6). The computer's loopback stays out of reach (`DISABLE_HOST_LOOPBACK`), and `--network host`
   is rootlesskit's namespace, never the computer's, so no container opens a socket on the computer's network as a
   subordinate id.
4. **Every launch's `DOCKER_HOST`** names `/run/user/<uid>/docker.sock` where rootless Docker is; `CONTAINER_HOST`
   stays Podman's, so `podman` works as before. Images and volumes are in `~/.local/share/docker`, in the agent's home
   and share. A sandboxed CLI (ADR 0169 §9) still gets neither.
5. **Root inside a container is the agent's**: under its own rootless engine (`DOCKER_HOST` in its runtime dir), the
   command policy no longer refuses `--privileged`, added capabilities, the host's namespaces, `/` or the engine's
   socket mounted, since all of it reaches only the agent's user namespace and what its uid already reaches
   (`CommandScope.rootlessContainers`, set by the runner's MCP from its launch's environment). `--pid=host` stays
   refused. Real root on the computer stays impossible.
6. **KVM as the agent.** Where `/dev/kvm` opens to a group that isn't root's (a VM with nested virtualization, bare
   metal), each agent's user joins that group at its first request in a runner process (`joinKvm`), so Android's
   emulator, QEMU and Firecracker run with KVM as the agent's own uid and in its slice. Every open of the device makes
   VMs of that opener's alone: no agent reaches another's.

## Consequences

- `docker`, `docker compose`, `docker buildx` and the Docker SDKs talk to Docker itself; `podman` to Podman.
- A runner whose service command changes restarts every agent's containers service once (ADR 0169 §8), and with it
  their running containers.
- A dockerd that can't start (a module, a missing helper) fails the connection; Podman still works, and the computer's
  journal says why (`journalctl _UID=<uid> _SYSTEMD_USER_UNIT=docker.service`).
- KVM opens the host's nested virtualization code to agents' guests: whoever runs the computer chooses that by giving
  it `/dev/kvm`.
