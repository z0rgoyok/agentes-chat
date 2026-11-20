import type { ArtifactKind } from "@agenteschat/client";
import { isLiveFileKind, keys } from "@agenteschat/client";
import type { QueryClient } from "@tanstack/react-query";
import type { useNavigate } from "@tanstack/react-router";

type Navigate = ReturnType<typeof useNavigate>;

/**
 * Opens a live file on its own page (ADR 0196 §9): at a saved version read-only (`version`), or as it is now. Every
 * link to a file stays the Drive's (`filePath`); whatever opens one (the Drive, a message's card, a link) comes here
 * for the live kinds instead of the viewer.
 */
export function openLivePage(
  navigate: Navigate,
  orgId: string,
  fileId: string,
  options: { version?: number | undefined; replace?: boolean } = {},
) {
  void navigate({
    to: "/org/$orgId/drive/$fileId",
    params: { orgId, fileId },
    search: options.version ? { v: options.version } : {},
    replace: options.replace,
  });
}

const kindIn = (value: unknown, id: string): ArtifactKind | null => {
  if (!value || typeof value !== "object") return null;
  const o = value as { id?: unknown; kind?: unknown };
  return o.id === id && typeof o.kind === "string" ? (o.kind as ArtifactKind) : null;
};

/**
 * A file's kind as this app already knows it (a card or a Drive page loaded it), without asking the server: the one
 * file's query, then the Drive's pages. Null when nothing loaded it yet.
 */
export function cachedKind(qc: QueryClient, orgId: string, id: string): ArtifactKind | null {
  const one = kindIn(qc.getQueryData(keys.artifact(orgId, id)), id);
  if (one) return one;
  for (const [, data] of qc.getQueriesData<unknown>({ queryKey: keys.artifacts(orgId) })) {
    const direct = kindIn(data, id);
    if (direct) return direct;
    const pages = (data as { pages?: unknown } | undefined)?.pages;
    if (!Array.isArray(pages)) continue;
    for (const page of pages) {
      const list = (page as { artifacts?: unknown } | undefined)?.artifacts;
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        const kind = kindIn(item, id);
        if (kind) return kind;
      }
    }
  }
  return null;
}

/** Whether this app knows the file is a live one (see `cachedKind`). */
export const knownLive = (qc: QueryClient, orgId: string, id: string) => isLiveFileKind(cachedKind(qc, orgId, id));
