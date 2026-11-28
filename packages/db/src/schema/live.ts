import { bigint, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { artifacts } from "./storage";
import { organizations } from "./tenancy";

/**
 * Live files (ADR 0196 §4): one row per spreadsheet, presentation or canvas, holding its Yjs document as it stood at
 * the last compaction (`state`, base64 of one Yjs update, like every byte column here) and the number of the newest
 * change (`head_seq`, taken under this row's lock). The changes after `compacted_seq` are rows of
 * `live_doc_updates`; a job folds them into `state` and deletes them. `preview` is the small projection cards and
 * the Drive draw (the top-left cells, the first slide, the canvas's first shapes), refreshed with the compaction.
 */
export const liveDocs = pgTable(
  "live_docs",
  {
    artifactId: uuid()
      .primaryKey()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** `spreadsheet` | `slides` | `canvas`: the artifact's kind, kept beside the document it shapes. */
    kind: text().notNull(),
    state: text().notNull(),
    stateBytes: integer().notNull().default(0),
    headSeq: bigint({ mode: "number" }).notNull().default(0),
    compactedSeq: bigint({ mode: "number" }).notNull().default(0),
    preview: jsonb().$type<Record<string, unknown>>(),
    /** The last change stored (people's, agents' or the server's own). */
    editedAt: timestamp({ withTimezone: true }),
    /**
     * Who made that last change (`person` | `agent` | `system`), their id and an agent's run: the author of a version
     * written after a quiet spell, and the Drive's "last edited by" once the changes themselves are compacted away.
     */
    editedByType: text(),
    editedById: text(),
    editedRunId: uuid(),
    /** The last version written of it (`artifact_versions`), and the change it was written at. */
    checkpointAt: timestamp({ withTimezone: true }),
    checkpointSeq: bigint({ mode: "number" }).notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.orgId)],
);

/**
 * The changes to a live file since its last compaction, in order (ADR 0196 §4): each row is the Yjs updates one
 * person, agent or the server made within one short window, merged. Who made it is kept as text, like
 * `artifact_versions.author_id` (a person's id is not a uuid), with no key to them: the history outlives them.
 */
export const liveDocUpdates = pgTable(
  "live_doc_updates",
  {
    artifactId: uuid()
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    seq: bigint({ mode: "number" }).notNull(),
    /** Base64 of the merged Yjs update. */
    update: text().notNull(),
    bytes: integer().notNull(),
    /** `person` | `agent` | `system`. */
    actorType: text().notNull(),
    actorId: text(),
    runId: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.artifactId, t.seq] }), index().on(t.orgId)],
);

/**
 * A picture that belongs to a live file (ADR 0196 §8): stored through the workspace's storage like a version's bytes,
 * counted in its storage, served only to whoever reads the file and purged with it. An asset's id is unique within
 * its file: a copy of the file (or of a shape pasted into another file) keeps the ids its document points at.
 */
export const liveAssets = pgTable(
  "live_assets",
  {
    id: uuid()
      .notNull()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    artifactId: uuid()
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    /** The storage it was written to (null = platform). */
    storageConfigId: uuid(),
    blobKey: text().notNull(),
    /**
     * Sniffed from the bytes, never the type a client declared: `image/png`, `image/jpeg`, `image/webp`, `image/gif`,
     * or `image/svg+xml` for an SVG stored as the sanitizer rebuilt it.
     */
    contentType: text().notNull(),
    size: integer().notNull(),
    sha256: text().notNull(),
    width: integer(),
    height: integer(),
    /** `upload` | `generated` | `copied` | `imported` | `drawn` (an agent's SVG) | `web` (downloaded). */
    source: text().notNull(),
    /** A picture from the web: its address and the credit an agent gave it (author, license, site). */
    origin: jsonb().$type<{ url: string; credit?: string }>(),
    /**
     * A font of the file (ADR 0220 §2), as its own file says: its family and style names, weight, slant and what its
     * license lets documents do with it (`installable`, `editable`, `preview`, `restricted`). Null for a picture.
     */
    font: jsonb().$type<{ family: string; style: string; weight: number; italic: boolean; embedding: string }>(),
    /** `person` | `agent` | `system`. */
    createdByType: text(),
    createdById: text(),
    runId: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.artifactId, t.id] }), index().on(t.orgId)],
);

/**
 * A request for pictures on a canvas (ADR 0197): placed as a frame of placeholders at once, then made by the
 * `live.image` job through the Model Gateway. `references` are the asset ids it started from (variations and edits),
 * `shape_ids` the placeholders it fills, `asset_ids` what it made.
 */
export const liveImageRequests = pgTable(
  "live_image_requests",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    artifactId: uuid()
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    /** `person` | `agent`. */
    requestedByType: text().notNull(),
    requestedById: text(),
    runId: uuid(),
    prompt: text().notNull(),
    model: text().notNull(),
    count: integer().notNull().default(1),
    aspect: text().notNull().default("1:1"),
    references: jsonb().$type<string[]>().notNull().default([]),
    shapeIds: jsonb().$type<string[]>().notNull().default([]),
    frameId: text(),
    /** `queued` | `running` | `done` | `failed`. */
    status: text().notNull().default("queued"),
    /** Why it failed: `no_key`, `budget`, `limit`, `blocked`, `provider` or `too_many`. */
    error: text(),
    assetIds: jsonb().$type<string[]>().notNull().default([]),
    costNanoUsd: bigint({ mode: "number" }).notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.orgId, t.requestedById, t.createdAt), index().on(t.artifactId)],
);
