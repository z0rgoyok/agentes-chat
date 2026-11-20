import { keys, useApi } from "@agenteschat/client";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { router } from "@/ui/navigation";
import { useOrgId } from "../shared/hooks";
import { type FileRef, fileRoute, whereKnown } from "./logic";

/**
 * Opens a file from wherever it shows (a message, the Drive, a search, a file's pill, a task): a picture or a video
 * straight in the picture viewer, one transition, among the pictures and videos beside it (`siblings`, in the order
 * they show); anything else in the file screen (`fileRoute`). `from`: the deck it opened from, told where the person
 * stops; `replace`: in the current screen's place (a file's link that turned out to be a picture).
 */
export function openFile(ref: FileRef, siblings?: readonly FileRef[], how: { from?: string; replace?: boolean } = {}) {
  const route = fileRoute(ref, siblings, how.from);
  if (how.replace) router.replace(route);
  else router.push(route);
}

/**
 * `openFile` for places that know a file only by its name (the Drive, a search, a pill): when the name doesn't say
 * what it is (a video titled without its extension), its details come first, from the cache when the place already
 * read them, so a video never opens the file screen and then moves on to the viewer.
 */
export function useOpenFile() {
  const api = useApi();
  const qc = useQueryClient();
  const orgId = useOrgId();
  return useCallback(
    async (ref: FileRef, siblings?: readonly FileRef[]) => {
      if (whereKnown(ref)) {
        openFile(ref, siblings);
        return;
      }
      const detail = await qc
        .ensureQueryData({
          queryKey: keys.artifact(orgId, ref.id, ref.version),
          queryFn: () => api.artifacts.get(orgId, ref.id, ref.version),
        })
        .catch(() => undefined);
      openFile(detail ? { ...ref, detail } : ref, siblings);
    },
    [api, qc, orgId],
  );
}
