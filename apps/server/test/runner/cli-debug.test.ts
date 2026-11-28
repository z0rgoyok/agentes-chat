import { afterAll, expect, test } from "bun:test";
import { linkSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { debugEvidence, debugLogMark, slowTurn, turnEvidence } from "../../runner/cli-debug";

const dir = mkdtempSync(path.join(os.tmpdir(), "cli-debug-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const START = Date.parse("2026-11-26T22:35:00.000Z");
const LOG = [
  "2026-11-26T22:35:00.138Z [DEBUG] [STARTUP] Loading MCP configs...",
  "2026-11-26T22:35:00.149Z [DEBUG] Failed to stat directory /Users/ana/.claude/agents: ENOENT",
  '2026-11-26T22:35:00.326Z [DEBUG] "Hook SessionStart:startup (SessionStart) success:\\nretry the MCP prompt she wrote"',
  "she wrote this on a line of its own",
  "2026-11-26T22:35:00.439Z [DEBUG] [API REQUEST] /v1/messages x-client-request-id=2d94e0f6-d9c2-467b-87cf-d54a1db43195",
  "2026-11-26T22:35:04.597Z [DEBUG] [API:timing] first byte after 4158ms",
  '2026-11-26T22:35:05.000Z [ERROR] MCP server "agentes" Connection failed for ana@example.com at /Users/ana/x',
].join("\n");

test("a turn's evidence: the lines that explain time, timed from the turn, scrubbed; a hook's words never", () => {
  expect(debugEvidence(LOG, START)).toEqual([
    "+138ms [DEBUG] [STARTUP] Loading MCP configs...",
    "+439ms [DEBUG] [API REQUEST] /v1/messages x-client-request-id=2d94e0f6-d9c2-467b-87cf-d54a1db43195",
    "+4597ms [DEBUG] [API:timing] first byte after 4158ms",
    '+5000ms [ERROR] MCP server "agentes" Connection failed for [email] at ~/x',
  ]);
});

test("a long log keeps its first lines and its last ones", () => {
  const many = Array.from({ length: 100 }, (_, i) => `2026-11-26T22:35:00.000Z [DEBUG] [API REQUEST] n=${i}`);
  const kept = debugEvidence(many.join("\n"), START);
  expect(kept).toHaveLength(60);
  expect(kept[0]).toEndWith("n=0");
  expect(kept[39]).toEndWith("n=39");
  expect(kept[40]).toEndWith("n=80");
  expect(kept.at(-1)).toEndWith("n=99");
});

test("a cold start's many MCP lines never crowd out the API's wait; a server's stderr never goes", () => {
  const mcp = Array.from({ length: 80 }, (_, i) => `2026-11-26T22:35:00.100Z [DEBUG] MCP server "agentes": step ${i}`);
  const log = [
    ...mcp,
    '2026-11-26T22:35:00.200Z [ERROR] "MCP server \\"agentes\\" Server stderr: the customer list she pasted"',
    "2026-11-26T22:35:00.300Z [DEBUG] [API REQUEST] /v1/messages x-client-request-id=2d94e0f6",
    "2026-11-26T22:35:08.300Z [DEBUG] [API:timing] first byte after 8000ms",
    ...mcp,
  ];
  const kept = debugEvidence(log.join("\n"), START);
  expect(kept).toHaveLength(60);
  expect(kept).toContain("+8300ms [DEBUG] [API:timing] first byte after 8000ms");
  expect(kept.some((l) => l.includes("[API REQUEST]"))).toBe(true);
  expect(kept.join("\n")).not.toContain("pasted");
});

test("a turn reads its log from where it began, and a log past its bound is emptied as a turn starts", () => {
  const file = path.join(dir, "debug.log");
  expect(debugLogMark(file)).toBe(0);
  writeFileSync(file, `${LOG.split("\n")[0]}\n`);
  const from = debugLogMark(file);
  writeFileSync(file, `${LOG}\n`, { flag: "a" });
  expect(turnEvidence(file, from, START)[0]).toStartWith("+138ms [DEBUG] [STARTUP]");
  expect(turnEvidence(file, from, START)).toHaveLength(4);
  writeFileSync(file, "x".repeat(5 * 1024 * 1024));
  expect(debugLogMark(file)).toBe(0);
  expect(statSync(file).size).toBe(0);
});

test.if(process.platform !== "win32")(
  "a link left where the log goes is never emptied nor read through, a symbolic one or a hard one",
  () => {
    const target = path.join(dir, "root-owned");
    writeFileSync(target, `${LOG}\n${"x".repeat(5 * 1024 * 1024)}`);
    const size = statSync(target).size;
    const soft = path.join(dir, "soft.log");
    const hard = path.join(dir, "hard.log");
    symlinkSync(target, soft);
    linkSync(target, hard);
    for (const file of [soft, hard]) {
      expect(debugLogMark(file)).toBe(0);
      expect(turnEvidence(file, 0, START)).toEqual([]);
    }
    expect(statSync(target).size).toBe(size);
  },
);

test("a turn is slow past its CLI's start, a retry, or a late first token once ready", () => {
  expect(slowTurn({ initMs: 3000, firstTokenMs: 5000 })).toBe(false);
  expect(slowTurn({ initMs: 9000, firstTokenMs: 10_000 })).toBe(true);
  expect(slowTurn({ firstTokenMs: 6500 })).toBe(true);
  expect(slowTurn({ initMs: 4000, firstTokenMs: 9000 })).toBe(false);
  expect(slowTurn({ firstTokenMs: 900, retries: 1 })).toBe(true);
  expect(slowTurn({})).toBe(false);
  // Its runner's own wait before the CLI had the turn is its own budget, and the first token counts from after it.
  expect(slowTurn({ sentMs: 30_000, firstTokenMs: 31_000 })).toBe(true);
  expect(slowTurn({ sentMs: 1000, firstTokenMs: 6500 })).toBe(false);
});
