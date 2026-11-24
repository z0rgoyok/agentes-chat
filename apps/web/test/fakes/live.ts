/**
 * Test fake — live files (ADR 0196, 0197, 0198): spreadsheets, presentations and canvases. Same shapes as the server's
 * `…/live-files`, `…/artifacts/{id}/live*`, `…/assets*`, `…/preview*`, `…/open-as` and `…/images*` routes, over an
 * in-memory live server (`FakeLiveServer`) that speaks the socket's protocol, so a test opens a live file as the app
 * does: `render.tsx` routes the app's `/api/live` sockets to `fake.server`.
 *
 * - A file made here is also a Drive file (the artifacts fake holds it, its preview as its content): the Drive lists it
 *   and `artifacts.get` reads it. `addFile` makes one with other content (`init`).
 * - Versions are snapshots of the document: saving one when nothing changed answers `version: null`; restoring writes
 *   the old content over the file for everyone in it.
 * - `askImages` (an agent asking for pictures) places a frame titled with the prompt and one placeholder per picture
 *   on the canvas at once; `finishImages` turns them into pictures (or failures with a reason), as the server's job does. `holdImages` false
 *   (the default is true) finishes each request on the next tick instead.
 * - Office previews answer from `previews` (by file id, or `${id}@${version}`); anything else can't be shown.
 * Calls are logged (`record`); reads are not.
 */
import type {
  ApiClient,
  Artifact,
  ArtifactLiveContent,
  AskAgentInput,
  CreateLiveFileInput,
  ImageAspect,
  ImageFailure,
  ImageModelOption,
  ImageRequestResult,
  ImageRequestStatus,
  LiveAsset,
  LiveKind,
  LivePresent,
  OfficePreview,
} from "@agenteschat/client";
import { ApiError, IMAGE_ASPECTS, MAX_IMAGES_PER_REQUEST } from "@agenteschat/client";
import { FAKE_SERVER_ORIGIN, FakeLiveServer } from "@agenteschat/client/live/testing";
import {
  addShape,
  fillPending,
  initLiveDoc,
  livePreview,
  placeBoxes,
  readShapes,
  replaceLiveContent,
  SYSTEM,
  slidesFromData,
  spreadsheetFromData,
  toBase64,
  updateShape,
} from "@agenteschat/live";
import { readPeerState } from "@agenteschat/live/awareness";
import * as Y from "yjs";
import { type MockContext, mockId } from "./context";

/** A picture of a live file, with the file it belongs to. */
export interface FakeLiveAsset extends LiveAsset {
  fileId: string;
}

/** What an agent asks for when it asks for pictures (`generate_image`'s input on a canvas). */
export interface FakeImageAsk {
  prompt: string;
  count?: number;
  aspect?: ImageAspect;
  model?: string;
  references?: string[];
  /** Where on the canvas (world units) the new pictures go. */
  at?: { x: number; y: number };
}

/** A request for pictures, as the server's `live_image_requests` row keeps it. */
export interface FakeImageRequest {
  id: string;
  fileId: string;
  input: FakeImageAsk;
  status: ImageRequestStatus;
  shapeIds: string[];
  frameId: string | null;
  error: ImageFailure | null;
}

export interface FakeLive {
  client: ApiClient["live"];
  /** The live server the app's sockets reach. */
  server: FakeLiveServer;
  /** What `officePreview` answers, by file id or `${id}@${version}`. */
  previews: Map<string, OfficePreview>;
  /** What `imageModels` answers (one model by default; empty: no key for any). */
  imageModels: ImageModelOption[];
  requests: FakeImageRequest[];
  assets: Map<string, FakeLiveAsset>;
  /** "Ask an agent" from inside a file. */
  asks: { fileId: string; input: AskAgentInput }[];
  /** Who is in a file as the presence route says, over who the server sees (people and agents in its sockets). */
  presence: Map<string, LivePresent[]>;
  /** Keeps generated pictures waiting until `finishImages` (default true). */
  holdImages: boolean;
  /** A live file in the Drive and on the server, as "Novo" makes one; `init` fills it instead of a new file's content. */
  addFile(orgId: string, input: CreateLiveFileInput & { init?: (doc: Y.Doc) => void }): Promise<Artifact>;
  /**
   * An agent asked for pictures on a canvas (`generate_image`, ADR 0197): a frame named with the prompt and one
   * placeholder per picture, placed at once as the server places them.
   */
  askImages(orgId: string, fileId: string, input: FakeImageAsk): Promise<ImageRequestResult>;
  /** A request's pictures arrive (each placeholder becomes a picture), or fail with `error`. */
  finishImages(requestId: string, outcome?: { error: ImageFailure }): void;
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_ASSET_BYTES = 25 * 1024 * 1024;
const notFound = () => new ApiError(404, "artifact.not_found", "File not found");

/** The model the fake offers: no maker's name, any shape, up to four pictures, from references too. */
export const FAKE_IMAGE_MODEL: ImageModelOption = {
  id: "fake-image",
  label: "Image model",
  provider: "fake",
  aspects: [...IMAGE_ASPECTS],
  maxCount: MAX_IMAGES_PER_REQUEST,
  refs: true,
};

/** A picture's box for an aspect ("16:9"), 512 units on its long side. */
function boxOf(aspect: ImageAspect | undefined): { w: number; h: number } {
  const [w = 1, h = 1] = (aspect ?? "1:1").split(":").map(Number);
  return w >= h ? { w: 512, h: Math.round((512 * h) / w) } : { w: Math.round((512 * w) / h), h: 512 };
}

export function createFakeLive(
  ctx: MockContext,
  record: (method: string, ...args: unknown[]) => void,
  artifacts: ApiClient["artifacts"],
): FakeLive {
  const server = new FakeLiveServer();
  /** Each file's versions as document snapshots, oldest first. */
  const snapshots = new Map<string, { version: number; state: Uint8Array }[]>();
  const me = async () => ({ kind: "person" as const, id: (await ctx.lookup.me())?.user.id ?? "me" });

  const contentOf = (kind: LiveKind, doc: Y.Doc) => ({ kind, preview: livePreview(doc) }) as ArtifactLiveContent;
  const live = (fileId: string) => {
    const file = server.files.get(fileId);
    if (!file) throw notFound();
    return file;
  };

  async function addFile(orgId: string, input: CreateLiveFileInput & { init?: (doc: Y.Doc) => void }) {
    const doc = new Y.Doc();
    // Named as the server names a new sheet for a person in Portuguese, the tests' language.
    initLiveDoc(doc, input.kind, { sheetName: "Planilha 1" });
    if (input.init) doc.transact(() => input.init?.(doc), FAKE_SERVER_ORIGIN);
    const made = await artifacts.create(orgId, {
      title: input.title,
      channelId: input.channelId ?? null,
      content: contentOf(input.kind, doc),
    });
    const state = Y.encodeStateAsUpdate(doc);
    doc.destroy();
    server.addFile(made.id, { kind: input.kind, state });
    snapshots.set(made.id, [{ version: made.version, state }]);
    const { content: _content, shownVersion: _shown, versioned: _versioned, ...artifact } = made;
    return artifact as Artifact;
  }

  /** A version of the file now (`note`), unless it holds what the last one did. */
  async function saveNow(orgId: string, fileId: string, note: string | null) {
    const file = live(fileId);
    const state = Y.encodeStateAsUpdate(file.doc);
    const list = snapshots.get(fileId) ?? [];
    const last = list.at(-1);
    const sameAsLast = last && sameContent(last.state, state);
    if (sameAsLast) return null;
    const current = await artifacts.get(orgId, fileId);
    const saved = await artifacts.update(orgId, fileId, {
      content: contentOf(file.kind ?? "spreadsheet", file.doc),
      note,
      baseVersion: current.version,
    });
    list.push({ version: saved.version, state });
    snapshots.set(fileId, list);
    server.versionsChanged(fileId);
    return saved.version;
  }

  const fake: FakeLive = {
    server,
    previews: new Map(),
    imageModels: [FAKE_IMAGE_MODEL],
    requests: [],
    assets: new Map(),
    asks: [],
    presence: new Map(),
    holdImages: true,
    addFile,
    async askImages(orgId, fileId, input) {
      record("images.ask", orgId, fileId, input);
      live(fileId);
      const prompt = input.prompt.trim();
      if (!prompt) throw new ApiError(400, "validation", "Say what the picture shows");
      const model = input.model ? fake.imageModels.find((m) => m.id === input.model) : fake.imageModels[0];
      if (!model) throw new ApiError(400, "images.no_key", "No image model is available");
      const count = Math.min(model.maxCount, Math.max(1, Math.floor(input.count ?? 1)));
      const by = await me();
      const request: FakeImageRequest = {
        id: mockId("imgreq"),
        fileId,
        input: { ...input, prompt },
        status: "queued",
        shapeIds: [],
        frameId: null,
        error: null,
      };
      const { w, h } = boxOf(input.aspect);
      server.edit(fileId, (doc) => {
        const placed = placeBoxes(doc, {
          count,
          w,
          h,
          ...(input.at ? { near: input.at } : {}),
          frame: { name: prompt.slice(0, 60) },
        });
        const frame = placed.frame;
        request.frameId = frame
          ? addShape(doc, { type: "frame", ...frame, name: prompt.slice(0, 60) }, FAKE_SERVER_ORIGIN)
          : null;
        request.shapeIds = placed.boxes.map((box, index) =>
          addShape(
            doc,
            {
              type: "pending",
              ...box,
              ...(request.frameId ? { parent: request.frameId } : {}),
              request: request.id,
              index,
              status: "queued",
              prompt,
              by,
            },
            FAKE_SERVER_ORIGIN,
          ),
        );
      });
      fake.requests.push(request);
      if (!fake.holdImages) setTimeout(() => fake.finishImages(request.id), 0);
      return resultOf(request);
    },
    finishImages(requestId, outcome) {
      const request = fake.requests.find((r) => r.id === requestId);
      if (!request) throw new Error(`No image request ${requestId}`);
      const file = live(request.fileId);
      server.edit(request.fileId, (doc) => {
        const shapes = new Map(readShapes(doc).map((s) => [s.id, s]));
        for (const shapeId of request.shapeIds) {
          const shape = shapes.get(shapeId);
          if (shape?.type !== "pending") continue;
          if (outcome?.error) {
            updateShape(doc, shapeId, { status: "failed", error: outcome.error }, FAKE_SERVER_ORIGIN);
            continue;
          }
          const asset: FakeLiveAsset = {
            id: mockId("asset"),
            fileId: file.id,
            contentType: "image/png",
            size: 1024,
            width: Math.round(shape.w),
            height: Math.round(shape.h),
          };
          fake.assets.set(asset.id, asset);
          fillPending(
            doc,
            shapeId,
            {
              asset: asset.id,
              nw: asset.width ?? 512,
              nh: asset.height ?? 512,
              gen: {
                prompt: request.input.prompt,
                model: request.input.model ?? FAKE_IMAGE_MODEL.id,
                by: shape.by ?? { kind: "person", id: "me" },
                at: ctx.now().toISOString(),
                request: request.id,
              },
            },
            FAKE_SERVER_ORIGIN,
          );
        }
      });
      request.status = outcome?.error ? "failed" : "done";
      request.error = outcome?.error ?? null;
    },
    client: {
      create: async (orgId, input) => {
        record("live.create", orgId, input);
        const title = input.title.trim();
        if (!title) throw new ApiError(400, "validation", "A title is required");
        return addFile(orgId, { ...input, title });
      },
      state: async (_orgId, fileId, version) => {
        const file = live(fileId);
        if (!version) return server.state(file.id);
        const snapshot = snapshots.get(fileId)?.find((v) => v.version === version);
        if (!snapshot) throw new ApiError(404, "artifact.version_not_found", "Version not found");
        return { state: toBase64(snapshot.state), seq: 0, mode: "view", kind: file.kind ?? "spreadsheet" };
      },
      rename: async (orgId, fileId, title) => {
        record("live.rename", orgId, fileId, title);
        const file = live(fileId);
        const name = title.trim();
        if (!name) throw new ApiError(400, "validation", "A title is required");
        // The fake's Drive renames through a version (the server writes none); its snapshot keeps restores working.
        const current = await artifacts.get(orgId, fileId);
        const saved = await artifacts.update(orgId, fileId, {
          content: contentOf(file.kind ?? "spreadsheet", file.doc),
          baseVersion: current.version,
          title: name,
        });
        const list = snapshots.get(fileId) ?? [];
        list.push({ version: saved.version, state: Y.encodeStateAsUpdate(file.doc) });
        snapshots.set(fileId, list);
        const { content: _c, shownVersion: _s, versioned: _v, ...artifact } = saved;
        return artifact as Artifact;
      },
      duplicate: async (orgId, fileId, title) => {
        record("live.duplicate", orgId, fileId, title ?? null);
        const file = live(fileId);
        const source = await artifacts.get(orgId, fileId);
        return addFile(orgId, {
          kind: file.kind ?? "spreadsheet",
          title: title?.trim() || source.title,
          channelId: source.channelId,
          threadId: source.threadId,
          init: (doc) => replaceLiveContent(doc, file.doc, FAKE_SERVER_ORIGIN),
        });
      },
      saveVersion: async (orgId, fileId, note) => {
        record("live.saveVersion", orgId, fileId, note ?? null);
        return { version: await saveNow(orgId, fileId, note?.trim() || null) };
      },
      restoreVersion: async (orgId, fileId, version) => {
        record("live.restoreVersion", orgId, fileId, version);
        const snapshot = snapshots.get(fileId)?.find((s) => s.version === version);
        if (!snapshot) throw new ApiError(404, "artifact.version_not_found", "Version not found");
        const old = new Y.Doc();
        Y.applyUpdate(old, snapshot.state);
        server.edit(fileId, (doc) => replaceLiveContent(doc, old, FAKE_SERVER_ORIGIN));
        old.destroy();
        const saved = await saveNow(orgId, fileId, `Restored v${version}`);
        return { version: saved ?? (snapshots.get(fileId)?.at(-1)?.version as number) };
      },
      presence: async (_orgId, fileIds) => {
        const out: Record<string, LivePresent[]> = {};
        for (const id of fileIds) {
          const file = server.files.get(id);
          if (!file) continue;
          const given = fake.presence.get(id);
          if (given) {
            out[id] = given.map((p) => ({ ...p }));
            continue;
          }
          const seen = new Map<string, LivePresent>();
          for (const peer of file.peers.values()) {
            const state = readPeerState(peer.state);
            if (!state) continue;
            const key = `${state.user.kind}:${state.user.id}`;
            const before = seen.get(key);
            if (!before || state.mode === "editing") {
              seen.set(key, { kind: state.user.kind, id: state.user.id, mode: state.mode });
            }
          }
          out[id] = [...seen.values()];
        }
        return out;
      },
      uploadAsset: async (orgId, fileId, file) => {
        record("live.uploadAsset", orgId, fileId, file.name);
        live(fileId);
        if (file.size > MAX_ASSET_BYTES) throw new ApiError(413, "live.asset_too_large", "The picture is too large");
        if (!IMAGE_TYPES.has(file.type)) throw new ApiError(400, "live.asset_type", "Only pictures");
        const asset: FakeLiveAsset = {
          id: mockId("asset"),
          fileId,
          contentType: file.type,
          size: file.size,
          width: null,
          height: null,
        };
        fake.assets.set(asset.id, asset);
        const { fileId: _f, ...view } = asset;
        return view;
      },
      copyAsset: async (orgId, fileId, from) => {
        record("live.copyAsset", orgId, fileId, from);
        live(fileId);
        const source = "assetId" in from ? fake.assets.get(from.assetId) : undefined;
        if ("assetId" in from && !source) throw notFound();
        const asset: FakeLiveAsset = {
          id: mockId("asset"),
          fileId,
          contentType: source?.contentType ?? "image/png",
          size: source?.size ?? 1024,
          width: source?.width ?? null,
          height: source?.height ?? null,
        };
        fake.assets.set(asset.id, asset);
        const { fileId: _f, ...view } = asset;
        return view;
      },
      assetUrl: (orgId, fileId, assetId) => `/api/app/organizations/${orgId}/artifacts/${fileId}/assets/${assetId}`,
      // A comment's pictures on a picture, a video or a PDF (ADR 0208): stored nowhere, an id back.
      uploadMark: async (orgId, fileId, picture) => {
        record("live.uploadMark", orgId, fileId, picture.type);
        return {
          id: crypto.randomUUID(),
          contentType: picture.type || "image/jpeg",
          size: picture.size,
          width: null,
          height: null,
        };
      },
      // As the server: resolved by the signed-in person, now.
      resolveComment: async (orgId, messageId, resolved) => {
        record("live.resolveComment", orgId, messageId, resolved);
        const by = { type: "person" as const, id: (await me()).id };
        return { resolved: resolved ? { by, at: ctx.now().toISOString() } : null };
      },
      ask: async (orgId, fileId, input) => {
        record("live.ask", orgId, fileId, input);
        if (!input.text.trim()) throw new ApiError(400, "validation", "Say what you want");
        const file = await artifacts.get(orgId, fileId);
        fake.asks.push({ fileId, input });
        return { id: mockId("msg"), channelId: file.channelId ?? `dm-${input.agentId}`, threadId: file.threadId };
      },
      officePreview: async (_orgId, fileId, version) => {
        const preview = fake.previews.get(version ? `${fileId}@${version}` : fileId) ?? fake.previews.get(fileId);
        if (!preview) throw new ApiError(422, "office.unreadable", "This file can't be shown here");
        return structuredClone(preview);
      },
      previewMediaUrl: (orgId, fileId, name, version) =>
        `/api/app/organizations/${orgId}/artifacts/${fileId}/preview/media/${encodeURIComponent(name)}${version ? `?version=${version}` : ""}`,
      openAs: async (orgId, fileId) => {
        record("live.openAs", orgId, fileId);
        const source = await artifacts.get(orgId, fileId);
        const preview = fake.previews.get(fileId);
        const title = source.title.replace(/\.[a-z0-9]{1,5}$/i, "");
        if (!preview) throw new ApiError(422, "office.unreadable", "This file can't be shown here");
        if (preview.kind === "document") {
          const made = await artifacts.create(orgId, {
            title,
            channelId: source.channelId,
            content: { kind: "document", markdown: previewWords(preview.html) },
          });
          const { content: _c, shownVersion: _s, versioned: _v, ...artifact } = made;
          return artifact as Artifact;
        }
        return addFile(orgId, {
          kind: preview.kind === "workbook" ? "spreadsheet" : "slides",
          title,
          channelId: source.channelId,
          // What the server read becomes the new file's content, as the server's `openAsLive` makes it.
          init: (doc) => {
            if (preview.kind === "workbook") spreadsheetFromData(doc, preview.workbook, SYSTEM);
            else slidesFromData(doc, preview.deck, SYSTEM);
          },
        });
      },
      imageModels: async () => structuredClone(fake.imageModels),
      retryImages: async (orgId, fileId, requestId) => {
        record("live.retryImages", orgId, fileId, requestId);
        const request = fake.requests.find((r) => r.id === requestId && r.fileId === fileId);
        if (!request) throw new ApiError(404, "images.request_not_found", "Request not found");
        request.status = "queued";
        request.error = null;
        server.edit(fileId, (doc) => {
          for (const id of request.shapeIds)
            updateShape(doc, id, { status: "queued", error: null }, FAKE_SERVER_ORIGIN);
        });
        if (!fake.holdImages) setTimeout(() => fake.finishImages(request.id), 0);
        return resultOf(request);
      },
    },
  };
  return fake;
}

/**
 * A document preview's words, as the fake's Markdown: each tag out (from a `<` to the first `>` after it), and the
 * rest after a `<` left open too, so no markup is ever left (one pass, by index, instead of a tag regex).
 */
function previewWords(html: string): string {
  let out = "";
  let from = 0;
  for (let at = html.indexOf("<"); at >= 0; at = html.indexOf("<", from)) {
    const end = html.indexOf(">", at + 1);
    out += html.slice(from, at);
    from = end < 0 ? html.length : end + 1;
  }
  return (out + html.slice(from)).trim();
}

function resultOf(request: FakeImageRequest): ImageRequestResult {
  return {
    requestId: request.id,
    status: request.status,
    shapeIds: [...request.shapeIds],
    frameId: request.frameId,
  };
}

/** Whether two encoded documents hold the same content (their states, merged, change nothing in each other). */
function sameContent(a: Uint8Array, b: Uint8Array): boolean {
  const va = Y.encodeStateVectorFromUpdate(a);
  const vb = Y.encodeStateVectorFromUpdate(b);
  if (va.length !== vb.length || va.some((byte, i) => byte !== vb[i])) return false;
  const da = Y.decodeUpdate(a).ds;
  const db = Y.decodeUpdate(b).ds;
  return JSON.stringify([...da.clients]) === JSON.stringify([...db.clients]);
}
