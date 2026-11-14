import type { TFunction } from "i18next";
import type { AppNotification } from "../api/types";
import { namesText } from "./format";
import { teamWatchOf } from "./notifications";

/**
 * What the right hand found wrong (ADR 0177 §1), in the reader's language: the notice's headline, its names as a list
 * in words ("Slack, Notion e mais 1 precisam ser reconectados."). A cause this build doesn't know keeps the server's
 * own sentence. Null for any other notice.
 */
export function teamWatchLine(t: TFunction, n: Pick<AppNotification, "kind" | "count" | "latest">): string | null {
  const found = teamWatchOf(n);
  if (!found) return null;
  if (!found.key) return found.text;
  const say = t as unknown as (key: string, values: Record<string, unknown>) => string;
  return say(found.key, {
    names: namesText(t, found.names, found.names.length, found.count),
    count: found.count,
    defaultValue: found.text,
  });
}
