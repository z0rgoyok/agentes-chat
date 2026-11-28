import { expect, test } from "bun:test";
import {
  CLI_COPIES_PROTOCOL,
  CLI_NAMES,
  FETCH_NAMES,
  MACHINE_OPS,
  MACHINE_PROTOCOL_VERSION,
  parseCliFetchState,
  parseRunnerFrame,
  parseServerFrame,
} from "../src/machine-protocol";

/* Protocol 86 (ADR 0228 §6): the pins after `welcome`, `hello.clis`, `cli.fetch` frames and the `cli.fetch` op. */

test("the protocol says it", () => {
  expect(MACHINE_PROTOCOL_VERSION).toBeGreaterThanOrEqual(CLI_COPIES_PROTOCOL);
  expect(MACHINE_OPS).toContain("cli.fetch");
});

test("a fetch's state, checked: known states, counts that are numbers, a known reason or `failed`", () => {
  expect(parseCliFetchState({ state: "fetching", version: "1.0.0", done: 10.7, total: 100 })).toEqual({
    state: "fetching",
    version: "1.0.0",
    done: 10,
    total: 100,
  });
  expect(parseCliFetchState({ state: "fetching", version: "1.0.0", done: 500, total: 100 })).toMatchObject({
    done: 100,
  });
  expect(parseCliFetchState({ state: "fetching", version: "1.0.0", done: -1, total: "x" })).toEqual({
    state: "fetching",
    version: "1.0.0",
    done: 0,
    total: null,
  });
  expect(parseCliFetchState({ state: "failed", version: "1", reason: "hash_mismatch" })).toMatchObject({
    reason: "hash_mismatch",
  });
  expect(parseCliFetchState({ state: "failed", version: "1", reason: "rm -rf" })).toMatchObject({ reason: "failed" });
  expect(parseCliFetchState({ state: "ready", version: "1" })).toEqual({ state: "ready", version: "1" });
  expect(parseCliFetchState({ state: "done", version: "1" })).toBeNull();
  expect(parseCliFetchState({ state: "ready" })).toBeNull();
});

test("the runner's frames: `cli.fetch` for a known CLI, and `hello.clis` with known CLIs only", () => {
  const frame = parseRunnerFrame(
    JSON.stringify({
      type: "cli.fetch",
      cli: "claude",
      fetch: { state: "fetching", version: "2.1.325", done: 1, total: 2 },
    }),
  );
  expect(frame).toEqual({
    type: "cli.fetch",
    cli: "claude",
    fetch: { state: "fetching", version: "2.1.325", done: 1, total: 2 },
  });
  expect(
    parseRunnerFrame(JSON.stringify({ type: "cli.fetch", cli: "bash", fetch: { state: "ready", version: "1" } })),
  ).toBeNull();
  const hello = parseRunnerFrame(
    JSON.stringify({
      type: "hello",
      token: "t",
      version: "1",
      protocol: CLI_COPIES_PROTOCOL,
      os: "darwin",
      clis: { fetchable: ["claude", "nope", "grok"], fetch: { grok: { state: "ready", version: "1.0.92" }, x: {} } },
    }),
  );
  expect(hello && "clis" in hello ? hello.clis : null).toEqual({
    fetchable: ["claude", "grok"],
    fetch: { grok: { state: "ready", version: "1.0.92" } },
  });
});

test("the server's pins and the retry op reach the runner", () => {
  expect(parseServerFrame(JSON.stringify({ type: "clis.pins", pins: { claude: {} } }))).toMatchObject({
    type: "clis.pins",
  });
  expect(parseServerFrame(JSON.stringify({ type: "clis.pins", pins: "x" }))).toBeNull();
  expect(parseServerFrame(JSON.stringify({ type: "request", id: "1", op: "cli.fetch", cli: "codex" }))).toMatchObject({
    op: "cli.fetch",
  });
});

test("Git for Windows, fetched like a CLI there: in hello.clis and its fetch frames, never among the executors", () => {
  const hello = parseRunnerFrame(
    JSON.stringify({
      type: "hello",
      token: "t",
      version: "1",
      protocol: CLI_COPIES_PROTOCOL,
      os: "windows",
      clis: {
        fetchable: ["claude", "git"],
        fetch: { git: { state: "fetching", version: "2.56.1", done: 1, total: 4 } },
      },
    }),
  );
  expect(hello && "clis" in hello ? hello.clis : null).toEqual({
    fetchable: ["claude", "git"],
    fetch: { git: { state: "fetching", version: "2.56.1", done: 1, total: 4 } },
  });
  expect(
    parseRunnerFrame(JSON.stringify({ type: "cli.fetch", cli: "git", fetch: { state: "ready", version: "2.56.1" } })),
  ).toEqual({ type: "cli.fetch", cli: "git", fetch: { state: "ready", version: "2.56.1" } });
  expect(FETCH_NAMES).toContain("git");
  expect(CLI_NAMES as readonly string[]).not.toContain("git");
});
