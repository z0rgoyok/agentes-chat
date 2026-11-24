import { NativeError } from "./types";

/**
 * What Meta's two connectors (Threads, Meta Ads) share: how Meta's Graph answers read as a cause and one way out
 * (ADR 0170 §6), and its `signed_request` (deauthorize and data deletion callbacks).
 */

interface GraphError {
  error?: {
    message?: string;
    code?: number;
    error_subcode?: number;
    error_user_msg?: string;
  };
}

/** Meta's throttling codes (Graph and Marketing API). */
const THROTTLED = new Set([4, 17, 32, 613]);

/** Minutes until a throttled app or ad account may call again, from Meta's usage headers. */
function regainMinutes(headers: Headers): number | null {
  for (const name of ["x-business-use-case-usage", "x-ad-account-usage", "x-app-usage"]) {
    const raw = headers.get(name);
    if (!raw) continue;
    const found = /"estimated_time_to_regain_access"\s*:\s*(\d+)/.exec(raw);
    if (found) return Number(found[1]);
  }
  return null;
}

/** One Graph call's answer, or the `NativeError` it means. `service`: "Threads" or "Meta". */
export async function graphAnswer<T>(res: Response, service: string, writes: boolean): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as GraphError & T;
  if (res.ok && !body.error) return body;
  const e = body.error ?? {};
  const code = e.code ?? 0;
  const said = (e.error_user_msg ?? e.message ?? `HTTP ${res.status}`).slice(0, 300);
  if (code === 190 || res.status === 401) {
    throw new NativeError(
      "connector.needs_reconnect",
      `${service} refused the sign-in (it ended or was removed on ${service}'s side): someone who manages connectors reconnects it.`,
    );
  }
  if (THROTTLED.has(code) || (code >= 80000 && code <= 80014) || res.status === 429) {
    const minutes = regainMinutes(res.headers) ?? 60;
    const at = new Date(Date.now() + Math.max(minutes, 1) * 60_000);
    throw new NativeError(
      "connector.rate_limited",
      `${service} takes no more calls from this account until ${at.toISOString().slice(11, 16)} UTC. Nothing was ${writes ? "changed" : "read"}.`,
      at,
    );
  }
  if (code === 10 || (code >= 200 && code < 300)) {
    throw new NativeError(
      "connector.refused",
      `${service} refused it for lack of a permission: "${said}". Until ${service} approves this server's app for it (App Review), it can't be done here. Whoever runs this server follows docs/social-apps-checklist.md.`,
    );
  }
  if (res.status >= 500)
    throw new NativeError("connector.failed", `${service} is busy right now. Try again in a minute.`);
  throw new NativeError("connector.refused", `${service} refused it: "${said}"`);
}

/** A fetch whose failure to answer reads as the agent should take it. */
export async function graphFetch(http: typeof fetch, url: string, init: RequestInit, service: string, writes: boolean) {
  try {
    return await http(url, { ...init, signal: AbortSignal.timeout(60_000) });
  } catch {
    throw writes
      ? new NativeError(
          "connector.unknown_result",
          `${service} didn't answer in time: it may have happened. Check before doing it again.`,
        )
      : new NativeError("connector.failed", `${service} didn't answer. Try again in a minute.`);
  }
}
