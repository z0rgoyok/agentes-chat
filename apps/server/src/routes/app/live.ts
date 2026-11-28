import { and, eq, inArray, isNull, schema, sql } from "@agenteschat/db";
import {
  type ArtifactDeps,
  copyAssetFrom,
  createLiveFile,
  duplicateLiveFile,
  fileSeenSql,
  getAsset,
  LIVE_ASSET_BYTES,
  LIVE_ASSET_MB,
  type LiveDeps,
  type LiveDocs,
  liveSnapshotOf,
  MARK_PICTURE_BYTES,
  MAX_MESSAGE_LENGTH,
  putAsset,
  putMarkPicture,
  readFileFonts,
  renameLiveFile,
  requireActiveMembership,
  requireLiveFile,
  resolveComment,
  withPersonFacts,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { apiError, errorResponse } from "../../http/errors";
import { Artifact } from "./artifacts";
import {
  type AppDeps,
  body,
  createAppRouter,
  errors,
  json,
  MULTIPART_SLACK_BYTES,
  OrgParams,
  requireSession,
  security,
} from "./context";
import { askAgentAbout, officePreview, openAsLive } from "./live-engine";
import { LiveSelection } from "./schemas";

const tags = ["Live files"];
const LiveKind = z.enum(["spreadsheet", "slides", "canvas", "document"]);
const ArtifactParams = OrgParams.extend({ artifactId: z.uuid() });
const isUuid = (value: string) => z.uuid().safeParse(value).success;
const base64 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");

/**
 * What an asset may be: pictures and the file's own fonts (ADR 0220 §2, the type its bytes gave), whatever was stored,
 * so nothing else is ever served from here.
 */
const ASSET_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "font/ttf",
  "font/otf",
  "font/woff",
]);
/**
 * An SVG picture (stored as the sanitizer rebuilt it, ADR 0196 §8) is served with a CSP that runs and loads nothing,
 * also when it is opened on its own in a tab: the apps only ever show it as a picture.
 */
const SVG_ASSET = "image/svg+xml";
const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
/** Files whose presence one request asks for (a Drive page's cards). */
const PRESENCE_IDS = 100;

const Mode = z.enum(["edit", "view"]).openapi({
  description: "`edit`: the person changes it. `view`: read-only now (in the trash, its workspace being deleted).",
});

const LiveState = z
  .object({
    state: z.string().openapi({ description: "Base64 of the document as one Yjs update." }),
    seq: z.number().int().openapi({ description: "The newest change it holds." }),
    mode: Mode,
    kind: LiveKind,
  })
  .openapi("LiveFileState");

const LiveAsset = z
  .object({
    id: z.string(),
    contentType: z
      .string()
      .openapi({ description: "Read from the bytes: image/png, image/jpeg, image/webp or image/gif." }),
    size: z.number().int(),
    width: z.number().int().nullable(),
    height: z.number().int().nullable(),
    font: z
      .object({
        family: z.string(),
        style: z.string(),
        weight: z.number().int(),
        italic: z.boolean(),
      })
      .nullable()
      .optional()
      .openapi({ description: "A font (ADR 0220 §2): its family, style and weight as its own file names them." }),
  })
  .openapi("LiveAsset");

const LiveFileFont = z
  .object({
    id: z.string().openapi({ description: "The asset's id; the file names it `asset:<id>`." }),
    family: z.string(),
    style: z.string(),
    weight: z.number().int(),
    italic: z.boolean(),
  })
  .openapi("LiveFileFont");

const PresenceEntry = z
  .object({
    kind: z.enum(["person", "agent"]),
    id: z.string(),
    mode: z.enum(["viewing", "editing"]),
  })
  .openapi("LivePresenceEntry");

type Present = z.infer<typeof PresenceEntry>;

/** Where a picture comes from: a Drive file the person reads (a version of it), or another live file's picture. */
const AssetSource = z.union([
  z.object({ artifactId: z.uuid(), version: z.number().int().min(1).optional() }),
  z.object({ fileId: z.uuid(), assetId: z.uuid() }),
]);

/** Who resolved a comment on a picture, a video or a PDF, and when (ADR 0208). */
const ResolvedMark = z
  .object({
    by: z.object({ type: z.enum(["person", "agent"]), id: z.string() }),
    at: z.string(),
  })
  .openapi("ResolvedMark");

/** A file upload (multipart). */
const fileField = z
  .any()
  .openapi({ type: "string", format: "binary", description: `The picture (≤ ${LIVE_ASSET_MB} MB).` });

/**
 * Live files (ADR 0196): spreadsheets, presentations and canvases people and agents edit together. Made here, opened
 * here (their state, then the socket at `/api/live` keeps them in step), saved as versions, given pictures, and asked
 * about. Uploaded Office files open here too (ADR 0198): their preview, and a live file made from them.
 */
export function liveRoutes(deps: AppDeps) {
  const { db } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  // The picture's bytes are counted as they arrive, so a request that states no length is held to the same size.
  app.use(
    "/organizations/:orgId/artifacts/:artifactId/marks",
    bodyLimit({
      maxSize: MARK_PICTURE_BYTES + MULTIPART_SLACK_BYTES,
      onError: (c) => apiError(c, 413, "live.asset_too_large", "The picture is too large (max 2 MB)", { max: 2 }),
    }),
  );
  app.use(
    "/organizations/:orgId/artifacts/:artifactId/assets",
    bodyLimit({
      maxSize: LIVE_ASSET_BYTES + MULTIPART_SLACK_BYTES,
      onError: (c) =>
        apiError(c, 413, "live.asset_too_large", `The picture is too large (max ${LIVE_ASSET_MB} MB)`, {
          max: LIVE_ASSET_MB,
        }),
    }),
  );

  const docs = (): LiveDocs => {
    const live = deps.extras?.live;
    if (!live) throw new Error("live files are not configured on this server");
    return live;
  };
  const liveDeps = (): LiveDeps => {
    const found = deps.extras?.liveDeps;
    if (!found) throw new Error("live files are not configured on this server");
    return found;
  };
  const artifacts = (): ArtifactDeps => {
    const found = deps.extras?.artifacts;
    if (!found) throw new Error("artifacts are not configured on this server");
    return found;
  };
  const person = (userId: string) => ({ type: "person" as const, userId });

  /** The live file as the person reads it, or not found (never "forbidden": a file out of reach doesn't exist). */
  const reading = (userId: string, orgId: string, fileId: string) =>
    requireLiveFile(artifacts(), person(userId), orgId, fileId);
  /** The same, for a change: a file read-only now (in the trash, its workspace closing) takes none (`live.read_only`). */
  const changing = (userId: string, orgId: string, fileId: string) =>
    requireLiveFile(artifacts(), person(userId), orgId, fileId, { write: true });
  /** One file with what the viewer may do with it and who can see it. */
  const withFacts = async <T extends Parameters<typeof withPersonFacts>[3][number]>(
    userId: string,
    orgId: string,
    a: T,
  ) => {
    const [out] = await withPersonFacts(db, userId, orgId, [a]);
    if (!out) throw new Error("withPersonFacts returned nothing for one file");
    return out;
  };

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/live-files",
      tags,
      security,
      summary: "Make a spreadsheet, a presentation or a canvas (in the Drive, or in a conversation you're in)",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            kind: LiveKind,
            title: z.string().trim().min(1).max(200),
            channelId: z.uuid().nullable().optional(),
            threadId: z.uuid().nullable().optional(),
          }),
        ),
      },
      responses: { 201: json(Artifact, "Created"), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const input = c.req.valid("json");
      const userId = c.get("user").id;
      const created = await createLiveFile(liveDeps(), person(userId), orgId, {
        kind: input.kind,
        title: input.title,
        channelId: input.channelId ?? null,
        threadId: input.threadId ?? null,
      });
      return c.json(await withFacts(userId, orgId, created), 201);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/artifacts/{artifactId}/live",
      tags,
      security,
      summary: "A live file's document as it stands now, to open it with (the socket catches up from it)",
      request: {
        params: ArtifactParams,
        query: z.object({
          version: z.coerce.number().int().min(1).optional().openapi({
            description: "A saved version instead, to look at read-only (its history, ADR 0196 §7): `seq` 0, `view`.",
          }),
        }),
      },
      responses: { 200: json(LiveState), ...errors },
    }),
    async (c) => {
      const { orgId, artifactId } = c.req.valid("param");
      const { version } = c.req.valid("query");
      const access = await reading(c.get("user").id, orgId, artifactId);
      if (version !== undefined) {
        const snapshot = await liveSnapshotOf(artifacts(), orgId, artifactId, version);
        return c.json({ state: base64(snapshot), seq: 0, mode: "view" as const, kind: access.kind }, 200);
      }
      const { state, seq } = await docs().state(orgId, artifactId);
      return c.json({ state: base64(state), seq, mode: access.mode, kind: access.kind }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/artifacts/{artifactId}/live/rename",
      tags,
      security,
      summary: "Rename a live file from its page (its title only: no version is written)",
      request: { params: ArtifactParams, body: body(z.object({ title: z.string().trim().min(1).max(200) })) },
      responses: { 200: json(Artifact), ...errors },
    }),
    async (c) => {
      const { orgId, artifactId } = c.req.valid("param");
      const userId = c.get("user").id;
      const saved = await renameLiveFile(artifacts(), person(userId), orgId, artifactId, c.req.valid("json").title);
      return c.json(await withFacts(userId, orgId, saved), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/artifacts/{artifactId}/live/duplicate",
      tags,
      security,
      summary: "Duplicate a live file: a copy at its head, with its pictures, beside it",
      request: {
        params: ArtifactParams,
        body: body(z.object({ title: z.string().trim().max(200).optional() })),
      },
      responses: { 201: json(Artifact, "Created"), ...errors },
    }),
    async (c) => {
      const { orgId, artifactId } = c.req.valid("param");
      const userId = c.get("user").id;
      const made = await duplicateLiveFile(artifacts(), person(userId), orgId, artifactId, c.req.valid("json"));
      return c.json(await withFacts(userId, orgId, made), 201);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/artifacts/{artifactId}/live/versions",
      tags,
      security,
      summary: "Save a version of a live file now, with a name (ADR 0196 §7)",
      request: {
        params: ArtifactParams,
        body: body(z.object({ note: z.string().trim().max(500).nullable().optional() })),
      },
      responses: {
        200: json(
          z.object({
            version: z.number().int().nullable().openapi({ description: "The version written; null: nothing new." }),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, artifactId } = c.req.valid("param");
      const userId = c.get("user").id;
      await changing(userId, orgId, artifactId);
      const { note } = c.req.valid("json");
      const version = await docs().checkpoint(orgId, artifactId, {
        author: { type: "person", id: userId },
        note: note || undefined,
        force: true,
      });
      return c.json({ version }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/artifacts/{artifactId}/live/restore",
      tags,
      security,
      summary: "Bring a live file back to a version: everyone in it sees it go back, and a version says so",
      request: { params: ArtifactParams, body: body(z.object({ version: z.number().int().min(1) })) },
      responses: {
        200: json(z.object({ version: z.number().int().openapi({ description: "The version that records it." }) })),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, artifactId } = c.req.valid("param");
      const userId = c.get("user").id;
      await changing(userId, orgId, artifactId);
      const version = await docs().restore(orgId, artifactId, c.req.valid("json").version, {
        type: "person",
        id: userId,
      });
      return c.json({ version }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/live/presence",
      tags,
      security,
      summary: "Who is in each of these live files now (the Drive's and messages' cards)",
      description: "Files the person can't read are left out, as are people who hide their presence.",
      request: {
        params: OrgParams,
        query: z.object({
          ids: z
            .string()
            .max(PRESENCE_IDS * 37)
            .transform((v) =>
              v
                .split(",")
                .map((x) => x.trim())
                .filter(Boolean),
            )
            .pipe(z.array(z.uuid()).max(PRESENCE_IDS))
            .openapi({ type: "string", description: `Comma-separated file ids (at most ${PRESENCE_IDS}).` }),
        }),
      },
      responses: {
        200: json(
          z.object({
            presence: z
              .record(z.string(), z.array(PresenceEntry))
              .openapi({ description: "By file id: who is in it, people and agents." }),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const { ids } = c.req.valid("query");
      const userId = c.get("user").id;
      await requireActiveMembership(db, userId, orgId);
      const wanted = [...new Set(ids)];
      // Only files this person reads: who is in a file is as private as the file.
      const seen = wanted.length
        ? await db
            .select({ id: schema.artifacts.id })
            .from(schema.artifacts)
            .where(
              and(
                eq(schema.artifacts.orgId, orgId),
                inArray(schema.artifacts.id, wanted),
                isNull(schema.artifacts.deletedAt),
                fileSeenSql(sql`${userId}::text`),
              ),
            )
        : [];
      const found = docs().presenceOf(seen.map((row) => row.id));
      const byFile = new Map<string, Present[]>();
      for (const { id } of seen) byFile.set(id, onePerPeer(found.get(id) ?? []));
      // Someone who hides their presence (ADR 0084) is in no file to anyone else either.
      const others = [
        ...new Set(
          [...byFile.values()].flatMap((list) =>
            list.filter((p) => p.kind === "person" && p.id !== userId).map((p) => p.id),
          ),
        ),
      ];
      const hidden = new Set(
        others.length === 0
          ? []
          : (
              await db
                .select({ userId: schema.organizationMembers.userId })
                .from(schema.organizationMembers)
                .where(
                  and(
                    eq(schema.organizationMembers.orgId, orgId),
                    inArray(schema.organizationMembers.userId, others),
                    eq(schema.organizationMembers.availability, "hidden"),
                  ),
                )
            ).map((row) => row.userId),
      );
      const presence: Record<string, Present[]> = {};
      for (const [id, list] of byFile) {
        presence[id] = list.filter((p) => p.kind !== "person" || p.id === userId || !hidden.has(p.id));
      }
      return c.json({ presence }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/artifacts/{artifactId}/marks",
      tags,
      security,
      summary: "Add the picture of a comment's place on a picture, a video or a PDF (ADR 0208)",
      description:
        "What the app took of the place a comment points at: what was marked, or the whole picture, frame or page with the mark drawn. PNG, JPEG or WebP, at most 2 MB, told by its bytes. Whoever reads the file adds one; the message names it in `liveRef.selection` (`crop`, `frame`), and it is served like a live file's pictures (`GET …/assets/{assetId}`).",
      request: {
        params: ArtifactParams,
        body: { required: true, content: { "multipart/form-data": { schema: z.object({ file: fileField }) } } },
      },
      responses: { 201: json(LiveAsset, "Added"), 413: errorResponse("The picture is too large"), ...errors },
    }),
    async (c) => {
      const { orgId, artifactId } = c.req.valid("param");
      const { file } = c.req.valid("form");
      if (!(file instanceof File)) {
        return apiError(c, 400, "artifact.file_required", "send the picture in the field file");
      }
      if (file.size > MARK_PICTURE_BYTES) {
        return apiError(c, 413, "live.asset_too_large", "The picture is too large (max 2 MB)", { max: 2 });
      }
      const userId = c.get("user").id;
      await requireActiveMembership(db, userId, orgId);
      const asset = await putMarkPicture(
        artifacts(),
        person(userId),
        orgId,
        artifactId,
        new Uint8Array(await file.arrayBuffer()),
      );
      return c.json(assetView(asset), 201);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/messages/{messageId}/resolve",
      tags,
      security,
      summary: "Resolve a comment on a picture, a video or a PDF, or open it again (ADR 0208)",
      description:
        "Only a message of a file's conversation that points at a place there (`liveRef.selection` with `mark`, `time` or `page`); 400 `message.not_comment` otherwise. Whoever writes in that conversation. The message stays; its pin leaves the file. Everyone there gets `message.resolved`.",
      request: {
        params: OrgParams.extend({ messageId: z.uuid() }),
        body: { required: true, content: { "application/json": { schema: z.object({ resolved: z.boolean() }) } } },
      },
      responses: {
        200: json(z.object({ resolved: ResolvedMark.nullable() }).openapi("ResolveResult"), "Resolved, or open"),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, messageId } = c.req.valid("param");
      const { resolved } = c.req.valid("json");
      const userId = c.get("user").id;
      const mark = await resolveComment(
        { db, pubsub: deps.adapters.pubsub },
        { type: "person", userId },
        orgId,
        messageId,
        resolved,
      );
      return c.json({ resolved: mark }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/artifacts/{artifactId}/assets",
      tags,
      security,
      summary: `Add a picture to a live file (≤ ${LIVE_ASSET_MB} MB; PNG, JPEG, WebP or GIF)`,
      description: "Its type is read from its bytes. Whoever reads the file sees it, and it goes with the file.",
      request: {
        params: ArtifactParams,
        body: { required: true, content: { "multipart/form-data": { schema: z.object({ file: fileField }) } } },
      },
      responses: { 201: json(LiveAsset, "Added"), 413: errorResponse("The picture is too large"), ...errors },
    }),
    async (c) => {
      const { orgId, artifactId } = c.req.valid("param");
      const { file } = c.req.valid("form");
      if (!(file instanceof File)) {
        return apiError(c, 400, "artifact.file_required", "send the picture in the field file");
      }
      if (file.size > LIVE_ASSET_BYTES) {
        return apiError(c, 413, "live.asset_too_large", `The picture is too large (max ${LIVE_ASSET_MB} MB)`, {
          max: LIVE_ASSET_MB,
        });
      }
      const userId = c.get("user").id;
      await changing(userId, orgId, artifactId);
      const asset = await putAsset(liveDeps(), person(userId), orgId, artifactId, {
        bytes: new Uint8Array(await file.arrayBuffer()),
        contentType: file.type,
        source: "upload",
      });
      return c.json(assetView(asset), 201);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/artifacts/{artifactId}/assets/copy",
      tags,
      security,
      summary: "Copy a picture into a live file: from the Drive (a file you read) or from another live file",
      request: {
        params: ArtifactParams,
        body: body(z.union([AssetSource, z.object({ from: AssetSource })])),
      },
      responses: { 201: json(LiveAsset, "Copied"), ...errors },
    }),
    async (c) => {
      const { orgId, artifactId } = c.req.valid("param");
      const input = c.req.valid("json");
      const from = "from" in input ? input.from : input;
      const userId = c.get("user").id;
      await changing(userId, orgId, artifactId);
      const asset = await copyAssetFrom(liveDeps(), person(userId), orgId, artifactId, from);
      return c.json(assetView(asset), 201);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/artifacts/{artifactId}/fonts",
      tags,
      security,
      summary: "A live file's own fonts (fonts brought from the Drive), for its font list",
      description: "One row per font file, regular faces first; each is served like a picture (`GET …/assets/{id}`).",
      request: { params: ArtifactParams },
      responses: { 200: json(z.object({ fonts: z.array(LiveFileFont) }), "The file's fonts"), ...errors },
    }),
    async (c) => {
      const { orgId, artifactId } = c.req.valid("param");
      const fonts = await readFileFonts(liveDeps(), person(c.get("user").id), orgId, artifactId);
      return c.json({ fonts: fonts.map((f) => ({ id: f.id, ...fontView(f) })) }, 200);
    },
  );

  // A picture's or a font's bytes: named by its id and never changed, so cached for good; only ever served as itself.
  app.get("/organizations/:orgId/artifacts/:artifactId/assets/:assetId", async (c) => {
    const orgId = c.req.param("orgId");
    const artifactId = c.req.param("artifactId");
    const assetId = c.req.param("assetId");
    const notFound = () => apiError(c, 404, "artifact.not_found", "Picture not found");
    if (!isUuid(orgId) || !isUuid(artifactId) || !isUuid(assetId)) return notFound();
    const asset = await getAsset(liveDeps(), person(c.get("user").id), orgId, artifactId, assetId);
    const svg = asset?.contentType === SVG_ASSET;
    if (!asset || !(ASSET_TYPES.has(asset.contentType) || svg)) return notFound();
    const etag = `"${asset.sha256}"`;
    const headers: Record<string, string> = {
      "content-type": asset.contentType,
      "x-content-type-options": "nosniff",
      "content-security-policy": svg ? SVG_CSP : "sandbox",
      "cache-control": "private, max-age=31536000, immutable",
      etag,
    };
    if (c.req.header("if-none-match") === etag) return new Response(null, { status: 304, headers });
    const bytes = "bytes" in asset ? asset.bytes : undefined;
    if (bytes) {
      return new Response(bytes as Uint8Array<ArrayBuffer>, {
        status: 200,
        headers: { ...headers, "content-length": String(bytes.byteLength) },
      });
    }
    const stream = "stream" in asset ? asset.stream : undefined;
    if (!stream) return notFound();
    return new Response(stream as ReadableStream, {
      status: 200,
      headers: { ...headers, "content-length": String(asset.size) },
    });
  });

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/artifacts/{artifactId}/live/ask",
      tags,
      security,
      summary: "Ask an agent about a live file, from inside it (Ask an agent)",
      description:
        "Sends the person's message to the agent in the file's own conversation (ADR 0199; a DM carrying the file when " +
        "the agent can't work on it there), with what is selected, so the agent's tools act on it while everyone in it " +
        "watches (ADR 0196 §6). Kept for older apps: the apps write in the file's conversation themselves.",
      request: {
        params: ArtifactParams,
        body: body(
          z.object({
            agentId: z.uuid(),
            text: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
            selection: LiveSelection.optional(),
          }),
        ),
      },
      responses: {
        201: json(
          z.object({
            id: z.string().openapi({ description: "The message sent." }),
            channelId: z.string(),
            threadId: z.string().nullable(),
          }),
          "Sent",
        ),
        ...errors,
        429: errorResponse("Too many messages (`rate_limited`)"),
      },
    }),
    async (c) => {
      const { orgId, artifactId } = c.req.valid("param");
      const user = c.get("user");
      const limit = await deps.adapters.rateLimiter.consume(`post:${user.id}`, { limit: 30, windowMs: 10_000 });
      if (!limit.allowed) return apiError(c, 429, "rate_limited", "Slow down");
      await reading(user.id, orgId, artifactId);
      const sent = await askAgentAbout(
        {
          ...liveDeps(),
          pubsub: deps.adapters.pubsub,
          judge: deps.extras?.context?.judge,
          talker: deps.extras?.talker,
        },
        user.id,
        orgId,
        artifactId,
        c.req.valid("json"),
      );
      deps.wakeWorkers?.();
      return c.json({ id: sent.id, channelId: sent.channelId, threadId: sent.threadId ?? null }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/artifacts/{artifactId}/preview",
      tags,
      security,
      summary: "An uploaded Office file as the apps draw it (ADR 0198): a workbook, a deck or a document's HTML",
      description:
        "Read by the server, never run: the apps draw a workbook with their spreadsheet view, a deck with their " +
        "slides view, and a document's clean HTML only in an isolated frame. A deck's pictures come from …/preview/media.",
      request: {
        params: ArtifactParams,
        query: z.object({ version: z.coerce.number().int().min(1).optional() }),
      },
      responses: {
        200: json(
          z.record(z.string(), z.unknown()).openapi("OfficePreview", {
            type: "object",
            description: "`kind` says which: workbook, deck or document.",
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, artifactId } = c.req.valid("param");
      const { version } = c.req.valid("query");
      const preview = await officePreview(liveDeps(), c.get("user").id, orgId, artifactId, version);
      return c.json(withMediaUrls(preview, orgId, artifactId, version), 200);
    },
  );

  // A picture inside an uploaded deck (ADR 0198), as the preview names it: only ever served as a picture.
  app.get("/organizations/:orgId/artifacts/:artifactId/preview/media/:name", async (c) => {
    const orgId = c.req.param("orgId");
    const artifactId = c.req.param("artifactId");
    const name = c.req.param("name");
    const raw = c.req.query("version");
    const version = raw && /^[1-9]\d{0,8}$/.test(raw) ? Number(raw) : undefined;
    const notFound = () => apiError(c, 404, "artifact.not_found", "Picture not found");
    if (!isUuid(orgId) || !isUuid(artifactId) || name.length > 200) return notFound();
    const preview = await officePreview(liveDeps(), c.get("user").id, orgId, artifactId, version);
    const media = mediaOf(preview)?.[name];
    if (!media?.bytes || !ASSET_TYPES.has(media.type)) return notFound();
    return new Response(media.bytes as Uint8Array<ArrayBuffer>, {
      status: 200,
      headers: {
        "content-type": media.type,
        "content-length": String(media.bytes.byteLength),
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox",
        // A version never changes; without one it is the newest, which may.
        "cache-control": version ? "private, max-age=31536000, immutable" : "private, no-cache",
      },
    });
  });

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/artifacts/{artifactId}/open-as",
      tags,
      security,
      summary: "Edit an uploaded Office file as a live file (ADR 0198): a new spreadsheet, presentation or document",
      description:
        "Made beside the upload (same conversation, same sharing) with a note saying where it came from; the upload " +
        "stays as it was.",
      request: { params: ArtifactParams, body: body(z.object({}).passthrough()) },
      responses: { 201: json(Artifact, "Created"), ...errors },
    }),
    async (c) => {
      const { orgId, artifactId } = c.req.valid("param");
      const userId = c.get("user").id;
      const made = await openAsLive(liveDeps(), userId, orgId, artifactId);
      return c.json(await withFacts(userId, orgId, made), 201);
    },
  );

  return app;
}

/** One entry per person or agent (several tabs or devices are one face), editing over viewing. */
function onePerPeer(list: readonly Present[]): Present[] {
  const byPeer = new Map<string, Present>();
  for (const p of list) {
    const key = `${p.kind}:${p.id}`;
    const seen = byPeer.get(key);
    if (!seen || (seen.mode === "viewing" && p.mode === "editing")) {
      byPeer.set(key, { kind: p.kind, id: p.id, mode: p.mode });
    }
  }
  return [...byPeer.values()];
}

/** What the apps get of a picture or a font. */
function assetView(asset: {
  id: string;
  contentType: string;
  size: number;
  width: number | null;
  height: number | null;
  font?: { family: string; style: string; weight: number; italic: boolean } | null;
}) {
  return {
    id: asset.id,
    contentType: asset.contentType,
    size: asset.size,
    width: asset.width ?? null,
    height: asset.height ?? null,
    font: asset.font ? fontView(asset.font) : null,
  };
}

/** A font as the apps get it: what names and draws it, not its license words. */
function fontView(font: { family: string; style: string; weight: number; italic: boolean }) {
  return { family: font.family, style: font.style, weight: font.weight, italic: font.italic };
}

type Media = Record<string, { type: string; bytes?: Uint8Array; url?: string }>;

/** A deck preview's pictures (`DeckData.media`), wherever the preview keeps its deck. */
function mediaOf(preview: unknown): Media | null {
  const p = preview as { media?: unknown; deck?: { media?: unknown } } | null;
  const media = p?.deck?.media ?? p?.media;
  return media && typeof media === "object" ? (media as Media) : null;
}

/**
 * The preview as JSON: a deck's pictures point at `…/preview/media/{name}` instead of carrying their bytes (bytes
 * don't go in JSON, and the apps load pictures by address).
 */
function withMediaUrls(preview: unknown, orgId: string, artifactId: string, version: number | undefined) {
  const media = mediaOf(preview);
  if (!media) return preview as Record<string, unknown>;
  const at = version ? `?version=${version}` : "";
  const urls: Media = {};
  for (const [name, m] of Object.entries(media)) {
    urls[name] = {
      type: m.type,
      url:
        m.url ??
        `/api/app/organizations/${orgId}/artifacts/${artifactId}/preview/media/${encodeURIComponent(name)}${at}`,
    };
  }
  const p = preview as { media?: unknown; deck?: Record<string, unknown> };
  return (p.deck ? { ...p, deck: { ...p.deck, media: urls } } : { ...p, media: urls }) as Record<string, unknown>;
}
