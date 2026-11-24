import {
  commandOf,
  commandWords,
  errorLineOf,
  KEY_SHAPES,
  maskValuesAfter,
  normalizedCommand,
  PERMISSION_TOOL,
  PRIVATE_KEY,
  redactCommon,
  SIGNED_SHAPES,
} from "@agenteschat/adapters";
import { and, type Database, eq, isNull, schema } from "@agenteschat/db";
import { clipText } from "@agenteschat/ui/widgets/spec";

const MAX = 80;

function short(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > MAX ? `${t.slice(0, MAX - 1)}…` : t;
}

/** "https://shop.example/checkout?token=…" → "shop.example/checkout". */
function siteOf(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const m = /^https?:\/\/([^/?#\s]+)([^?#\s]*)/i.exec(v.trim());
  if (!m) return undefined;
  const host = (m[1] ?? "").replace(/^[^@]*@/, "").toLowerCase();
  const path = (m[2] ?? "").replace(/\/$/, "");
  return short(`${host}${path}`);
}

function issueRef(v: unknown) {
  const t = short(v);
  if (!t) return undefined;
  const n = /^#?(\d+)$/.exec(t);
  return n ? `#${n[1]}` : t;
}

/** What a permission check (`permission_prompt`) asks about; null when the runner asks again (`request_id` only). */
function promptAsked(i: Record<string, unknown>): { tool: string; input: Record<string, unknown> } | null {
  const inner = i.input;
  if (typeof i.tool_name !== "string" || !i.tool_name) return null;
  if (!inner || typeof inner !== "object" || Array.isArray(inner)) return null;
  return { tool: i.tool_name, input: inner as Record<string, unknown> };
}

/** The runner asking again about a command waiting on a person: no step of its own, its answer is the first ask's. */
export const promptPoll = (name: string, input: Record<string, unknown> | undefined) =>
  name === PERMISSION_TOOL && typeof input?.request_id === "string";

/** The runner telling of a call its own command policy refused (`refused`): recorded, never asked, held or judged. */
export const promptRefused = (name: string, input: Record<string, unknown> | undefined) =>
  name === PERMISSION_TOOL && typeof input?.refused === "object" && input.refused !== null;

/**
 * `permission_prompt`'s answer: `{behavior}` when decided (a `deny` says why: `message` to the agent, `code` for
 * the apps), `{status: "pending", request_id}` while a person decides.
 */
export function promptAnswer(content: string): {
  behavior?: string;
  message?: string;
  code?: string;
  status?: string;
  request_id?: string;
} {
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Parts of a command line that only set up the next one (`cd repo && npm test`). */
const SETUP = new Set(["cd", "pushd", "popd", "export", "source", ".", "set", "unset"]);
/** Where a command's own words end: an option or a redirection. */
const OPTION = /^-|[<>]/;
/** A path or a web address: the only word after an option that can be a command's main argument. */
const PLACE = /^(?:\.{0,2}\/|~\/|[a-z][a-z0-9+.-]*:\/\/)/i;

/**
 * A command line, credentials already masked, in a few words: its first program (past `cd` and the like, wrappers
 * and env assignments left out) and its main argument, the words before its first option ("npm run build", "git
 * commit"), else its first path or web address ("rm /etc/x", "curl api.example.com/v1"). Never another word after
 * an option, which could be that option's value; a web address keeps its site and path only.
 */
function commandGist(masked: string): string | undefined {
  for (const argv of commandWords(masked)) {
    const start = argv.findIndex((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    if (start < 0) continue;
    const [program = "", ...rest] = normalizedCommand(argv.slice(start)).split(" ");
    if (!program || SETUP.has(program)) continue;
    const options = rest.findIndex((w) => OPTION.test(w));
    const lead = rest.slice(0, Math.min(options < 0 ? rest.length : options, 2));
    const args = lead.length > 0 ? lead : rest.filter((w) => PLACE.test(w)).slice(0, 1);
    return [program, ...args].map((w) => siteOf(w) ?? w).join(" ");
  }
  return undefined;
}

/** A permission check's label: Claude Code's own one-line description of the command, else the command in a few words. */
function promptLabel(i: Record<string, unknown>): string | undefined {
  const asked = promptAsked(i);
  if (!asked) return undefined;
  const said = typeof asked.input.description === "string" ? short(redactCredentials(asked.input.description)) : "";
  return said || short(commandGist(redactCredentials(commandOf(asked.tool, asked.input))));
}

/** The whole command a permission check (`permission_prompt`) is about, as one line, credentials masked. */
export function toolCommand(name: string, input: Record<string, unknown> | undefined): string | undefined {
  const asked = name === PERMISSION_TOOL ? promptAsked(input ?? {}) : null;
  return asked ? redactCredentials(commandOf(asked.tool, asked.input)) || undefined : undefined;
}

/**
 * A short, safe label for the `agent.tool` event ("lendo a skill relatorio",
 * "issue #131"). Only these fields of built-in tools are ever shown: never
 * other inputs, and nothing from connector (MCP) tools.
 */
export function toolDetail(name: string, input: Record<string, unknown> | undefined): string | undefined {
  const i = input ?? {};
  switch (name) {
    case "load_skill":
    case "browser_profile":
      return short(i.name);
    case "read_skill_file": {
      const skill = short(i.name);
      const path = typeof i.path === "string" ? i.path : "";
      return skill ? short(path ? `${skill}/${path}` : skill) : undefined;
    }
    case "create_issue":
      return short(i.title);
    case "update_issue":
    case "comment_issue":
      return issueRef(i.issue);
    case "create_artifact":
    case "create_spreadsheet":
    case "create_presentation":
    case "create_canvas":
      return short(i.title);
    case "update_artifact":
      return short(i.title);
    case "run_code":
      return short(i.language);
    case "write_file":
    case "read_file":
    case "review_media":
    case "list_files":
    case "export_file":
    case "upload_file":
      return short(i.path);
    case "run_skill_script": {
      const skill = short(i.skill);
      return skill ? short(typeof i.path === "string" ? `${skill}/${i.path}` : skill) : undefined;
    }
    // The agent browser (ADR 0040): the site it opens, never the query string (it can carry tokens).
    case "browser_open":
    case "browser_tabs":
      return siteOf(i.url);
    case PERMISSION_TOOL:
      return promptLabel(i);
    default:
      return undefined;
  }
}

/** The input naming the file each Drive tool works on: `artifact_id`, a live file's `file` (ADR 0196), a canvas. */
const FILE_FIELD: Readonly<Record<string, string>> = {
  read_artifact: "artifact_id",
  update_artifact: "artifact_id",
  share_artifact: "artifact_id",
  import_file: "artifact_id",
  read_spreadsheet: "file",
  edit_spreadsheet: "file",
  read_presentation: "file",
  edit_presentation: "file",
  read_canvas: "file",
  edit_canvas: "file",
  read_document: "file",
  edit_document: "file",
  generate_image: "canvas",
};

/** Drive tools by id: the file's title, only when it belongs to this same channel (so no title leaks elsewhere). */
export async function artifactToolDetail(
  db: Database,
  orgId: string,
  channelId: string,
  name: string,
  input: Record<string, unknown> | undefined,
): Promise<string | undefined> {
  const field = Object.hasOwn(FILE_FIELD, name) ? FILE_FIELD[name] : undefined;
  if (!field) return undefined;
  const id = input?.[field];
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  const [a] = await db
    .select({ title: schema.artifacts.title, channelId: schema.artifacts.channelId })
    .from(schema.artifacts)
    .where(and(eq(schema.artifacts.id, id), eq(schema.artifacts.orgId, orgId), isNull(schema.artifacts.deletedAt)));
  return a && a.channelId === channelId ? short(a.title) : undefined;
}

/** Things that look like credentials, masked in previews and live output (agents should never have any). */
const SECRET = new RegExp(`${KEY_SHAPES.source}|${SIGNED_SHAPES.source}`, "g");

export const maskSecrets = (text: string) => text.replace(SECRET, "••••");

/** `text` with each of `values` masked wherever it appears, the longest first: secrets known by value, of any shape. */
export const maskValues = (text: string, values: readonly string[]) =>
  values
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .reduce((masked, value) => masked.replaceAll(value, "••••"), text);

/**
 * Whether a value carries a credential by its format (an API key, a token, a private key): what a run
 * nobody is behind never sends anywhere (ADR 0053 §3).
 */
export function carriesCredential(value: unknown): boolean {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  return PRIVATE_KEY.test(text) || text.replace(SECRET, "") !== text;
}

/**
 * A private key's block (PGP's too), from its first line to its last or the text's end, its first line's words also
 * wrapped over lines.
 */
const PRIVATE_KEY_BLOCK =
  /-----BEGIN[A-Z0-9\s]*?\sPRIVATE\s+KEY(?:\s+BLOCK)?-----[\s\S]*?(?:-----END[A-Z0-9\s]*?\sPRIVATE\s+KEY(?:\s+BLOCK)?-----|$)/g;
/** Once the blocks are replaced, the end of one whose start was in an earlier text (a message, a page of a file). */
const KEY_END_ALONE = /^[\s\S]*?-----END[A-Z0-9\s]*?\sPRIVATE\s+KEY(?:\s+BLOCK)?-----/;
/** `text` with each private key, whole or its end alone, replaced by `by`. The end is looked for only where there is one. */
function replaceKeys(text: string, by: (found: string) => string) {
  const blocks = text.replace(PRIVATE_KEY_BLOCK, by);
  return blocks.includes("-----END") ? blocks.replace(KEY_END_ALONE, by) : blocks;
}

/** `maskSecrets`, private keys too (from their first line on): text people read that must hold none. */
export const maskCredentials = (text: string) => replaceKeys(maskSecrets(text), () => "••••");

/** `maskCredentials`, except a credential that appears word for word in `pasted` (what people wrote themselves). */
export const maskCredentialsExcept = (text: string, pasted: string) => {
  const keep = (found: string) => (pasted.includes(found) ? found : "••••");
  return replaceKeys(text.replace(SECRET, keep), keep);
};

/**
 * What a CLI's sign-in holds beyond `SECRET`'s shapes (OpenAI and Anthropic keys and OAuth tokens, JWTs): Cursor keys
 * (`key_…`, `crsr_…`), xAI keys (`xai-…`), OpenAI refresh tokens (`rt.…`, `rt_…`), Google's OAuth access tokens
 * (`ya29.…`), refresh tokens (`1//…`), API keys (`AIza…`) and OAuth client secrets (`GOCSPX-…`), and every value of a
 * sign-in file's fields (Codex's `auth.json`, Claude Code's `.credentials.json`, Cursor's, OpenCode's, Grok Build's and
 * the Antigravity CLI's): `"refresh_token": "…"`, `accessToken: …`, `OPENAI_API_KEY=…`.
 */
// Codex 0.165's `auth.json` refresh token starts `rt.` (seen on a real sign-in, 2026-11-04), older ones `rt_`.
const SIGN_IN_SHAPES =
  /\b(?:key|crsr)_[A-Za-z0-9]{32,}|\bxai-[A-Za-z0-9]{20,}|\brt[._][A-Za-z0-9._-]{19,}[A-Za-z0-9_-]|\bya29\.[A-Za-z0-9_-]{20,}|(?<![\w/])1\/\/[0-9][A-Za-z0-9_-]{20,}|\bAIza[0-9A-Za-z_-]{35}|\bGOCSPX-[A-Za-z0-9_-]{20,}/g;
const SIGN_IN_FIELD =
  /(["']?\b(?:access_?token|refresh_?token|id_?token|oauth_?token|api_?key|\w*_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)["']?\s*[:=]\s*)("[^"\s]{8,}"|'[^'\s]{8,}'|[^\s"',}]{8,})/gi;

/** The team's right hand's reply (ADR 0137 §4): every credential and sign-in in it replaced by `note`, and how many. */
export function scrubSignIns(text: string, note: string): { text: string; found: number } {
  let found = 0;
  const hit = () => {
    found++;
    return note;
  };
  const out = replaceKeys(
    text
      // A value already scrubbed stays as it is, so scrubbing twice changes nothing: only when what matched is the
      // note's own start and nothing more (the note in front of a real value hides nothing).
      .replace(SIGN_IN_FIELD, (match, field: string, value: string, at: number, all: string) =>
        note.startsWith(value) && all.startsWith(note, at + field.length) ? match : `${field}${hit()}`,
      ),
    hit,
  )
    .replace(SECRET, hit)
    .replace(SIGN_IN_SHAPES, hit);
  return { text: out, found };
}

/**
 * An address's user and a password that holds `/` or `@` (`postgres://app:pa/ss@host`): up to the first `@` with no
 * other in the host after it. Looked for before `USERINFO`, which would stop at the password's first such character.
 * The password is 256 characters at most and holds no `:` (the next address's `://`), so each `://` costs little.
 */
const USERINFO_PASSWORD = /:\/\/(?<=\b[a-z][a-z0-9+.-]*:\/\/)[^\s/?#@'":]+:[^\s'":]{0,256}?@(?![^\s'"/?#]*@)/gi;
/**
 * An address's user and password (`postgres://user:pass@host`), found from its `://` with its scheme checked behind
 * it. Looked for from each letter a scheme could start at, one long word of dots or dashes costs the square of its
 * length.
 */
const USERINFO = /:\/\/(?<=\b[a-z][a-z0-9+.-]*:\/\/)[^\s/?#@'"]+@/gi;
/** In a list of arguments kept as text, what stands between one and the next (`","`), up to the next one's quote. */
const NEXT_ARGUMENT = String.raw`\\*["']\s*,\s*`;
/**
 * The value after an option named for a secret (`--password hunter2`, `--api-key k`), a quoted one whole, also where
 * its quotes are written with backslashes: the option may open a quoted command (`sh -c "--token …"`), and a command
 * kept in JSON has its quotes written so. In a list of arguments kept as text, the value is the next one
 * (`"--password","…"`). Never a number after a name in the plural, which sets a count (`--max-tokens 4096`), also
 * with what closes or ends its command right after it (`$(llm --max-tokens 4096)`, `--max-tokens 4096; echo`).
 *
 * The first lookahead lets an option through only where a value follows its name. Without it, in one long word after
 * `--` every `token` is tried as the name's last and the rest of the word read again: the square of its length.
 */
const SECRET_OPTION = new RegExp(
  String.raw`(?<![^\s"'])(?=--?[\w-]+(?:\s+[^\s-]|${NEXT_ARGUMENT}\\*["'][^-]))--?(?![\w-]*s(?:\s+|${NEXT_ARGUMENT}\\*["'])\d+[)\]};|&<>,.]*(?![^\s"'\\]))[\w-]*(?:password|passwd|secret|token|api[_-]?key)[\w-]*(?:\s+|${NEXT_ARGUMENT}(?=\\*["']))(?=[^\s-])`,
  "gi",
);

/**
 * Keys of cloud providers and services that `SECRET` leaves: AWS's temporary and other key ids, Google's API keys,
 * OAuth tokens and client secrets, Stripe's secret and restricted keys and webhook secrets, GitLab's, npm's, Hugging
 * Face's, DigitalOcean's and SendGrid's tokens, and a JWT with no signature.
 */
const SERVICE_KEYS =
  /\b(?:A(?:SIA|BIA|CCA)[0-9A-Z]{16}\b|AIza[0-9A-Za-z_-]{35}|ya29\.[A-Za-z0-9_-]{20,}|GOCSPX-[A-Za-z0-9_-]{20,}|[rs]k_(?:live|test)_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9+/=]{24,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{36}|hf_[A-Za-z0-9]{30,}|do[opr]_v1_[a-f0-9]{64}|SG\.[\w-]{22}\.[\w-]{43}|eyJ[\w-]{10,}\.eyJ[\w-]{10,}\.)/g;
/** The value after a credential's name that `redactCommon` reads as no such name: AWS's secret key, Azure's account key, a connection string's `Pwd`. */
const SECRET_NAMED =
  /\b(?:(?:(?:aws[_-]?)?secret[_-]?access[_-]?key|account[_-]?key|private[_-]?key)["']?\s*[=:]|pwd\s*=)\s*/gi;
/**
 * An `Authorization` or `Cookie` header's value whole after its scheme's word, whatever the scheme (`Digest ***`,
 * `AWS4-HMAC-SHA256 ***`, a bare token): inside a quoted text up to its closing quote, else to the line's end, also a
 * line end JSON writes (`\n`).
 */
const HEADER_VALUE =
  /(?:(["'])((?:proxy-)?authorization|(?:set-)?cookie)(\s*:[^\S\r\n]*(?:[A-Za-z][\w-]{0,19}[^\S\r\n]+)?)[^\r\n]+?(?=\\*\1)|(?<!["'\w-])((?:proxy-)?authorization|(?:set-)?cookie)(\s*:[^\S\r\n]*(?:[A-Za-z][\w-]{0,19}[^\S\r\n]+)?)[^\r\n]+?(?=\\[nr]|[\r\n]|$))/gi;

/**
 * `maskCredentials`, an address's user and password (`postgres://***@host`, first: `redactCommon` would read a
 * `token:` there as a value to mask up to the next space), the shapes `redactCommon` knows (bearer headers,
 * `token=` values), service keys, an `Authorization` or `Cookie` header's value and the value after a secret-named
 * option (`--password ***`): text that leaves its place.
 */
export const redactCredentials = (text: string) =>
  maskValuesAfter(
    maskValuesAfter(
      redactCommon(
        maskCredentials(text)
          .replace(USERINFO_PASSWORD, "://***@")
          .replace(USERINFO, "://***@")
          .replace(SERVICE_KEYS, "••••"),
      ).replace(HEADER_VALUE, (_, quote, name, is, bare, bareIs) =>
        quote ? `${quote}${name}${is}***` : `${bare}${bareIs}***`,
      ),
      SECRET_NAMED,
    ),
    SECRET_OPTION,
  );

/** An absolute path two parts deep or more (`/home/ada/x.jsonl`, `~/x/y`, `C:\Users\x`), never a URL's. */
const ABSOLUTE_PATH = /(?<![\w:/.~\\-])(?:~|[A-Za-z]:)?(?:[\\/][^\s\\/:"'()<>,;]+){2,}[\\/]?/g;

/**
 * What a command-line tool said when it failed, as anyone in the conversation may read it: a provider's JSON answer's
 * own `message`, else its last line that names an error, else its last line. No stack frames, credentials and sign-ins
 * masked, absolute paths cut to their last part (they name people's folders), one line of at most 200 characters (cut
 * at a word, with "…").
 */
export function cliErrorWords(text: string): string {
  let said = "";
  const json = text.indexOf("{");
  if (json >= 0) {
    try {
      const o = JSON.parse(text.slice(json, text.lastIndexOf("}") + 1)) as {
        error?: { message?: unknown };
        message?: unknown;
      };
      const message = o.error?.message ?? o.message;
      if (typeof message === "string") said = message;
    } catch {
      // Not JSON: its lines say it.
    }
  }
  if (!said) said = errorLineOf(text);
  const safe = scrubSignIns(redactCredentials(said.replace(/file:\/\//g, "")), "••••").text;
  const short = safe
    .replace(ABSOLUTE_PATH, (path) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? "")
    .replace(/^(?:Uncaught )?error:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return clipText(short, 200);
}

export const PREVIEW_CODE_CHARS = 4096;

/** `run_code`'s code for the activity bar (≤ 4 KB, secrets masked). File tools show their path in `detail`. */
export function toolCode(
  name: string,
  input: Record<string, unknown> | undefined,
): { language: string; source: string } | undefined {
  if (name !== "run_code") return undefined;
  const i = input ?? {};
  const code = maskSecrets(typeof i.code === "string" ? i.code : "");
  return {
    language: typeof i.language === "string" ? i.language : "",
    source: code.length > PREVIEW_CODE_CHARS ? `${code.slice(0, PREVIEW_CODE_CHARS)}\n…` : code,
  };
}
