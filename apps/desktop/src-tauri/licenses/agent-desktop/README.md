# agent-desktop

The app bundles `agent-desktop` (Vercel Labs, https://github.com/vercel-labs/agent-desktop) as a sidecar next to the runner, which lets agents use the person's own apps through the system's accessibility (ADR 0258). On macOS its helper, `agent-desktop-macos-helper`, sits beside it. Its version and SHA-256 are pinned in `packages/adapters/src/machine-protocol.ts` (`AGENT_DESKTOP_VERSION`, `AGENT_DESKTOP_SHA256`).

- `LICENSE`: agent-desktop, Apache License 2.0. The project ships no NOTICE file. The Rust crates built into the binary are under the permissive licenses its `deny.toml` allows.
