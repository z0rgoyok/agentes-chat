import { closeSync, constants, fstatSync, ftruncateSync, openSync, readSync } from "node:fs";
import { scrubLogLine } from "@agenteschat/adapters/error-scrub";
import {
  BRAIN_LIMITS,
  type BrainTurnTimings,
  cliReadyMs,
  SLOW_TURN_BUDGETS,
} from "@agenteschat/adapters/machine-protocol";

/**
 * Claude Code's own debug log (`--debug-file`), one per process in its folder, read for a turn that is slow or failed:
 * where the time went inside the CLI (its API requests and the API's first byte, retries, MCP servers starting, sign-in
 * refreshes, the network, stalls of its event loop) is said only there.
 */

/** `--debug-file` with no memory growth under heavy logging (its changelog, 2.1.299). */
export const DEBUG_LOG_MIN_CLAUDE = "2.1.299";
/** Past this a log is emptied as a turn starts, so a process open for days never fills its disk. */
const DEBUG_LOG_MAX_BYTES = 4 * 1024 * 1024;
/** The most of a turn's log read: its last part, where a long turn's slow request is. */
const TURN_READ_MAX_BYTES = 1024 * 1024;

/**
 * Lines that explain time. A hook's output (`Hook … success:`) and anything after `content` can hold what a person
 * or a tool wrote, so those never go, whatever else they say.
 */
const EXPLAINS =
  /\[API|\[dispatch\]|first chunk|\bMCP\b|oauth|token refresh|refresh(?:ed|ing)? (?:the )?token|retry|retrying|overloaded|rate.?limit|\b(?:401|429|5\d\d)\b|timed? ?out|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|TLS|DNS|proxy|event-loop-stall|\[STARTUP\]|\[engine\] turn|\[(?:ERROR|WARN)\]/i;
const NEVER = /\bHook\b.*\bsuccess:|"content"|\bprompt\b.*:|Server stderr:/i;
/** Lines that time the model's own wait: kept first when a turn has more lines than its evidence holds. */
const KEY = /\[API|\[dispatch\]|first chunk|\[engine\] turn|retry|overloaded|\b(?:429|529)\b|rate.?limit/i;
const LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) (\[[A-Z]+\]) (.*)$/;

/**
 * The log, opened by root: a plain file of one link, never what a link points to nor a pipe that would block. A
 * sign-in several agents share writes its CLI's log in that sign-in's own folder (`spawn`), where that user could leave
 * one in its place.
 */
function openLog(file: string, flags: number): number | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, flags | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const st = fstatSync(fd);
    if (st.isFile() && st.nlink === 1) return fd;
  } catch {
    // Not written yet (a process starting), gone, or a link.
  }
  if (fd !== undefined) closeSync(fd);
  return undefined;
}

/** Where a turn's lines start: the log's size now, after emptying one past its bound. */
export function debugLogMark(file: string): number {
  const fd = openLog(file, constants.O_RDWR);
  if (fd === undefined) return 0;
  try {
    const size = fstatSync(fd).size;
    if (size <= DEBUG_LOG_MAX_BYTES) return size;
    ftruncateSync(fd, 0);
    return 0;
  } finally {
    closeSync(fd);
  }
}

/** What the log holds from `from` on, its last `TURN_READ_MAX_BYTES` at most. */
function readFrom(file: string, from: number): string {
  const fd = openLog(file, constants.O_RDONLY);
  if (fd === undefined) return "";
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(from > size ? 0 : from, size - TURN_READ_MAX_BYTES);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8");
  } catch {
    return "";
  } finally {
    closeSync(fd);
  }
}

/**
 * The lines of a turn's log that explain time, each timed from `startedAt` (`+412ms [DEBUG] …`) and scrubbed: the
 * first ones and the last ones when there are more than a turn's evidence holds.
 */
export function debugEvidence(text: string, startedAt: number): string[] {
  const kept: string[] = [];
  for (const raw of text.split("\n")) {
    const m = LINE.exec(raw.trimEnd());
    if (!m) continue;
    const [, time = "", level = "", said = ""] = m;
    if (!EXPLAINS.test(said) || NEVER.test(said)) continue;
    const at = Date.parse(time) - startedAt;
    kept.push(scrubLogLine(`${at >= 0 ? "+" : ""}${at}ms ${level} ${said}`).slice(0, BRAIN_LIMITS.evidenceLine));
  }
  const max = BRAIN_LIMITS.evidenceLines;
  if (kept.length <= max) return kept;
  // A cold start's MCP and startup lines would fill it before the API's: those go first, in order, the rest after.
  const ends = (list: number[]) => (list.length <= max ? list : [...list.slice(0, max - 20), ...list.slice(-20)]);
  const all = kept.map((_, i) => i);
  const chosen = new Set(ends(all.filter((i) => KEY.test(kept[i] ?? ""))));
  for (const i of ends(all.filter((i) => !chosen.has(i)))) if (chosen.size < max) chosen.add(i);
  return kept.filter((_, i) => chosen.has(i));
}

/**
 * A turn past a runner's budget (`SLOW_TURN_BUDGETS`): its CLI's start, the runner's waits before it handed the turn
 * over, or its first token once both were done.
 */
export function slowTurn(t: Pick<BrainTurnTimings, "initMs" | "sentMs" | "firstTokenMs" | "retries">): boolean {
  const b = SLOW_TURN_BUDGETS;
  if ((t.initMs ?? 0) > b.initMs || (t.sentMs ?? 0) > b.preTurnMs || (t.retries ?? 0) > 0) return true;
  return t.firstTokenMs !== undefined && t.firstTokenMs - cliReadyMs(t) > b.firstByteMs;
}

/** A turn's evidence from its process's log (`file`, marked at `from` as the turn began). */
export function turnEvidence(file: string, from: number, startedAt: number): string[] {
  return debugEvidence(readFrom(file, from), startedAt);
}
