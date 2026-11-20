import type { Breadcrumb, Event } from "@sentry/core";
import { redactCommon } from "./redact";

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const JWT = /\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]*/g;
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
/** What may be an IPv6 address (`isIPv6` decides), compressed (`2001:db8::1`) and with a zone (`fe80::1%en0`). */
const IPV6 = /(?<![\w:.])((?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4})(%[\w.-]+)?(?![\w:])/gi;
/** 32 URL-safe characters or more: a key, a session or a hash. A UUID is an internal id and stays. */
const TOKEN = /(^|[^\w-])([\w-]{32,})/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The end of a failed query's message (Drizzle's `Failed query: <sql>\nparams: <values>`): every value it was given. */
const QUERY_PARAMS = /\nparams: [\s\S]*$/;

/** By the URL parser: the web app scrubs its reports with this file too, and a browser has no `node:net`. */
function isIPv6(address: string) {
  try {
    new URL(`http://[${address}]`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Free text (an exception's message, a breadcrumb) with a failed query's values cut, and emails, addresses and
 * anything like a credential masked.
 */
export function scrubText(text: string): string {
  return redactCommon(text.replace(QUERY_PARAMS, "\nparams: [removed]"))
    .replace(JWT, "[jwt]")
    .replace(EMAIL, "[email]")
    .replace(IPV4, "[ip]")
    .replace(IPV6, (match, address: string) => (isIPv6(address) ? "[ip]" : match))
    .replace(TOKEN, (match, before: string, token: string) => (UUID.test(token) ? match : `${before}[token]`));
}

/** Collections whose next segment is a name people chose: a wiki page's slug, a skill file's path, a secret's name. */
const NAMED = new Set(["wiki", "pages", "files", "secrets"]);

/**
 * A path with its ids, tokens and names as `:id`: a segment with a digit, 24 characters long or more, or the one
 * after a collection of named things (`/org/:id/wiki/:id`, `/wiki/pages/:id/history`).
 */
export const pathPattern = (path: string) =>
  path
    .split("/")
    .map((segment, i, all) =>
      /\d/.test(segment) || segment.length >= 24 || (segment && NAMED.has(all[i - 1] ?? "") && !NAMED.has(segment))
        ? ":id"
        : segment,
    )
    .join("/");

/** A URL as its origin and path pattern, without the query, the fragment or credentials. */
export function urlPattern(url: string): string {
  try {
    const { protocol, host, pathname } = new URL(url);
    return `${protocol}//${host}${pathPattern(pathname)}`;
  } catch {
    return pathPattern(url.split(/[?#]/)[0] ?? "");
  }
}

/** A URL as its origin alone (`https://example.com`), or null when it isn't one. */
export function urlOrigin(url: string): string | null {
  try {
    const { protocol, host } = new URL(url);
    return host ? `${protocol}//${host}` : null;
  } catch {
    return null;
  }
}

/** A bracketed IPv6 host (`http://[::1]:3000/…`) is part of the URL, so its path is cut too. */
const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/(?:[^\s"'<>()[\]{}@/]*@)?(?:\[[\w:.%-]*\])?[^\s"'<>()[\]{}]*/gi;
const URL_HEAD = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#@]*@)?(?:\[[^\]]*\]|[^/?#:]*)(?::\d+)?/i;
/** Hosts named only on a local network (`someones-laptop.local`): a person's or a computer's name. */
const LOCAL_HOST = /\b[\w-]+(?:\.[\w-]+)*\.(?:local|lan|internal|home\.arpa)\b/gi;
/**
 * Home folders on macOS, Linux and Windows (both slashes), and Windows' variable for one. A Windows account name may
 * hold spaces (`C:\\Users\\Jane Doe\\…`): taken whole when a separator follows it.
 */
const HOME_PATHS =
  /(?:\/Users\/|\/home\/|[A-Za-z]:[\\/]+Users[\\/]+)(?:[^\\/\s"']+(?: [^\\/\s"']+)*(?=[\\/])|[^\\/\s"']+)|%USERPROFILE%/gi;
/** A cookie header's value, whatever its cookies are called. */
const COOKIE_HEADER = /\b((?:set-)?cookie["']?\s*[:=]\s*)[^\r\n]+/gi;
/** What a log line may keep at most: longer ones are cut. */
export const LOG_LINE_MAX = 1000;
/** Labels a sender's known values (`scrubLogLine`'s `known`) become. */
export type KnownLabel = "server" | "computer" | "workspace" | "agent" | "person";

/**
 * One log line a person chose to send (a problem report): `scrubText`, then each URL as its origin with `/…` for any
 * path, home folders as `~`, every `known` value as its label (`[computer]`), cut to `LOG_LINE_MAX`. Scrubbing a
 * scrubbed line gives the same line.
 */
export function scrubLogLine(line: string, known: ReadonlyArray<readonly [value: string, label: KnownLabel]> = []) {
  // Longest first: a machine called "box" never eats part of "box-2".
  const values = [...known].filter(([v]) => v.trim().length >= 3).sort((a, b) => b[0].length - a[0].length);
  const label = (text: string, which: typeof values) =>
    which.reduce((out, [value, name]) => out.split(value).join(`[${name}]`), text);
  // Names before the masks (a home folder may hold what reads as a token). URLs are cut before `scrubText`, so a
  // password in one (`postgres://user:p!ss@host`) goes with its credentials, not in part through the email mask; the
  // server's host is labeled after.
  const out = label(
    scrubText(
      label(
        line,
        values.filter(([, name]) => name !== "server"),
      )
        .replace(COOKIE_HEADER, "$1***")
        .replace(URL_IN_TEXT, (url) => {
          // A host a known name became (`[computer].local`) no longer parses: its scheme and host by pattern then.
          const head = urlOrigin(url) ?? URL_HEAD.exec(url)?.[0];
          if (!head) return url;
          const origin = head.replace(/\/\/[^/?#@]*@/, "//");
          return url.length > origin.length && url.slice(origin.length) !== "/" ? `${origin}/…` : origin;
        }),
    )
      .replace(LOCAL_HOST, "[host]")
      .replace(HOME_PATHS, "~"),
    values,
  );
  return out.length > LOG_LINE_MAX ? out.slice(0, LOG_LINE_MAX) : out;
}

/** A breadcrumb's data a report keeps: where a request or a navigation went and how it ended, never what it carried. */
const CRUMB_DATA = ["method", "status_code", "url", "from", "to"] as const;

/** Console lines may hold anything, so they never go; a click keeps its element, not its labels. */
export function scrubBreadcrumb(crumb: Breadcrumb): Breadcrumb | null {
  if (crumb.category === "console") return null;
  const data: Record<string, unknown> = {};
  for (const key of CRUMB_DATA) {
    const value = crumb.data?.[key];
    if (value === undefined) continue;
    data[key] = typeof value === "string" && key !== "method" ? urlPattern(value) : value;
  }
  let message = crumb.message === undefined ? undefined : scrubText(crumb.message);
  if (message && crumb.category?.startsWith("ui.")) message = message.replace(/\[[^\]]*\]/g, "");
  return { ...crumb, message, data };
}

/** Request headers a report keeps: which browser it came from. */
const KEPT_HEADERS = new Set(["user-agent"]);

/** Tags that hold our own ids, kept as they are: a person's is 32 random characters, which reads as a token. */
const ID_TAGS = new Set(["org_id", "user_id", "agent_id", "run_id", "machine_id", "job_id", "request_id", "error_id"]);

/**
 * What an error report may carry, from the server and the web app alike (GDPR, LGPD): the error and its stack, the
 * release, the route as a pattern and pseudonymous internal ids. Never emails, names, IP addresses, cookies, auth
 * headers, request or response bodies, message or mail content, tool inputs or outputs, prompts, model output, file
 * contents or tokens.
 */
export function scrubEvent<T extends Event>(event: T): T {
  const { request, user, contexts, tags } = event;
  if (request) {
    const headers = Object.entries(request.headers ?? {}).filter(([name]) => KEPT_HEADERS.has(name.toLowerCase()));
    event.request = {
      method: request.method,
      url: request.url === undefined ? undefined : urlPattern(request.url),
      ...(headers.length > 0 ? { headers: Object.fromEntries(headers) } : {}),
    };
  }
  event.user = user?.id === undefined ? undefined : { id: user.id };
  delete event.server_name;
  delete event.extra;
  delete event.sdkProcessingMetadata;
  if (event.message) event.message = scrubText(event.message);
  if (event.logentry) event.logentry = { message: event.logentry.message && scrubText(event.logentry.message) };
  if (event.transaction) event.transaction = pathPattern(event.transaction);
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = scrubText(exception.value);
    for (const frame of exception.stacktrace?.frames ?? []) delete frame.vars;
  }
  if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.flatMap((crumb) => scrubBreadcrumb(crumb) ?? []);
  if (contexts) {
    delete contexts.response;
    if (contexts.device) delete contexts.device.name;
  }
  if (tags)
    event.tags = Object.fromEntries(
      Object.entries(tags).map(([k, v]) => [k, typeof v === "string" && !ID_TAGS.has(k) ? scrubText(v) : v]),
    );
  return event;
}

/** What every reporting SDK starts with: nothing personal, no traces, every event and breadcrumb scrubbed. */
export const REPORT_OPTIONS = {
  sendDefaultPii: false,
  tracesSampleRate: 0,
  beforeSend: scrubEvent,
  beforeBreadcrumb: scrubBreadcrumb,
};
