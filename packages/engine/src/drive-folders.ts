import { and, type Database, eq, inArray, isNull, rowsOf, schema, sql } from "@agenteschat/db";
import { type ArtifactActor, type ArtifactAuthor, type ArtifactDeps, deleteArtifact } from "./artifacts";
import { recordAudit } from "./audit";
import { UUID } from "./authority";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishListChanged } from "./events";
import { can, requireActiveMembership } from "./organizations";

const { driveFolders, artifacts } = schema;

/** A Drive folder as the apps and agents see it: every one in the workspace (it is the shared Drive's structure). */
export interface FolderView {
  id: string;
  name: string;
  parentId: string | null;
  createdBy: ArtifactAuthor;
  createdAt: string;
  updatedAt: string;
}

export const FOLDER_LIMITS = { nameChars: 120, perOrg: 5000, pathDepth: 10 };

type FolderRow = typeof driveFolders.$inferSelect;

const folderView = (f: FolderRow): FolderView => ({
  id: f.id,
  name: f.name,
  parentId: f.parentId,
  createdBy: { type: f.createdByType as ArtifactAuthor["type"], id: f.createdById },
  createdAt: f.createdAt.toISOString(),
  updatedAt: f.updatedAt.toISOString(),
});

/** One line of words: "/" separates an agent's folder path, so a name never holds one. */
export function cleanFolderName(raw: string) {
  const name = raw.replace(/\//g, "-").replace(/\s+/g, " ").trim().slice(0, FOLDER_LIMITS.nameChars);
  if (!name) throw new ValidationError("A folder needs a name");
  return name;
}

const authorOf = (actor: ArtifactActor): ArtifactAuthor =>
  actor.type === "person" ? { type: "person", id: actor.userId } : { type: "agent", id: actor.agentId };

/** Arranging the Drive is adding to it: a person needs `upload_files`; an agent's `drive:write` is checked by its tool. */
async function requireArranger(db: Database, actor: ArtifactActor, orgId: string) {
  if (actor.type !== "person") return;
  const membership = await requireActiveMembership(db, actor.userId, orgId);
  if (!can(membership, "upload_files")) throw new ForbiddenError();
}

async function loadFolder(db: Database, orgId: string, id: string) {
  if (!UUID.test(id)) throw new NotFoundError("Folder not found");
  const [f] = await db
    .select()
    .from(driveFolders)
    .where(and(eq(driveFolders.orgId, orgId), eq(driveFolders.id, id)));
  if (!f) throw new NotFoundError("Folder not found");
  return f;
}

/** Every folder of the workspace, by name: the apps build the tree and the path from `parentId`. */
export async function listFolders(db: Database, actor: ArtifactActor, orgId: string): Promise<FolderView[]> {
  if (actor.type === "person") await requireActiveMembership(db, actor.userId, orgId);
  const rows = await db
    .select()
    .from(driveFolders)
    .where(eq(driveFolders.orgId, orgId))
    .orderBy(sql`lower(${driveFolders.name})`, driveFolders.id)
    .limit(FOLDER_LIMITS.perOrg);
  return rows.map(folderView);
}

export async function createFolder(
  deps: ArtifactDeps,
  actor: ArtifactActor,
  orgId: string,
  input: { name: string; parentId?: string | null },
): Promise<FolderView> {
  const { db } = deps;
  await requireArranger(db, actor, orgId);
  const name = cleanFolderName(input.name);
  const parentId = input.parentId ? (await loadFolder(db, orgId, input.parentId)).id : null;
  const [count] = rowsOf<{ n: number }>(
    await db.execute(sql`select count(*)::int as n from drive_folders where org_id = ${orgId}::uuid`),
  );
  if (Number(count?.n ?? 0) >= FOLDER_LIMITS.perOrg) {
    throw new ValidationError(`The Drive holds at most ${FOLDER_LIMITS.perOrg} folders`);
  }
  const author = authorOf(actor);
  const row = await db.transaction(async (tx) => {
    const [f] = await tx
      .insert(driveFolders)
      .values({ orgId, parentId, name, createdByType: author.type, createdById: author.id })
      .returning();
    if (!f) throw new Error("folder insert returned nothing");
    await recordAudit(tx, {
      orgId,
      actor: author,
      action: "drive.folder_created",
      target: { type: "drive_folder", id: f.id },
      details: { name, parentId },
    });
    return f;
  });
  await publishListChanged(deps.pubsub, orgId, "artifacts");
  return folderView(row);
}

/** The folder and every folder inside it, at any depth. */
async function subtree(db: Database, orgId: string, id: string) {
  const rows = rowsOf<{ id: string }>(
    await db.execute(sql`with recursive t(id) as (
      select ${id}::uuid
      union select f.id from drive_folders f join t on f.parent_id = t.id where f.org_id = ${orgId}::uuid
    ) select id from t`),
  );
  return rows.map((r) => r.id);
}

/** Rename a folder, or move it into another one (or to the top, `parentId: null`), never into itself. */
export async function updateFolder(
  deps: ArtifactDeps,
  userId: string,
  orgId: string,
  id: string,
  input: { name?: string; parentId?: string | null },
): Promise<FolderView> {
  const { db } = deps;
  const actor: ArtifactActor = { type: "person", userId };
  await requireArranger(db, actor, orgId);
  const current = await loadFolder(db, orgId, id);
  const patch: Partial<FolderRow> = { updatedAt: new Date() };
  if (input.name !== undefined) patch.name = cleanFolderName(input.name);
  if (input.parentId !== undefined) {
    const parentId = input.parentId ? (await loadFolder(db, orgId, input.parentId)).id : null;
    if (parentId && (await subtree(db, orgId, id)).includes(parentId)) {
      throw new ValidationError("A folder can't go inside itself", "drive.folder_into_itself");
    }
    patch.parentId = parentId;
  }
  const row = await db.transaction(async (tx) => {
    const [f] = await tx.update(driveFolders).set(patch).where(eq(driveFolders.id, current.id)).returning();
    if (!f) throw new NotFoundError("Folder not found");
    await recordAudit(tx, {
      orgId,
      actor: authorOf(actor),
      action: "drive.folder_changed",
      target: { type: "drive_folder", id },
      details: { from: { name: current.name, parentId: current.parentId }, name: f.name, parentId: f.parentId },
    });
    return f;
  });
  await publishListChanged(deps.pubsub, orgId, "artifacts");
  return folderView(row);
}

/**
 * Deletes a folder with what is inside: its folders go, the files this person may delete go to the trash (restored,
 * they come back at the Drive's top level), and the files they may not delete, or don't see, move up to where the
 * folder was, so nobody loses a file to someone else's delete.
 */
export async function deleteFolder(deps: ArtifactDeps, userId: string, orgId: string, id: string) {
  const { db } = deps;
  await requireArranger(db, { type: "person", userId }, orgId);
  const folder = await loadFolder(db, orgId, id);
  const ids = await subtree(db, orgId, id);
  const inside = await db
    .select({ id: artifacts.id })
    .from(artifacts)
    .where(and(eq(artifacts.orgId, orgId), inArray(artifacts.folderId, ids), isNull(artifacts.deletedAt)));
  let trashed = 0;
  const kept: string[] = [];
  for (const file of inside) {
    try {
      await deleteArtifact(deps, userId, orgId, file.id);
      trashed++;
    } catch (error) {
      if (!(error instanceof ForbiddenError || error instanceof NotFoundError)) throw error;
      kept.push(file.id);
    }
  }
  await db.transaction(async (tx) => {
    if (kept.length > 0) {
      await tx.update(artifacts).set({ folderId: folder.parentId }).where(inArray(artifacts.id, kept));
    }
    await tx.delete(driveFolders).where(eq(driveFolders.id, folder.id));
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: userId },
      action: "drive.folder_deleted",
      target: { type: "drive_folder", id },
      details: { name: folder.name, folders: ids.length, trashed, keptOut: kept.length },
    });
  });
  await publishListChanged(deps.pubsub, orgId, "artifacts");
  return { trashed, kept: kept.length };
}

/**
 * An agent's folder by its path ("Reports/2026"): each part found by name (any case) under the one before, made when
 * missing, like `mkdir -p` (with `create: false`, null instead). Returns the last one's id.
 */
export async function folderByPath(
  deps: ArtifactDeps,
  actor: ArtifactActor,
  orgId: string,
  path: string,
  options: { create: false },
): Promise<string | null>;
export async function folderByPath(
  deps: ArtifactDeps,
  actor: ArtifactActor,
  orgId: string,
  path: string,
): Promise<string>;
export async function folderByPath(
  deps: ArtifactDeps,
  actor: ArtifactActor,
  orgId: string,
  path: string,
  options: { create: boolean } = { create: true },
): Promise<string | null> {
  const parts = path
    .split("/")
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (parts.length === 0) throw new ValidationError("folder: give a folder name or a path such as Reports/2026");
  if (parts.length > FOLDER_LIMITS.pathDepth) {
    throw new ValidationError(`folder: at most ${FOLDER_LIMITS.pathDepth} levels`);
  }
  let parentId: string | null = null;
  for (const part of parts) {
    const name = cleanFolderName(part);
    const [found] = await deps.db
      .select({ id: driveFolders.id })
      .from(driveFolders)
      .where(
        and(
          eq(driveFolders.orgId, orgId),
          parentId ? eq(driveFolders.parentId, parentId) : isNull(driveFolders.parentId),
          sql`lower(${driveFolders.name}) = lower(${name})`,
        ),
      )
      .orderBy(driveFolders.id)
      .limit(1);
    if (!found && !options.create) return null;
    parentId = found ? found.id : (await createFolder(deps, actor, orgId, { name, parentId })).id;
  }
  return parentId;
}

/** "Reports/2026" for a folder id, for an agent to read back; null when it is gone. */
export async function folderPath(db: Database, orgId: string, id: string | null) {
  if (!id) return null;
  const rows = rowsOf<{ name: string }>(
    await db.execute(sql`with recursive up(id, parent_id, name, depth) as (
      select id, parent_id, name, 0 from drive_folders where id = ${id}::uuid and org_id = ${orgId}::uuid
      union all select f.id, f.parent_id, f.name, up.depth + 1 from drive_folders f join up on f.id = up.parent_id
    ) select name from up order by depth desc`),
  );
  return rows.length > 0 ? rows.map((r) => r.name).join("/") : null;
}
