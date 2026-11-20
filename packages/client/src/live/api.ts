import { fromBase64 } from "@agenteschat/live";
import type { LiveMode } from "@agenteschat/live/protocol";
import { enc, type Requester } from "../api/http";
import type { Artifact } from "../api/types";
import { withoutTrailingSlashes } from "../lib/server";
import {
  type AskAgentInput,
  type AskAgentResult,
  type CreateLiveFileInput,
  type ImageModelOption,
  type ImageRequestResult,
  type ImageRequestStatus,
  isLiveFileKind,
  type LiveAsset,
  type LiveAssetSource,
  type LiveFileState,
  type LiveKind,
  type LiveVersionSaved,
  type OfficePreview,
  type PresenceSummary,
} from "./types";

/**
 * Live files' routes (ADR 0196, 0197, 0198), `/api/app/organizations/{orgId}/…`: making one, its state to open it
 * with (then the socket at `/api/live`), versions, who is in it, its pictures, asking an agent from inside it, uploaded
 * Office files' previews, and generated images.
 */
export interface LiveApi {
  /** "Novo" › Planilha, Apresentação, Quadro: an empty file in the Drive, or in a conversation the person is in. */
  create(orgId: string, input: CreateLiveFileInput): Promise<Artifact>;
  /**
   * The document as it stands now (base64), its newest change and what the person may do in it; with `version`, that
   * saved version instead, read-only (the history's look at it).
   */
  state(orgId: string, fileId: string, version?: number): Promise<LiveFileState>;
  /** Renames the file from its page (its title only: no version is written). */
  rename(orgId: string, fileId: string, title: string): Promise<Artifact>;
  /** "Duplicar": a copy at its head, with its pictures, beside it. */
  duplicate(orgId: string, fileId: string, title?: string): Promise<Artifact>;
  /** "Salvar versão": a version now, with a name; `null` when nothing changed since the last one. */
  saveVersion(orgId: string, fileId: string, note?: string | null): Promise<LiveVersionSaved>;
  /** "Restaurar": the version's content written over the file for everyone in it; the version that records it. */
  restoreVersion(orgId: string, fileId: string, version: number): Promise<LiveVersionSaved>;
  /** Who is in each file now (the Drive's and messages' cards); asked in batches the server takes. */
  presence(orgId: string, fileIds: string[]): Promise<PresenceSummary>;
  /** A picture into the file (multipart, ≤ 25 MB; PNG, JPEG, WebP or GIF). */
  uploadAsset(orgId: string, fileId: string, file: File): Promise<LiveAsset>;
  /** A picture copied in: from a Drive file the person reads, or from another live file. */
  copyAsset(orgId: string, fileId: string, from: LiveAssetSource): Promise<LiveAsset>;
  /** The address of a picture of the file (same origin on the web; the server's on the phone). */
  assetUrl(orgId: string, fileId: string, assetId: string): string;
  /** "Perguntar a um agente": the message to the agent, carrying the file and what is selected. */
  ask(orgId: string, fileId: string, input: AskAgentInput): Promise<AskAgentResult>;
  /** An uploaded Office file as the apps draw it (ADR 0198), at a version (default: the latest). */
  officePreview(orgId: string, fileId: string, version?: number): Promise<OfficePreview>;
  /** The address of a picture inside an uploaded deck, by the name its preview gives it. */
  previewMediaUrl(orgId: string, fileId: string, name: string, version?: number): string;
  /** "Editar como planilha / apresentação / documento": a new file made from the upload, beside it. */
  openAs(orgId: string, fileId: string): Promise<Artifact>;
  /** The image models the workspace can use now, the default first (empty: no key for any). */
  imageModels(orgId: string): Promise<ImageModelOption[]>;
  /** "Tentar de novo" on pictures that failed. */
  retryImages(orgId: string, fileId: string, requestId: string): Promise<ImageRequestResult>;
}

/** How a multipart upload goes (the Drive's `files.upload`). */
export type LiveUpload = <T>(path: string, form: FormData) => Promise<T>;

/** Files one presence request may name (the route's own limit). */
export const LIVE_PRESENCE_BATCH = 100;

const org = (orgId: string) => `/api/app/organizations/${enc(orgId)}`;
const file = (orgId: string, fileId: string) => `${org(orgId)}/artifacts/${enc(fileId)}`;

/**
 * The live routes over `request` (JSON) and `upload` (multipart, for pictures). `base` prefixes addresses the
 * platform loads itself (pictures): "" on the web (same origin), the server's address on the phone.
 */
export function createLiveApi(request: Requester, options: { upload?: LiveUpload; base?: string } = {}): LiveApi {
  const base = withoutTrailingSlashes(options.base ?? "");
  const upload: LiveUpload =
    options.upload ??
    (() => Promise.reject(new Error("This client can't upload pictures: give createLiveApi an upload")));
  return {
    create: (orgId, input) =>
      request<Artifact>(`${org(orgId)}/live-files`, {
        json: {
          kind: input.kind,
          title: input.title,
          ...(input.channelId ? { channelId: input.channelId } : {}),
          ...(input.threadId ? { threadId: input.threadId } : {}),
        },
      }),
    state: (orgId, fileId, version) =>
      version
        ? request<LiveFileState>(`${file(orgId, fileId)}/live`, { query: { version } })
        : request<LiveFileState>(`${file(orgId, fileId)}/live`),
    rename: (orgId, fileId, title) => request<Artifact>(`${file(orgId, fileId)}/live/rename`, { json: { title } }),
    duplicate: (orgId, fileId, title) =>
      request<Artifact>(`${file(orgId, fileId)}/live/duplicate`, {
        json: title?.trim() ? { title: title.trim() } : {},
      }),
    saveVersion: (orgId, fileId, note) =>
      request<LiveVersionSaved>(`${file(orgId, fileId)}/live/versions`, {
        json: note?.trim() ? { note: note.trim() } : {},
      }),
    restoreVersion: (orgId, fileId, version) =>
      request<LiveVersionSaved>(`${file(orgId, fileId)}/live/restore`, { json: { version } }),
    presence: async (orgId, fileIds) => {
      const ids = [...new Set(fileIds.filter(Boolean))];
      const batches: string[][] = [];
      for (let i = 0; i < ids.length; i += LIVE_PRESENCE_BATCH) batches.push(ids.slice(i, i + LIVE_PRESENCE_BATCH));
      const answers = await Promise.all(
        batches.map((batch) =>
          request<{ presence?: PresenceSummary } | PresenceSummary>(`${org(orgId)}/live/presence`, {
            query: { ids: batch.join(",") },
          }),
        ),
      );
      const summary: PresenceSummary = {};
      for (const res of answers) Object.assign(summary, presenceOf(res));
      return summary;
    },
    uploadAsset: (orgId, fileId, picture) => {
      const form = new FormData();
      form.append("file", picture, picture.name);
      return upload<LiveAsset>(`${file(orgId, fileId)}/assets`, form);
    },
    copyAsset: (orgId, fileId, from) => request<LiveAsset>(`${file(orgId, fileId)}/assets/copy`, { json: from }),
    assetUrl: (orgId, fileId, assetId) => `${base}${file(orgId, fileId)}/assets/${enc(assetId)}`,
    ask: (orgId, fileId, input) => request<AskAgentResult>(`${file(orgId, fileId)}/live/ask`, { json: input }),
    officePreview: async (orgId, fileId, version) =>
      officePreviewOf(await request<unknown>(`${file(orgId, fileId)}/preview`, { query: { version } }), base),
    previewMediaUrl: (orgId, fileId, name, version) =>
      `${base}${file(orgId, fileId)}/preview/media/${enc(name)}${version ? `?version=${version}` : ""}`,
    openAs: (orgId, fileId) => request<Artifact>(`${file(orgId, fileId)}/open-as`, { json: {} }),
    imageModels: async (orgId) => {
      const res = await request<{ models?: ImageModelOption[] } | ImageModelOption[]>(`${org(orgId)}/images/models`);
      const models = Array.isArray(res) ? res : res?.models;
      return Array.isArray(models) ? models : [];
    },
    retryImages: async (orgId, fileId, requestId) =>
      imageRequestOf(await request<unknown>(`${file(orgId, fileId)}/images/${enc(requestId)}/retry`, { json: {} })),
  };
}

/** `{ presence: {…} }` as the route answers, or the map itself: only lists of entries that read right. */
function presenceOf(raw: unknown): PresenceSummary {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const map = o.presence && typeof o.presence === "object" ? (o.presence as Record<string, unknown>) : o;
  const out: PresenceSummary = {};
  for (const [id, list] of Object.entries(map)) {
    if (!Array.isArray(list)) continue;
    out[id] = list.filter(
      (p): p is PresenceSummary[string][number] =>
        !!p &&
        typeof p === "object" &&
        (p.kind === "person" || p.kind === "agent") &&
        typeof p.id === "string" &&
        (p.mode === "viewing" || p.mode === "editing"),
    );
  }
  return out;
}

/** The document's state as the connection applies it: its bytes, newest change, mode and kind. */
export interface LiveLoadedState {
  state: Uint8Array;
  seq: number;
  mode: LiveMode;
  kind?: LiveKind | null;
}

/** `GET …/live` decoded: the bytes out of their base64 (a saved `version` is always read-only). */
export async function loadLiveState(
  api: Pick<LiveApi, "state">,
  orgId: string,
  fileId: string,
  version?: number,
): Promise<LiveLoadedState> {
  const s = version ? await api.state(orgId, fileId, version) : await api.state(orgId, fileId);
  return {
    state: typeof s.state === "string" && s.state.length > 0 ? fromBase64(s.state) : new Uint8Array(0),
    seq: typeof s.seq === "number" && Number.isSafeInteger(s.seq) && s.seq >= 0 ? s.seq : 0,
    mode: s.mode === "edit" && !version ? "edit" : "view",
    kind: isLiveFileKind(s.kind) ? s.kind : null,
  };
}

const STATUSES: readonly ImageRequestStatus[] = ["queued", "running", "done", "failed"];

/** A request for pictures as the server answered it, read leniently (ids under either name, lists always lists). */
export function imageRequestOf(raw: unknown): ImageRequestResult {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const id = typeof o.requestId === "string" ? o.requestId : typeof o.id === "string" ? o.id : "";
  const status = STATUSES.includes(o.status as ImageRequestStatus) ? (o.status as ImageRequestStatus) : "queued";
  const shapeIds = Array.isArray(o.shapeIds) ? o.shapeIds.filter((s): s is string => typeof s === "string") : [];
  return { requestId: id, status, shapeIds, frameId: typeof o.frameId === "string" ? o.frameId : null };
}

/**
 * An Office preview as the server answered it: `kind` says which (`workbook`, `deck`, `document`), and a bare
 * workbook (`sheets`), deck (`slides`) or HTML reads as one too. A deck's pictures get the server's address on the
 * phone (`base`). Anything else throws: the viewer offers the download instead.
 */
export function officePreviewOf(raw: unknown, base = ""): OfficePreview {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const kind = typeof o.kind === "string" ? o.kind : "";
  const workbook = (o.workbook ?? (Array.isArray(o.sheets) ? o : undefined)) as { sheets?: unknown } | undefined;
  if ((kind === "workbook" || kind === "spreadsheet" || !kind) && workbook && Array.isArray(workbook.sheets)) {
    return { kind: "workbook", workbook: workbook as Extract<OfficePreview, { kind: "workbook" }>["workbook"] };
  }
  const deck = (o.deck ?? (Array.isArray(o.slides) ? o : undefined)) as
    | { slides?: unknown; media?: Record<string, { type?: unknown; url?: unknown }> }
    | undefined;
  if ((kind === "deck" || kind === "slides" || !kind) && deck && Array.isArray(deck.slides)) {
    const media: Record<string, { type: string; url?: string }> = {};
    for (const [name, m] of Object.entries(deck.media ?? {})) {
      if (!m || typeof m !== "object") continue;
      const url = typeof m.url === "string" ? (m.url.startsWith("/") ? base + m.url : m.url) : undefined;
      media[name] = { type: typeof m.type === "string" ? m.type : "", ...(url ? { url } : {}) };
    }
    return { kind: "deck", deck: { ...deck, media } as Extract<OfficePreview, { kind: "deck" }>["deck"] };
  }
  if (typeof o.html === "string") return { kind: "document", html: o.html };
  throw new Error("This file can't be shown here");
}
