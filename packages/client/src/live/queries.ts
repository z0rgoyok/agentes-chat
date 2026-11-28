import { type InfiniteData, keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { useApi } from "../api/context";
import { keys } from "../api/keys";
import type { Artifact, ArtifactPage } from "../api/types";
import { type CacheEdit, editAll, optimistic, patchIn } from "../lib/optimistic";
import type { AskAgentInput, CreateLiveFileInput, LiveAssetSource, PresenceSummary } from "./types";

/**
 * React Query hooks around live files (ADR 0196, 0197, 0198): making one, who is in which file (the Drive's and
 * messages' cards), versions, pictures, asking an agent, image models and requests, uploaded Office files' previews.
 * The document itself never goes through here: it is the room's (`useLiveRoom`). Writes toast their errors unless the
 * caller handles them (`meta.silent` is left to the caller's `mutate` options).
 */

/** Who is in the cards' files: asked again this often while shown (`live.presence` events ask sooner). */
export const LIVE_PRESENCE_REFRESH_MS = 15_000;

/** Query keys of live files, under the workspace's (dropped with it). */
export const liveKeys = {
  all: (orgId: string) => ["org", orgId, "live"] as const,
  /** Every presence query (one per set of cards). */
  presenceAll: (orgId: string) => ["org", orgId, "live", "presence"] as const,
  /** One set of files, sorted, as one comma-separated string (the 5th part `applyLiveEvent` reads). */
  presence: (orgId: string, ids: readonly string[]) =>
    ["org", orgId, "live", "presence", [...new Set(ids)].sort().join(",")] as const,
  imageModels: (orgId: string) => ["org", orgId, "live", "image-models"] as const,
  /** A file's own fonts (its font lists). */
  fileFonts: (orgId: string, fileId: string) => ["org", orgId, "live", "fonts", fileId] as const,
  /** Under the Drive's: a new upload of the file refreshes its preview with the rest. */
  officePreview: (orgId: string, fileId: string, version?: number) =>
    [...keys.artifacts(orgId), "office-preview", fileId, version ?? "latest"] as const,
};

/** "Novo" › Planilha, Apresentação, Quadro: the file comes back (the Drive refreshes); open it with `useLiveRoom`. */
export function useCreateLiveFile(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateLiveFileInput) => api.live.create(orgId, input),
    // Not awaited: the new file opens without waiting for the Drive to be read again.
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.artifacts(orgId) }),
  });
}

/**
 * Who is in each of these files now (people and agents, hidden people never), asked again every
 * `LIVE_PRESENCE_REFRESH_MS` while shown and soon after a `live.presence` event (`applyLiveEvent`). The previous answer
 * stays while a new set of cards is asked about.
 */
export function useLivePresence(orgId: string, fileIds: readonly string[], options: { enabled?: boolean } = {}) {
  const api = useApi();
  const queryKey = liveKeys.presence(orgId, fileIds);
  const ids = queryKey[4];
  const list = useMemo(() => (ids ? ids.split(",") : []), [ids]);
  return useQuery({
    queryKey,
    queryFn: (): Promise<PresenceSummary> => api.live.presence(orgId, list),
    enabled: (options.enabled ?? true) && list.length > 0,
    refetchInterval: LIVE_PRESENCE_REFRESH_MS,
    staleTime: 5_000,
    placeholderData: keepPreviousData,
  });
}

/** The image models the workspace can use now (the default first); empty: none has a key. */
export function useImageModels(orgId: string, options: { enabled?: boolean } = {}) {
  const api = useApi();
  return useQuery({
    queryKey: liveKeys.imageModels(orgId),
    queryFn: () => api.live.imageModels(orgId),
    enabled: options.enabled ?? true,
    staleTime: 60_000,
  });
}

/** "Tentar de novo" on pictures that failed (the request's id, from its placeholders). */
export function useRetryImages(orgId: string, fileId: string) {
  const api = useApi();
  return useMutation({
    mutationFn: (requestId: string) => api.live.retryImages(orgId, fileId, requestId),
  });
}

/** An uploaded Office file as the apps draw it (ADR 0198); a version never changes, the latest may. */
export function useOfficePreview(
  orgId: string,
  fileId: string | null,
  version?: number,
  options: { enabled?: boolean } = {},
) {
  const api = useApi();
  return useQuery({
    queryKey: liveKeys.officePreview(orgId, fileId ?? "", version),
    queryFn: () => api.live.officePreview(orgId, fileId ?? "", version),
    enabled: Boolean(fileId) && (options.enabled ?? true),
    staleTime: version ? Number.POSITIVE_INFINITY : 30_000,
  });
}

/**
 * A file's new name before the server answers: on its page (at any version; not what sits under it, as its
 * conversation) and in the Drive's lists.
 */
function renameEdits(orgId: string, fileId: string, title: string): CacheEdit[] {
  return [
    editAll<Partial<Artifact>>([...keys.artifacts(orgId), "one", fileId], (file) =>
      file.id === fileId ? { ...file, title } : file,
    ),
    editAll<InfiniteData<ArtifactPage>>([...keys.artifacts(orgId), "list"], (data) => {
      if (!data.pages) return data;
      const renamed = patchIn<Artifact>(fileId, { title });
      return { ...data, pages: data.pages.map((p) => ({ ...p, artifacts: renamed(p.artifacts) })) };
    }),
  ];
}

/** Renames a live file from its page: the new name shows at once, and the Drive, its card and its page refresh. */
export function useRenameLiveFile(orgId: string, fileId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (title: string) => api.live.rename(orgId, fileId, title),
    ...optimistic(qc, (title: string) => renameEdits(orgId, fileId, title)),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.artifacts(orgId) }),
  });
}

/** "Duplicar": the copy, beside the file (the Drive refreshes). */
export function useDuplicateLiveFile(orgId: string, fileId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (title?: string) => api.live.duplicate(orgId, fileId, title),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.artifacts(orgId) }),
  });
}

/** "Editar como planilha / apresentação / documento": the new file, beside the upload. */
export function useOpenAs(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (fileId: string) => api.live.openAs(orgId, fileId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.artifacts(orgId) }),
  });
}

/** The file's history and its card after a version was written or restored. */
function refreshVersions(qc: ReturnType<typeof useQueryClient>, orgId: string, fileId: string) {
  void qc.invalidateQueries({ queryKey: keys.artifactVersions(orgId, fileId) });
  void qc.invalidateQueries({ queryKey: [...keys.artifacts(orgId), "one", fileId] });
}

/** "Salvar versão" with a name: `version` null when nothing changed since the last one. */
export function useSaveLiveVersion(orgId: string, fileId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (note?: string | null) => api.live.saveVersion(orgId, fileId, note),
    onSuccess: () => refreshVersions(qc, orgId, fileId),
  });
}

/** "Restaurar": everyone in the file sees it go back (the change comes through the socket like any other). */
export function useRestoreLiveVersion(orgId: string, fileId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (version: number) => api.live.restoreVersion(orgId, fileId, version),
    onSuccess: () => refreshVersions(qc, orgId, fileId),
  });
}

/** "Perguntar a um agente": the message goes where the file lives, carrying it and what is selected. */
export function useAskAgentAbout(orgId: string, fileId: string) {
  const api = useApi();
  return useMutation({
    mutationFn: (input: AskAgentInput) => api.live.ask(orgId, fileId, input),
  });
}

/** A picture dropped or picked into the file: its asset (the screen then places it in the document). */
export function useUploadAsset(orgId: string, fileId: string) {
  const api = useApi();
  return useMutation({
    mutationFn: (file: File) => api.live.uploadAsset(orgId, fileId, file),
  });
}

/** A file's own fonts, for its font lists; brought ones show once `useBringFont` adds them. */
export function useFileFonts(orgId: string, fileId: string) {
  const api = useApi();
  return useQuery({
    queryKey: liveKeys.fileFonts(orgId, fileId),
    queryFn: () => api.live.fileFonts(orgId, fileId),
    staleTime: 60_000,
  });
}

/**
 * A font brought from the Drive into the file (ADR 0220 §2): its asset, and the file's font list asked again. The
 * server refuses a file that isn't a font it can read (`live.font_invalid`).
 */
export function useBringFont(orgId: string, fileId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (artifactId: string) => api.live.copyAsset(orgId, fileId, { artifactId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: liveKeys.fileFonts(orgId, fileId) }),
  });
}

/** A picture copied in from the Drive or another live file: its asset here. */
export function useCopyAsset(orgId: string, fileId: string) {
  const api = useApi();
  return useMutation({
    mutationFn: (from: LiveAssetSource) => api.live.copyAsset(orgId, fileId, from),
  });
}
