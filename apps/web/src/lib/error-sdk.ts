import { REPORT_OPTIONS, scrubEvent, urlPattern } from "@agenteschat/adapters/error-scrub";
import type { ErrorReportsConfig } from "@agenteschat/client";
import { captureException, type Event, init, setTags, setUser } from "@sentry/browser";
import { reloadingForNewVersion } from "./app-version";
import { desktopReportTags } from "./desktop";
import { appFiles, type ErrorSdk, foreignStack, shortErrorId } from "./error-reports";

/**
 * A frame of an inline script, or of a script an extension injected into the page, names the page it ran on as its
 * file: that address goes as its pattern, like the request's (ADR 0104), since it holds the workspace's and the
 * person's ids and a wiki page's name. The app's own files (`/assets/`) and other origins' stay as they are.
 *
 * In place on `scrubEvent`'s copy, whose frames are its own: the SDK's dedupe keeps the frames `beforeSend` is given,
 * to compare the next report's with.
 */
function scrubPageFrames<T extends Event>(event: T): T {
  const page = `${location.origin}/`;
  const scrub = (file: string) => (file.startsWith(page) && !file.startsWith(appFiles()) ? urlPattern(file) : file);
  for (const value of event.exception?.values ?? [])
    for (const frame of value.stacktrace?.frames ?? []) {
      if (frame.filename) frame.filename = scrub(frame.filename);
      if (frame.abs_path) frame.abs_path = scrub(frame.abs_path);
    }
  return event;
}

/**
 * The Sentry browser SDK for errors only (no sessions, traces or replays), every event scrubbed (ADR 0104). Its own
 * handlers report the page's errors and unhandled rejections from now on. `taken`: each report it sends, by id.
 */
export function startSdk(config: ErrorReportsConfig, taken: (eventId: string) => void): ErrorSdk {
  init({
    ...REPORT_OPTIONS,
    // After the SDK's own dedupe, which drops a repeat of the last report: what reaches here is sent.
    beforeSend: (event) => {
      // Its own handlers too: what fails while the app reloads into a new version is the old version's, and what
      // fails in an extension's code is the extension's. This file's chunk holds the SDK too: nothing else imports it.
      if (reloadingForNewVersion() || foreignStack(event, import.meta.url)) return null;
      if (event.event_id) taken(event.event_id);
      return scrubPageFrames(scrubEvent(event));
    },
    dsn: config.dsn,
    environment: config.environment,
    release: config.release,
    integrations: (defaults) => defaults.filter((integration) => integration.name !== "BrowserSession"),
  });
  setTags(desktopReportTags());
  return {
    capture(error, eventId) {
      captureException(error, { event_id: eventId, captureContext: { tags: { error_id: shortErrorId(eventId) } } });
    },
    scope({ route, orgId, userId }) {
      setTags({ route, org_id: orgId });
      setUser(userId ? { id: userId } : null);
    },
  };
}
