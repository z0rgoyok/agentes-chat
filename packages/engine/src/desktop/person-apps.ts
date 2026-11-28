import {
  APPS_LIMITS,
  type AppsCommand,
  type AppsRunReply,
  PERSON_APPS_PROTOCOL,
  permissionWaitText,
} from "@agenteschat/adapters";
import type { Database } from "@agenteschat/db";
import { getAgentCached } from "../agents";
import { MAX_PAGE_TEXT } from "../browser/tools";
import { DESKTOP_SCOPE } from "../browser/types";
import { callWhenBack, type MachineCaller, MachineRequestError } from "../machine-hub";
import { REMOVED_COMPUTER_MESSAGE } from "../machines";
import { machineScope, toolMachineId } from "../right-hand-seats";
import { codeRunning, RUN_CODE_TOOL, SandboxUnavailableError } from "../sandbox";
import type { JsonSchema } from "../tools/json-schema";
import { accessWithNeeds, grantedScopeKeys, isAllowed } from "../tools/scopes";
import type { ToolContext, ToolDefinition, ToolOutput, ToolSource } from "../tools/types";
import { untrustedBlock } from "../untrusted";

/**
 * The person's own apps on their connected computer (ADR 0258): `apps_list`, `apps_read` and `apps_act`, through
 * the runner's `apps.run` and the pinned `agent-desktop`. On by default for every agent that may use that computer
 * and run code (driving apps reaches what commands reach). The agent reads an app's accessibility tree, acts on an
 * element by its ref, and reads again; the person's pointer and keyboard are never taken. An action that sends,
 * pays, publishes or deletes asks a person exactly as the agent's approvals level says.
 */

export const APPS_TOOLS = ["apps_list", "apps_read", "apps_act"] as const;

/** The longest one command may take on the computer: `launch` waits for the app, and the first one downloads the CLI. */
const RUN_MS = 120_000;
/** Refs remembered with what they name, for whether acting on one asks a person. */
const REFS_KEPT = 5000;

/** What `apps_act` does, and the `agent-desktop` command it is. */
const ACTIONS = {
  click: "click",
  double_click: "double-click",
  right_click: "right-click",
  type: "type",
  fill: "set-value",
  clear: "clear",
  focus: "focus",
  select: "select",
  toggle: "toggle",
  check: "check",
  uncheck: "uncheck",
  expand: "expand",
  collapse: "collapse",
  scroll: "scroll",
  scroll_to: "scroll-to",
  press: "press",
  open: "launch",
  quit: "close-app",
} as const satisfies Record<string, AppsCommand>;
type AppsAction = keyof typeof ACTIONS;
const isAction = (v: unknown): v is AppsAction => typeof v === "string" && Object.hasOwn(ACTIONS, v);

/** Actions that can send, pay, publish or delete, by the element they land on. Typing and opening can't. */
const MAY_COST: ReadonlySet<AppsAction> = new Set(["click", "double_click", "toggle", "check", "uncheck", "select"]);

/**
 * An element whose name sends, pays, publishes or deletes, in the languages the apps speak.
 * ponytail: words, not the judge's costly question (no model call per click); a plain "OK" that confirms a delete
 * isn't caught. Upgrade to the judge with the dialog's text when that shows up.
 */
const LATIN_COSTLY = [
  "send|pay|buy|purchase|checkout|check out|place order|publish|post|tweet|delete|remove|erase|trash|discard|submit",
  "transfer|confirm|approve|merge|deploy|uninstall|format",
  "enviar|pagar|comprar|publicar|postar|excluir|apagar|eliminar|borrar|remover|confirmar|aprovar|aprobar|transferir",
  "envoyer|payer|acheter|publier|supprimer|effacer|confirmer|approuver",
  "senden|absenden|bezahlen|zahlen|kaufen|veröffentlichen|löschen|entfernen|bestätigen|genehmigen|überweisen",
  "invia|paga|acquista|compra|pubblica|elimina|cancella|conferma|approva",
  "verzenden|versturen|betalen|kopen|publiceren|verwijderen|bevestigen|goedkeuren",
  "kirim|bayar|beli|terbitkan|hapus|konfirmasi|setujui",
  "gönder|öde|satın al|yayınla|sil|onayla",
  "wyślij|zapłać|kup|opublikuj|usuń|potwierdź|zatwierdź",
  "отправить|оплатить|купить|опубликовать|удалить|подтвердить|одобрить",
];
const CJK_COSTLY =
  "送信|支払|購入|公開|投稿|削除|承認|보내기|전송|결제|구매|게시|삭제|승인|发送|付款|支付|购买|发布|删除|批准";
const COSTLY_WORDS = new RegExp(`(?:^|[^\\p{L}])(?:${LATIN_COSTLY.join("|")})(?![\\p{L}])|${CJK_COSTLY}`, "iu");
/**
 * A press that can send or delete: Enter (a message field's), Delete, and any shortcut with a modifier other than Shift
 * (Mail sends on cmd+shift+d, Finder trashes on cmd+delete, cmd+v pastes the person's clipboard). Plain keys (Tab,
 * Escape, arrows, letters) don't.
 */
const SENDING_KEY =
  /(^|\+)(enter|return|delete|backspace|del|forwarddelete)$|(^|\+)(meta|cmd|command|super|win|ctrl|control|alt|option)\+/i;

export const costlyElement = (name: string) => COSTLY_WORDS.test(name);

export type PersonAppsStatus =
  | { available: true; machineId: string; machineName: string }
  | { available: false; text: string };

/**
 * Whether the agent may use the person's apps on its computer: a connected computer on `PERSON_APPS_PROTOCOL`
 * whose runner can serve them (`hello.apps`). No switch of its own: a computer that is connected serves them.
 */
export async function agentPersonAppsStatus(
  db: Database,
  hub: Pick<MachineCaller, "status"> | undefined,
  orgId: string,
  agentId: string,
): Promise<PersonAppsStatus> {
  const no = (text: string) => ({ available: false as const, text });
  const agent = await getAgentCached(db, orgId, agentId);
  const machineId = await toolMachineId(db, agent);
  if (!machineId || !hub) return no("Using apps needs a connected computer, and you don't use one.");
  const status = await hub.status(machineId);
  if (!status || status.orgId !== orgId) return no(REMOVED_COMPUTER_MESSAGE);
  if (status.protocol < PERSON_APPS_PROTOCOL) {
    return no(
      `The agentes.chat program on ${status.name} is too old for using its apps. Tell the person: its owner should update it.`,
    );
  }
  const info = status.executors.apps;
  if (!info?.available) {
    return no(`The apps on ${status.name} can't be used${info?.reason ? `: ${info.reason}` : ""}.`);
  }
  return { available: true, machineId, machineName: status.name };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const str = (v: unknown) => (typeof v === "string" ? v : "");
const oneLine = (v: unknown, max = 200) => str(v).replace(/\s+/g, " ").trim().slice(0, max);

interface Element {
  role: string;
  name: string;
}

/** One element as a line: `button "Send" [@s1:e3]`, with its value and states. */
function elementLine(n: Record<string, unknown>, depth: number): string {
  const name = oneLine(n.name);
  const value = oneLine(n.value);
  const states = Array.isArray(n.states) ? n.states.filter((s) => typeof s === "string").slice(0, 6) : [];
  const ref = str(n.ref_id);
  return `${"  ".repeat(Math.min(depth, 20))}${oneLine(n.role, 40) || "element"}${name ? ` "${name}"` : ""}${
    value ? ` = "${value}"` : ""
  }${states.length ? ` (${states.join(", ")})` : ""}${ref ? ` [${ref}]` : ""}`;
}

/** A snapshot's tree, or a find's matches, as screen text, and the refs in it. */
export function appsText(data: unknown): { text: string; refs: Map<string, Element>; complete: boolean } {
  const refs = new Map<string, Element>();
  const lines: string[] = [];
  let size = 0;
  const add = (n: Record<string, unknown>, depth: number) => {
    if (size > MAX_PAGE_TEXT) return;
    const line = elementLine(n, depth);
    lines.push(line);
    size += line.length + 1;
    const ref = str(n.ref_id);
    if (ref) refs.set(ref, { role: str(n.role), name: str(n.name) });
  };
  const d = isRecord(data) ? data : {};
  const walk = (n: unknown, depth: number) => {
    if (!isRecord(n)) return;
    add(n, depth);
    if (Array.isArray(n.children)) for (const c of n.children) walk(c, depth + 1);
  };
  if (isRecord(d.tree)) walk(d.tree, 0);
  const matches = Array.isArray(d.matches) ? d.matches : isRecord(d.match) ? [d.match] : [];
  for (const m of matches) if (isRecord(m)) add(m, 0);
  const cut = size > MAX_PAGE_TEXT;
  return { text: lines.join("\n"), refs, complete: d.complete !== false && !cut };
}

/** Screen text is untrusted: any app or page can put words in its windows. */
const screenBlock = (text: string) => untrustedBlock("app screen", text, MAX_PAGE_TEXT);

/** What the agent reads when `agent-desktop` said no. */
function failureText(error: Extract<AppsRunReply, { ok: false }>["error"], machineName: string): string {
  switch (error.code) {
    case "PERM_DENIED":
      return permissionWaitText(machineName, "accessibility");
    case "STALE_REF":
    case "SNAPSHOT_NOT_FOUND":
    case "AMBIGUOUS_TARGET":
      return `${error.message}. The app changed since you read it: read it again (apps_read) and use the new refs.`;
    case "POLICY_DENIED":
      return `${error.message}. That needs the person's own mouse or keyboard, which agents never take: try another element or way (a menu item, a button), or ask the person.`;
    case "APP_NOT_FOUND":
      return `${error.message}. See what is open with apps_list, or open it (apps_act \`open\`).`;
    default:
      return error.retry === "safe"
        ? error.message
        : `${error.message}. It may have happened anyway: read the app again (apps_read) before doing it again.`;
  }
}

/** Runner refusals → the agent's words. */
function explain(error: unknown, machineName: string): string {
  if (error instanceof MachineRequestError && error.code === "paused") {
    return `The owner paused the computer ${machineName}: nothing new can start there until they resume it. Tell the people.`;
  }
  return error instanceof Error ? error.message : String(error);
}

export interface PersonAppsToolDeps {
  machines?: { hub: MachineCaller };
}

const ACT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    do: { type: "string", enum: Object.keys(ACTIONS) },
    ref: {
      type: "string",
      description: "The element, as its ref from apps_read (`@s8f3k2p9:e8`). Every action but press, open and quit.",
      maxLength: 60,
    },
    text: {
      type: "string",
      description: "`type`: text typed where the element's cursor is. `fill`: the field's whole new text.",
      maxLength: APPS_LIMITS.text,
    },
    value: { type: "string", description: "`select`: the option's visible text.", maxLength: 300 },
    key: {
      type: "string",
      description: "`press`: keys joined by + (`cmd+s`, `ctrl+f`, `escape`, `tab`), sent to `app`.",
      maxLength: 40,
    },
    app: {
      type: "string",
      description: "`press`, `open` and `quit`: the app by its name as apps_list says it (`Mail`, `TextEdit`).",
      maxLength: 200,
    },
    direction: { type: "string", enum: ["up", "down", "left", "right"] },
    amount: { type: "integer", minimum: 1, maximum: 50, description: "`scroll`: how far (default 3)." },
  },
  required: ["do"],
  additionalProperties: false,
};

/** `apps_act`'s input as `agent-desktop`'s arguments, or what is missing. */
export function actArgs(
  input: Record<string, unknown>,
): { command: AppsCommand; args: string[]; text?: string } | string {
  const act = input.do;
  if (!isAction(act)) return "Give `do`.";
  const command = ACTIONS[act];
  const ref = str(input.ref).trim();
  const app = str(input.app).trim();
  if (act === "press") {
    const key = str(input.key).trim();
    if (!key || !app) return "`press` needs `key` and `app`.";
    return { command, args: [key, "--app", app] };
  }
  if (act === "open" || act === "quit") return app ? { command, args: [app] } : `\`${act}\` needs \`app\`.`;
  if (!ref) return `\`${act}\` needs \`ref\`: read the app first (apps_read).`;
  if (act === "type" || act === "fill") {
    if (typeof input.text !== "string") return `\`${act}\` needs \`text\`.`;
    return { command, args: [ref], text: input.text };
  }
  if (act === "select") {
    const value = str(input.value);
    return value ? { command, args: [ref, value] } : "`select` needs `value`.";
  }
  if (act === "scroll") {
    const direction = str(input.direction) || "down";
    const amount = typeof input.amount === "number" ? input.amount : 3;
    return { command, args: [ref, "--direction", direction, "--amount", String(amount)] };
  }
  return { command, args: [ref] };
}

/** The app a ref came from, by the snapshot that gave it (`@<snapshot>:eN`). */
const snapshotOf = (ref: string) => /^@([a-z0-9]+):e\d+$/.exec(ref)?.[1] ?? null;

export function createPersonAppsToolSource(deps: PersonAppsToolDeps): ToolSource {
  const hub = deps.machines?.hub;
  /** Ref → what it names, for whether acting on it asks a person. */
  const refs = new Map<string, Element>();
  /** Snapshot → the app it read, so an action's answer can read that app again. */
  const snapshotApps = new Map<string, string>();
  const remember = (found: Map<string, Element>, app: string) => {
    for (const [ref, e] of found) {
      refs.delete(ref);
      refs.set(ref, e);
      const snap = snapshotOf(ref);
      if (snap) snapshotApps.set(snap, app);
    }
    while (refs.size > REFS_KEPT) refs.delete(refs.keys().next().value as string);
    while (snapshotApps.size > REFS_KEPT) snapshotApps.delete(snapshotApps.keys().next().value as string);
  };

  /** Whether `apps_act` with this input only does what can be undone (no card at the default level). */
  const asksNobody = (input: Record<string, unknown>) => {
    if (!isAction(input.do)) return true;
    if (input.do === "press") return !SENDING_KEY.test(str(input.key).replace(/\s+/g, ""));
    // A line break typed in a chat field is its Enter.
    if (input.do === "type") return !/[\r\n]/.test(str(input.text));
    if (!MAY_COST.has(input.do)) return true;
    const e = refs.get(str(input.ref).trim());
    // A ref this server never read (another replica, a restart): asked, to be sure.
    return e !== undefined && !costlyElement(e.name);
  };

  async function gate(ctx: ToolContext, granted?: Set<string>): Promise<{ refused: string } | { approvals: boolean }> {
    const running = await codeRunning(ctx.db, ctx.orgId, ctx.agentId, granted);
    if (running.refused !== null) {
      return {
        refused:
          running.refused === "grant"
            ? "Using apps on your computer can run anything there, and you may not run code. An admin or your owner can give you Run code; say so."
            : "Using apps on your computer can run anything there, and running code is turned off for this organization. Tell the people.",
      };
    }
    return { approvals: running.approvals };
  }

  /** Runs one command on the agent's computer, or says why it can't. */
  async function run(
    ctx: ToolContext,
    command: AppsCommand,
    args: string[],
    text?: string,
  ): Promise<{ reply: AppsRunReply; machineName: string } | { refused: string }> {
    const g = await gate(ctx);
    if ("refused" in g) return { refused: g.refused };
    if (!hub) return { refused: "Connected computers are not available on this server." };
    const status = await agentPersonAppsStatus(ctx.db, hub, ctx.orgId, ctx.agentId);
    if (!status.available) return { refused: status.text };
    const caller = hub;
    try {
      const agent = await machineScope(caller, ctx, status.machineId);
      const reply = await callWhenBack(
        caller,
        status.machineId,
        () =>
          caller.call<"apps.run">(
            status.machineId,
            { op: "apps.run", agent, command, args, ...(text !== undefined ? { text } : {}) },
            { signal: ctx.signal, timeoutMs: RUN_MS },
          ),
        ctx.signal,
      );
      return { reply, machineName: status.machineName };
    } catch (error) {
      if (error instanceof SandboxUnavailableError) return { refused: error.message };
      return { refused: explain(error, status.machineName) };
    }
  }

  /** An app read (`snapshot` or `find`) as the agent's screen text, its refs remembered. */
  async function read(ctx: ToolContext, app: string, args: string[], find: boolean): Promise<ToolOutput> {
    const done = await run(ctx, find ? "find" : "snapshot", ["--app", app, ...args]);
    if ("refused" in done) return { content: done.refused, isError: true };
    if (!done.reply.ok) return { content: failureText(done.reply.error, done.machineName), isError: true };
    const seen = appsText(done.reply.data);
    remember(seen.refs, app);
    if (!seen.text) {
      return {
        content: find
          ? `Nothing in ${app} matches. Read the whole app (apps_read without \`find\`) to look yourself.`
          : `${app} shows nothing you can act on now (no window, or it draws its own controls).`,
      };
    }
    const partial = seen.complete ? "" : "\nThis is only part of it: name a region with `root` to read inside it.";
    return { content: `${app} on ${done.machineName}:${partial}\n${screenBlock(seen.text)}` };
  }

  const tool = (
    name: (typeof APPS_TOOLS)[number],
    description: string,
    inputSchema: JsonSchema,
    execute: ToolDefinition["execute"],
    extra: Partial<ToolDefinition> = {},
  ): ToolDefinition => ({
    name,
    description,
    inputSchema,
    scope: DESKTOP_SCOPE,
    needs: RUN_CODE_TOOL,
    readsOutside: true,
    execute,
    ...extra,
  });

  const loop =
    "The loop: apps_read the app, act on one element by its ref with apps_act (its answer shows the app again), and check what changed before the next step.";

  const definitions: ToolDefinition[] = [
    tool(
      "apps_list",
      `Lists the apps open on the person's own computer (the one you use), by the names apps_read and apps_act take. ${loop}`,
      { type: "object", properties: {}, additionalProperties: false },
      async (_input, ctx) => {
        const done = await run(ctx, "list-apps", []);
        if ("refused" in done) return { content: done.refused, isError: true };
        if (!done.reply.ok) return { content: failureText(done.reply.error, done.machineName), isError: true };
        const data = isRecord(done.reply.data) ? done.reply.data : {};
        const names = (Array.isArray(data.apps) ? data.apps : [])
          .map((a) => (isRecord(a) ? oneLine(a.name, 100) : ""))
          .filter((n) => n && !/agentes/i.test(n));
        return {
          content: names.length
            ? `Open on ${done.machineName}:\n${screenBlock(names.join("\n"))}\nAn app that isn't open: apps_act \`open\`.`
            : `No apps are open on ${done.machineName}.`,
        };
      },
    ),
    tool(
      "apps_read",
      `Reads one app on the person's own computer as text: its window's buttons, fields, menus and lists, one per line, each element you can act on with its ref (\`[@s8f3k2p9:e8]\`). For apps with no API, connector or web version; web pages go to your own browser (browser_do). Give \`find\` to get only the elements that match some words, or \`root\` (a ref) to read inside one region of a big app. ${loop} Refs belong to their read: after the app changes, read it again.`,
      {
        type: "object",
        properties: {
          app: { type: "string", description: "The app, as apps_list names it.", maxLength: 200 },
          find: {
            type: "string",
            description: "Only the elements whose name, value or text has these words.",
            maxLength: 200,
          },
          root: { type: "string", description: "A ref of a region (a list, a pane) to read inside.", maxLength: 60 },
        },
        required: ["app"],
        additionalProperties: false,
      },
      async (input, ctx) => {
        const app = str(input.app).trim();
        if (!app) return { content: "Give `app`.", isError: true };
        const find = str(input.find).trim();
        if (find) return read(ctx, app, ["--text", find, "--limit", "40"], true);
        const root = str(input.root).trim();
        return read(ctx, app, ["-i", "--compact", ...(root ? ["--root", root] : [])], false);
      },
    ),
    tool(
      "apps_act",
      `Does one thing in an app on the person's own computer: clicks, types or fills a field, picks an option, ticks a box, scrolls, presses keys in an app, opens or quits an app. It works through the system's accessibility, never the person's mouse or keyboard, so they can keep working. Name the element by its ref from apps_read. ${loop} An action that may have happened isn't repeated blindly: read the app again first. Sending, paying, publishing or deleting asks a person first when your approvals say so.`,
      ACT_SCHEMA,
      async (input, ctx) => {
        const shaped = actArgs(input);
        if (typeof shaped === "string") return { content: shaped, isError: true };
        const done = await run(ctx, shaped.command, shaped.args, shaped.text);
        if ("refused" in done) return { content: done.refused, isError: true };
        if (!done.reply.ok) return { content: failureText(done.reply.error, done.machineName), isError: true };
        const snap = snapshotOf(str(input.ref).trim());
        const app = (snap && snapshotApps.get(snap)) || str(input.app).trim();
        const did = `Done: ${input.do}${app ? ` in ${app}` : ""}. Nothing proves it worked until you see it.`;
        if (!app || input.do === "quit") return { content: did };
        const after = await read(ctx, app, ["-i", "--compact"], false);
        return { content: `${did}\nThe app now:\n${after.content}` };
      },
      { sensitive: true, asksNobody },
    ),
  ];

  return {
    name: "apps",
    async tools(ctx) {
      if (!hub) return [];
      const granted = await grantedScopeKeys(ctx.db, ctx.orgId, ctx.agentId);
      if (!definitions.some((t) => isAllowed(accessWithNeeds(granted, t).state))) return definitions;
      const g = await gate(ctx, granted);
      if ("refused" in g) return [];
      if (!(await agentPersonAppsStatus(ctx.db, hub, ctx.orgId, ctx.agentId)).available) return [];
      // Where every command asks a person first, so does every action in an app.
      return g.approvals
        ? definitions.map((t) => (t.name === "apps_act" ? { ...t, asksNobody: undefined } : t))
        : definitions;
    },
  };
}
