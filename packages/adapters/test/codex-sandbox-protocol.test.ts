import { expect, test } from "bun:test";
import { CODEX_UNELEVATED_PROTOCOL, MACHINE_PROTOCOL_VERSION, parseRunnerFrame } from "../src/machine-protocol";

/** A Windows computer's build and what holds Codex's commands there, on the wire (ADR 0053's addendum of 2026-11-24). */

const hello = (extra: Record<string, unknown>) =>
  parseRunnerFrame(
    JSON.stringify({
      type: "hello",
      token: "agm_x",
      version: "1.0.0",
      protocol: CODEX_UNELEVATED_PROTOCOL,
      os: "windows",
      ...extra,
    }),
  );

test("hello's Windows build: a build number only", () => {
  expect(MACHINE_PROTOCOL_VERSION).toBeGreaterThanOrEqual(CODEX_UNELEVATED_PROTOCOL);
  const frame = hello({ windowsBuild: "10.0.19045" });
  expect(frame?.type === "hello" && frame.windowsBuild).toBe("10.0.19045");
  for (const windowsBuild of ["Windows 10 Pro", "10.0.19045; rm -rf", 19045, "1".repeat(40)]) {
    const other = hello({ windowsBuild });
    expect(other?.type === "hello" && "windowsBuild" in other).toBe(false);
  }
});

test("Codex's sandbox rides on its executor, in hello and executors.changed alike; nothing else is believed", () => {
  const codex = { version: "codex-cli 0.170.0", sandbox: "unelevated" as const };
  const frame = hello({ executors: { codex, claude: { version: "2.1.300", sandbox: "mxc" } } });
  expect(frame?.type === "hello" && frame.executors).toEqual({ codex, claude: { version: "2.1.300" } });
  for (const sandbox of ["mxc", "none"] as const) {
    expect(
      parseRunnerFrame(JSON.stringify({ type: "executors.changed", executors: { codex: { ...codex, sandbox } } })),
    ).toEqual({ type: "executors.changed", executors: { codex: { ...codex, sandbox } } });
  }
  const odd = parseRunnerFrame(
    JSON.stringify({ type: "executors.changed", executors: { codex: { ...codex, sandbox: "elevated" } } }),
  );
  expect(odd).toEqual({ type: "executors.changed", executors: { codex: { version: codex.version } } });
});
