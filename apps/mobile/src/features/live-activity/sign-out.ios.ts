import { authedFetch } from "@/lib/auth";
import { SIGN_OUT_WAIT_MS } from "@/lib/push";
import { serverOf } from "@/lib/server-choice";
import { readValueSync, STORED } from "@/lib/storage";
import AgentsActivity from "./AgentsActivity";

/**
 * Signing out of a server: it stops sending this install the agents' Live Activity (ADR 0210), before the session ends
 * (the call needs it), and the activities on the phone end, so an account no longer signed in shows nothing here.
 */
export async function liveActivitySignOut(server: string): Promise<void> {
  const installId = readValueSync(STORED.liveActivityInstall);
  if (installId) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), SIGN_OUT_WAIT_MS);
    await authedFetch(
      `${serverOf(server)}/api/app/push/live-activity`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ installId }),
        signal: abort.signal,
      },
      server,
    ).catch(() => null);
    clearTimeout(timer);
  }
  for (const activity of AgentsActivity.getInstances()) await activity.end("immediate").catch(() => undefined);
}
