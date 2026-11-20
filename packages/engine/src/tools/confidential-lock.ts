import type { RunAuthority } from "../authority";
import { CONFIDENTIAL_OUTBOUND } from "../confidential";
import { toolKind } from "./run-policy";
import type { ToolDefinition, ToolOutput } from "./types";

/**
 * The lock of a confidential thread (ADR 0190): after a run read a confidential result, it and every later run of
 * its thread keep reading, answer in the thread, and send nothing elsewhere. By name, never by kind alone: a kind is
 * wider than its name (`here` holds a GIF search and cards that make things; `self` holds the status line every
 * member sees), and a tool added later is refused until someone reads its handler and adds its name.
 */

/** In the run's own conversation: a reaction, a sticker, a question or a card people answer there, its own wake. */
const HERE = new Set([
  "react",
  "send_sticker",
  "ask_user",
  "ask_choices",
  "show_block",
  "start_poll",
  "follow_up",
  "cancel_follow_up",
  "release_waiting_agent",
]);

/**
 * Of those, the ones whose words the apps show as formatted text on a card, where an address would be a link: what a
 * run types into them is kept inert, as its reply is (`inertLinks`). A block runs in a frame with no network, and a
 * follow-up's line is a message.
 */
export const CARD_WORDS: ReadonlySet<string> = new Set(["ask_user", "ask_choices", "start_poll"]);

/** On the run or its agent alone, with nothing anyone else reads. */
const SELF = new Set(["withdraw_request", "set_reply_style", "wait_for_device", "commit_co_author"]);

/** Built-in reads whose words leave the server: the web, and the wiki's search (its query is embedded). */
const READS_OUT = new Set(["web_search", "web_fetch", "image_search", "search_wiki"]);

/** What a run reads when the lock refuses a call. A refusal, never a card: an agent that never asks would lift one. */
export const CONFIDENTIAL_REFUSAL =
  "Refused: this conversation holds confidential text, so nothing leaves it. No message, mail or post elsewhere, no file, page, issue, task or memory, no command, browser or web, no write to a connected app. You can still read (files on your computer, the workspace's search, connected apps' reads), use the tools of the server that gave you the text, ask the people here and answer here. Say what you found in your reply.";

/** The lock's refusal as a tool's answer, with the code the turn's judge reads as final. */
export const confidentialRefusal = (): ToolOutput => ({
  content: CONFIDENTIAL_REFUSAL,
  isError: true,
  data: { code: CONFIDENTIAL_OUTBOUND },
});

export interface LockedCall {
  /** One of the server's own tools, whatever connection id it carries for a credential. */
  own: boolean;
  /** The connections whose results marked the thread: all of their tools stay. */
  marking: readonly string[];
  /** What the run asks a person would be posted outside its thread (`asksOutside`). */
  asksOutside: boolean;
}

/** What puts a card for a person to answer. */
const ASKS = new Set(["ask_user", "ask_choices"]);

interface Place {
  channelId: string;
  threadRootId: string;
}

/**
 * Whether what a run asks a person (a question, an approval) is posted outside its own thread: a routine's own run
 * asks where the routine reports, and a run another agent asked asks where the person behind that agent is
 * (`consulted`: `consultationOrigin`). People there are not the thread's readers, and a reply under the card starts
 * a run the lock does not hold.
 */
export function asksOutside(run: Place, authority: RunAuthority | null, consulted: Place | null): boolean {
  const report = authority?.kind === "routine" ? authority.brief?.deliverTo : undefined;
  const asks = report ? { channelId: report.channelId, threadRootId: report.threadId ?? run.threadRootId } : consulted;
  return asks != null && (asks.channelId !== run.channelId || asks.threadRootId !== run.threadRootId);
}

/** Whether a run of a confidential thread may call `tool` (the tool a directory's `use_tool` reached, not the way in). */
export function confidentialLockAllows(tool: ToolDefinition, call: LockedCall): boolean {
  const what = toolKind(tool);
  if (what.kind === "directory") return true;
  if (tool.connectionId && !call.own) {
    if (call.marking.includes(tool.connectionId)) return true;
    // A read's arguments go to whoever runs the server: a catalog connector's vendor or the operator, nobody else's.
    return what.kind === "read" && (tool.server === "catalog" || tool.server === "vouched");
  }
  switch (what.kind) {
    case "pass":
      return true;
    case "here":
      return HERE.has(tool.name) && !(ASKS.has(tool.name) && call.asksOutside);
    case "self":
      return SELF.has(tool.name);
    case "read":
      return !READS_OUT.has(tool.name);
    // A routine's report (`hand_off`) with the rest: its text is kept as the routine's record, which the next run
    // of the routine is handed outside this thread.
    default:
      return false;
  }
}
