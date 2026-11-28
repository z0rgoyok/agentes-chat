import type { TFunction } from "i18next";
import type { CustomServer, CustomTool, ToolAccess, ToolDecision } from "../api/types";
import { formatInt } from "./format";

/**
 * Classification of a custom MCP server's tools ("O que {{name}} faz"). Each
 * tool is on or off, and when on it reads, writes, or always asks for
 * approval. Undecided tools start with the backend's suggestion (else: read
 * when the server says read-only, approval otherwise). Nothing is exposed
 * until an admin saves; tools that appear later stay hidden until decided.
 */

export const defaultAccess = (tool: Pick<CustomTool, "readOnlyHint">): ToolAccess =>
  tool.readOnlyHint === true ? "read" : "approval";

/** `list_tickets`, `github.list-tickets` → `List tickets`, `Github list tickets` (when the server gives no name). */
export const humanize = (name: string) => {
  const words = name
    .replace(/[_.-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

export interface ToolDraft {
  name: string;
  description: string;
  label: string;
  access: ToolAccess;
  /** Off: never offered to agents. */
  on: boolean;
  /** Appeared after the last review. */
  isNew: boolean;
}

export function draftFrom(server: CustomServer): ToolDraft[] {
  return server.tools.map((t) => ({
    name: t.name,
    description: t.description,
    label: t.label || humanize(t.name),
    access: t.access && t.access !== "off" ? t.access : (t.suggestedAccess ?? defaultAccess(t)),
    on: t.access !== "off",
    isNew: t.access === null && server.reviewedAt !== null,
  }));
}

/** The `PUT …/tools` body: each tool's decision. */
export const decisionsOf = (drafts: ToolDraft[]): { name: string; access: ToolDecision; label: string }[] =>
  drafts.map((d) => ({ name: d.name, access: d.on ? d.access : "off", label: d.label }));

/** Tools waiting for a decision ("N ferramentas novas para revisar"). */
export const toolsToReview = (server: CustomServer) => server.tools.filter((t) => t.access === null).length;

/** What agents can see: tools of a reviewed server that are on. */
export const exposedTools = (server: CustomServer) =>
  server.reviewedAt ? server.tools.filter((t) => t.access !== null && t.access !== "off") : [];

export const isHttpsUrl = (v: string) => /^https:\/\/[^\s/]+/.test(v.trim());

/** Same MCP address, ignoring a trailing slash and case. */
export const sameServer = (a: string | null | undefined, b: string | null | undefined) =>
  Boolean(a && b) && (a ?? "").replace(/\/+$/, "").toLowerCase() === (b ?? "").replace(/\/+$/, "").toLowerCase();

/**
 * Whether a listed server is the one at `url`. Who can't manage connectors is told only a server's origin, so a
 * listed address with no path or query also stands for any address on that host.
 */
export const serverCovers = (listed: string | null | undefined, url: string | null | undefined) => {
  if (sameServer(listed, url)) return true;
  const origin = (listed ?? "").replace(/\/+$/, "").toLowerCase();
  if (!/^https:\/\/[^\s/?#]+$/.test(origin)) return false;
  const rest = (url ?? "").trim().toLowerCase();
  return rest.startsWith(origin) && /^[/?#]/.test(rest.slice(origin.length));
};

/**
 * A server by address's own instructions under its tools (web and phone, ADR 0016 addendum of 2026-11-22): nothing for
 * an older server that doesn't say; one line when it sends none; else the setting (its ⓘ, its status: the size as
 * agents read it, cut at the limit, or off) and the text, faded while agents don't get it.
 */
export type InstructionsView =
  | { kind: "hidden" }
  | { kind: "none"; title: string; status: string }
  | { kind: "shown"; title: string; hint: string; status: string; text: string; faded: boolean };

export function instructionsView(
  t: TFunction,
  locale: string,
  server: Pick<CustomServer, "instructions" | "via">,
  on: boolean,
): InstructionsView {
  const said = server.instructions;
  // A service through Composio has no `initialize`: nothing to show there either.
  if (said === undefined || server.via === "composio") return { kind: "hidden" };
  const title = t("toolReview.instructions.title");
  if (!said) return { kind: "none", title, status: t("toolReview.instructions.none") };
  const max = formatInt(locale, said.maxChars);
  const status = !on
    ? t("toolReview.instructions.off")
    : said.cut
      ? t("toolReview.instructions.cut", { max })
      : t("toolReview.instructions.chars", { used: formatInt(locale, said.text.length), max });
  return { kind: "shown", title, hint: t("toolReview.instructions.hint"), status, text: said.text, faded: !on };
}

/**
 * What the review's save says of the instructions: whether agents get them, only when the person moved the switch
 * (`startedOn`: where it was), so a save that didn't never undoes what another device set meanwhile.
 */
export const instructionsSave = (server: Pick<CustomServer, "instructions">, on: boolean, startedOn: boolean) =>
  server.instructions && on !== startedOn ? { useInstructions: on } : {};
