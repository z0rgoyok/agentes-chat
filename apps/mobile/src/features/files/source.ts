import { type ApiClient, type ArtifactDetail, isLiveFileKind, keys, useApi } from "@agenteschat/client";
import { BoundedMap } from "@agenteschat/ui/bounded-map";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Directory, File, Paths } from "expo-file-system";
import { Image } from "expo-image";
import * as MediaLibrary from "expo-media-library";
import * as Sharing from "expo-sharing";
import { useId, useState } from "react";
import { Platform } from "react-native";
import { appHeaders, readCookie } from "@/lib/auth";
import { serverUrl } from "@/lib/server";
import { router } from "@/ui/navigation";
import { resolveDownloadUrl, type ShareSource, safeFileName, shareSource } from "./logic";

/**
 * Getting at a file's bytes: the short-lived download link (with the session when the link is ours),
 * a copy in the cache for the share sheet, Salvar em Fotos, and the Drive on the web.
 */

/** The server's links live 5 minutes; refetch a bit before. */
const LINK_STALE_MS = 4 * 60 * 1000;
/** A view that keeps its link may start from the shared one while that one has most of its life ahead. */
const LINK_SEED_MS = 60 * 1000;

export interface RemoteFile {
  uri: string;
  headers: Record<string, string>;
}

const linkKey = (orgId: string, id: string | null, version?: number) =>
  ["org", orgId, "artifacts", "link", id ?? "", version ?? "latest"] as const;

async function remote(api: ApiClient, orgId: string, id: string, version?: number): Promise<RemoteFile> {
  const { url } = await api.artifacts.download(orgId, id, version);
  const r = resolveDownloadUrl(serverUrl(), url);
  return { uri: r.uri, headers: r.needsSession ? appHeaders(await readCookie()) : {} };
}

/**
 * Files this phone just sent, by id: the photo or video it sent is drawn from the phone's own copy, so a message never
 * fades its picture out and back in when the server's copy takes the place of the one on its way (`LocalFiles`). Kept
 * while the app stays open.
 */
const localCopies = new Map<string, string>();
export const rememberLocalCopy = (id: string, uri: string) => localCopies.set(id, uri);

/**
 * Pictures already drawn once in this run, by their cache key, the latest 2000: one coming back (its row mounted again
 * as the list scrolls, the conversation opened again) shows at once from the cache, where a fade each time read as a
 * flicker.
 */
const drawn = new BoundedMap<string, true>(2000);
/** A picture's fade in, its first time only (`drawn`). */
export const pictureFade = (key: string) => (drawn.has(key) ? 0 : 160);
/** Its `onLoad`: drawn once, it never fades in again in this run. */
export const pictureDrawn = (key: string) => {
  drawn.set(key, true);
};

/**
 * The link to show a file; a file this phone just sent, from its own copy. Shared and refreshed before it expires, for
 * a picture (its cache entry is `id@version`, whatever the link). `once`: read when the view opens and kept while it
 * stays, for what a new link would start over (a video back at 0:00, a PDF at its first page): a link of the view's
 * own that nothing reads again (no refetch on focus or reconnect, and `static` so no invalidation does either), only
 * its `refetch` ("Try again"); gone with the view, so the next one starts from a fresh link.
 */
export function useRemoteFile(orgId: string, id: string | null, version?: number, options?: { once?: boolean }) {
  const api = useApi();
  const qc = useQueryClient();
  const view = useId();
  const local = id ? localCopies.get(id) : undefined;
  const once = options?.once === true;
  const shared = linkKey(orgId, id, version);
  const query = useQuery<RemoteFile>({
    queryKey: once ? [...shared, "once", view] : shared,
    queryFn: () => remote(api, orgId, id ?? "", version),
    enabled: Boolean(id) && !local,
    ...(once
      ? {
          staleTime: "static" as const,
          gcTime: 0,
          refetchOnWindowFocus: false,
          refetchOnReconnect: false,
          // The shared link, when it was read moments ago: the view starts at once, with most of the link's life left.
          initialData: () => {
            const state = qc.getQueryState<RemoteFile>(shared);
            return state?.data && Date.now() - state.dataUpdatedAt < LINK_SEED_MS ? state.data : undefined;
          },
        }
      : { staleTime: LINK_STALE_MS, gcTime: LINK_STALE_MS }),
  });
  return local ? ({ ...query, data: { uri: local, headers: {} }, isError: false } as typeof query) : query;
}

/** A picture's entry in the image cache, the same for every view of it, whatever link it came from. */
export const pictureKey = (id: string, version?: number) => `${id}@${version ?? "latest"}`;

/** How long a picture's look at the disk is kept: its copy there stays put while the app runs, or the view errs. */
const DISK_LOOK_KEPT_MS = 10 * 60_000;

/** A path in the image cache as a URI the image view loads (`getCachePathAsync` answers a bare path). */
export const diskUri = (path: string) => (path.startsWith("/") ? `file://${path}` : path);

/**
 * A picture for the image view (`expo-image`): its copy already in this phone's image cache when there is one, with
 * no request for a link, else the short-lived link (`useRemoteFile`). `onError` gives up a copy the system removed
 * meanwhile and takes the link instead; `failed`: there is no picture to show.
 */
export function usePicture(orgId: string, id: string, version?: number) {
  const key = pictureKey(id, version);
  const [fromServer, setFromServer] = useState(false);
  const [failed, setFailed] = useState(false);
  const local = localCopies.has(id);
  const disk = useQuery({
    queryKey: ["picture-on-disk", key],
    queryFn: async () => {
      const path = await Image.getCachePathAsync(key).catch(() => null);
      return path ? diskUri(path) : "";
    },
    enabled: !local && !fromServer,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: DISK_LOOK_KEPT_MS,
  });
  const cached = !local && !fromServer && disk.data ? disk.data : null;
  const askServer = local || fromServer || (disk.isFetched && !disk.data);
  const link = useRemoteFile(orgId, askServer ? id : null, version);
  const source = cached
    ? { uri: cached, cacheKey: key }
    : link.data
      ? { uri: link.data.uri, headers: link.data.headers, cacheKey: key }
      : null;
  return {
    key,
    source,
    failed: failed || (!cached && link.isError),
    onError: () => (cached ? setFromServer(true) : setFailed(true)),
  };
}

/** Several artifacts at once (a message's files), sharing the cache of `useArtifact`. */
export function useArtifacts(orgId: string, refs: { id: string; version?: number }[]) {
  const api = useApi();
  return useQueries({
    queries: refs.map((r) => ({
      queryKey: keys.artifact(orgId, r.id, r.version),
      queryFn: () => api.artifacts.get(orgId, r.id, r.version),
      staleTime: r.version ? Number.POSITIVE_INFINITY : 0,
    })),
  });
}

/** The text of a Markdown or text file: what the server kept (small files) or the download. */
export async function fileText(api: ApiClient, orgId: string, a: ArtifactDetail): Promise<string> {
  if (a.content.kind === "document") return a.content.markdown;
  if (a.content.kind === "file" && a.content.text !== undefined) return a.content.text;
  const r = await remote(api, orgId, a.id, a.shownVersion);
  const res = await fetch(r.uri, { headers: r.headers, credentials: "omit" });
  if (!res.ok) throw new Error(`download ${res.status}`);
  return res.text();
}

/** A fresh folder per file under the cache, so the copy keeps its real name. */
function cacheFile(a: ArtifactDetail, name: string): File {
  const dir = new Directory(Paths.cache, "files", `${a.id}-${a.shownVersion}`);
  dir.create({ intermediates: true, idempotent: true });
  const file = new File(dir, name);
  if (file.exists) file.delete();
  return file;
}

/** A local copy of the file, with its name and extension (what the share sheet and Fotos get). */
export async function localCopy(
  api: ApiClient,
  orgId: string,
  a: ArtifactDetail,
): Promise<{ uri: string; source: ShareSource }> {
  const source = shareSource(a);
  const file = cacheFile(a, safeFileName(source.name));
  if (source.from === "text") {
    file.write(source.text);
    return { uri: file.uri, source };
  }
  const r =
    source.from === "export"
      ? {
          // A live file is exported as it stands now (ADR 0198): its versions are snapshots, not what people see.
          uri: api.artifacts.fileUrl(orgId, a.id, {
            ...(isLiveFileKind(a.kind) ? {} : { version: a.shownVersion }),
            ...(source.format ? { format: source.format } : {}),
          }),
          headers: appHeaders(await readCookie()),
        }
      : await remote(api, orgId, a.id, a.shownVersion);
  const done = await File.downloadFileAsync(r.uri, file, { headers: r.headers, idempotent: true });
  return { uri: done.uri, source };
}

/**
 * A PDF's copy in the cache for the system's renderer, which reads a file, never a link (`PdfPages`): one per version,
 * kept while the cache keeps it, so the PDF opens again without downloading it.
 */
export async function pdfCopy(api: ApiClient, orgId: string, a: ArtifactDetail): Promise<string> {
  const dir = new Directory(Paths.cache, "pdf");
  dir.create({ intermediates: true, idempotent: true });
  const file = new File(dir, `${safeFileName(a.id)}-${a.shownVersion}.pdf`);
  if (file.exists && (file.size ?? 0) > 0) return file.uri;
  const r = await remote(api, orgId, a.id, a.shownVersion);
  const done = await File.downloadFileAsync(r.uri, file, { headers: r.headers, idempotent: true });
  return done.uri;
}

/** The system share sheet with the real file (Salvar imagem, Salvar em Arquivos, other apps). */
export async function shareFile(api: ApiClient, orgId: string, a: ArtifactDetail): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new Error("sharing unavailable");
  const { uri, source } = await localCopy(api, orgId, a);
  // On iOS the name already carries the extension; a MIME type there would add a second one.
  await Sharing.shareAsync(
    uri,
    Platform.OS === "android" && source.mime ? { mimeType: source.mime, dialogTitle: source.name } : {},
  );
}

/** Salvar em Fotos: add-only access (never reads the library). False when the person said no. */
export async function saveToPhotos(api: ApiClient, orgId: string, a: ArtifactDetail): Promise<boolean> {
  const perm = await MediaLibrary.requestPermissionsAsync(true, ["photo"]);
  if (!perm.granted) return false;
  const { uri } = await localCopy(api, orgId, a);
  await MediaLibrary.Asset.create(uri);
  return true;
}

/**
 * Ver no Drive: closes the viewer and opens the app's Drive with the file outlined (back on the Drive when the
 * viewer was opened from it).
 */
export function openInDrive(_orgId: string, a: Pick<ArtifactDetail, "id" | "shownVersion" | "version">) {
  if (router.canGoBack()) router.back();
  return new Promise<void>((resolve) =>
    setTimeout(() => {
      router.navigate({ pathname: "/drive", params: { artifact: a.id } });
      resolve();
    }, 60),
  );
}
