import { and, type Database, eq, inArray, schema } from "@agenteschat/db";
import { z } from "zod";
import { recordAudit } from "../audit";
import { sha256 } from "../crypto";
import { decodeCursor, encodeCursor } from "../cursor";
import { ConflictError, TooManyError, ValidationError } from "../errors";
import { can, getMembership } from "../organizations";
import {
  createWikiPage,
  deleteWikiPage,
  getWikiPage,
  listWikiPages,
  noteThroughApp,
  updateWikiPage,
  WIKI_LIMITS,
  WIKI_TRASH_DAYS,
  type WikiActor,
  type WikiAuthor,
  type WikiDeps,
  type WikiPageSummary,
  type WikiPageView,
  WikiVersionConflictError,
} from "../wiki";
import type { AppPrincipal } from "./grants";
import { type AppsToolDeps, AppToolError, cleanUntrusted, type RegisterTool } from "./tools";
import { appsUrls } from "./urls";

const { users, agents } = schema;

/**
 * The wiki on `/mcp` (ADR 0119 addendum of 2026-11-16): a script or an AI app keeps pages current as the person.
 * Reads with `read`, writes with `manage`, each through the engine call the web app makes, so a page's audience, its
 * editors, a lock and `edit_wiki` hold as they do in the app. Writes are audited with the app's name, and each
 * version's note says it came through the app.
 */

export const APP_WIKI_TOOL_NAMES = [
  "list_wiki_pages",
  "read_wiki_page",
  "create_wiki_page",
  "update_wiki_page",
  "delete_wiki_page",
] as const;

/** Wiki writes per person and workspace, across their apps: a vault of a few hundred notes syncs on its first day. */
const WRITE_LIMITS = [
  { limit: 60, windowMs: 60_000 },
  { limit: 1_000, windowMs: 86_400_000 },
];

const PAGE = z.string().trim().min(1).max(200).describe("The page's slug, title or id (from list_wiki_pages)");
const FOLDER = z.string().max(WIKI_LIMITS.folder).describe('A folder path, as "Processos/Vendas"');
const TAGS = z.array(z.string().max(40)).max(WIKI_LIMITS.tags).describe("The page's tags, all of them");
/** A page of results: its offset, and the filters it was made with (hashed). */
const Cursor = z.tuple([z.number().int().min(0), z.string()]);

/** The names of the people and agents who wrote, by `person:<id>` and `agent:<id>`. */
async function authorNames(db: Database, orgId: string, authors: WikiAuthor[]) {
  const ids = (type: WikiAuthor["type"]) => [...new Set(authors.filter((a) => a.type === type).map((a) => a.id))];
  const people = ids("person");
  const bots = ids("agent");
  const [personRows, agentRows] = await Promise.all([
    people.length > 0 ? db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, people)) : [],
    bots.length > 0
      ? db
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(and(eq(agents.orgId, orgId), inArray(agents.id, bots)))
      : [],
  ]);
  return new Map([
    ...personRows.map((u) => [`person:${u.id}`, u.name] as const),
    ...agentRows.map((a) => [`agent:${a.id}`, a.name] as const),
  ]);
}

export function registerWikiTools(deps: AppsToolDeps, p: AppPrincipal, tool: RegisterTool) {
  const base = `${appsUrls(deps.publicUrl).issuer}/org/${p.orgId}/wiki`;
  const person: WikiActor = { type: "person", userId: p.userId };
  const wiki: WikiDeps = { db: deps.db, pubsub: deps.pubsub };
  const name = p.personName;
  /** Titles, folders and tags others wrote: short, cleaned of hidden characters. */
  const plain = (text: string, max: number) => cleanUntrusted(text, max).text;

  const allow = async () => {
    for (const [i, rule] of WRITE_LIMITS.entries()) {
      const r = await deps.rateLimiter.consume(`mcp:wiki:${i}:${p.userId}:${p.orgId}`, rule);
      if (!r.allowed) throw new TooManyError("Too many wiki changes from apps.");
    }
  };

  /** Audited as the person through the app, beside the engine's own `wiki.page_*` row. */
  const audited = (
    action: "apps.created" | "apps.updated" | "apps.deleted",
    id: string,
    details: Record<string, unknown>,
  ) =>
    recordAudit(deps.db, {
      orgId: p.orgId,
      actor: { type: "person", id: p.userId },
      action,
      target: { type: "wiki_page", id },
      details: { grantId: p.grantId, client: p.app.name, ...details },
    });

  const pageOut = (s: WikiPageSummary) => ({
    id: s.id,
    slug: s.slug,
    title: plain(s.title, WIKI_LIMITS.title),
    folder: plain(s.folder, WIKI_LIMITS.folder),
    version: s.version,
    url: `${base}/${s.slug}`,
  });

  const withAuthor = (s: WikiPageSummary, names: Map<string, string>) => ({
    ...pageOut(s),
    updated_at: s.updatedAt,
    updated_by: { kind: s.updatedBy.type, name: names.get(`${s.updatedBy.type}:${s.updatedBy.id}`) ?? "unknown" },
  });

  tool(
    "list_wiki_pages",
    {
      scope: "read",
      title: "List wiki pages",
      description: `Lists the wiki pages ${name} can see in this workspace, most recently changed first, without their text: slug, title, folder, version, and who changed each one last and when. With folder, only the pages in that folder and its subfolders. With updated_since, only the pages changed since that time.`,
      input: z
        .object({
          folder: FOLDER.optional(),
          updated_since: z.iso
            .datetime({ offset: true })
            .optional()
            .describe('A time in ISO 8601, as "2026-11-16T09:00:00Z"'),
          limit: z.number().int().min(1).max(100).optional().describe("Pages per result, 1 to 100 (default 50)"),
          cursor: z.string().max(200).optional().describe("next_cursor of the previous result"),
        })
        .strict(),
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: false,
    },
    async (args) => {
      const key = sha256(JSON.stringify([args.folder ?? "", args.updated_since ?? ""])).slice(0, 12);
      let offset = 0;
      if (args.cursor) {
        const [at, made] = decodeCursor(args.cursor, Cursor);
        if (made !== key)
          throw new ValidationError("This cursor belongs to another query. Start again without cursor.");
        offset = at;
      }
      const size = args.limit ?? 50;
      const rows = await listWikiPages(deps.db, person, p.orgId, {
        folder: args.folder,
        updatedSince: args.updated_since ? new Date(args.updated_since) : undefined,
        offset,
        limit: size + 1,
      });
      const shown = rows.slice(0, size);
      const names = await authorNames(
        deps.db,
        p.orgId,
        shown.map((s) => s.updatedBy),
      );
      return {
        pages: shown.map((s) => withAuthor(s, names)),
        next_cursor: rows.length > size ? encodeCursor([offset + size, key]) : null,
      };
    },
  );

  tool(
    "read_wiki_page",
    {
      scope: "read",
      title: "Read a wiki page",
      description: `Returns a wiki page ${name} can see, by slug, title or id: its Markdown text, version, folder and tags, and whether ${name} can edit it. update_wiki_page takes this version as base_version.`,
      input: z.object({ page: PAGE }).strict(),
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: false,
    },
    async (args) => {
      const [view, membership] = await Promise.all([
        getWikiPage(deps.db, person, p.orgId, args.page),
        getMembership(deps.db, p.userId, p.orgId),
      ]);
      const names = await authorNames(deps.db, p.orgId, [view.updatedBy]);
      // The checks of a save (`requireWriter`): `edit_wiki`, a lock, the editors' list.
      const canEdit =
        !!membership && can(membership, "edit_wiki") && (!view.locked || can(membership, "configure")) && view.canEdit;
      return {
        ...withAuthor(view, names),
        tags: view.tags.map((t) => plain(t, 40)),
        locked: view.locked,
        can_edit: canEdit,
        body: { untrusted_text: plain(view.body, WIKI_LIMITS.body) },
      };
    },
  );

  tool(
    "create_wiki_page",
    {
      scope: "manage",
      title: "Create a wiki page",
      description: `Creates a wiki page as ${name}, with its title, Markdown text, folder and tags. A page in a folder limited to some people takes the folder's access. A page with the same title that ${name} can see comes back as existing: true, unchanged, with its version. The page's history shows the version as written through this app.`,
      input: z
        .object({
          title: z.string().trim().min(1).max(WIKI_LIMITS.title).describe("The page's title"),
          body: z
            .string()
            .max(WIKI_LIMITS.body)
            .optional()
            .describe("The page's text, in Markdown; [[Title]] links another page"),
          folder: FOLDER.optional(),
          tags: TAGS.optional(),
        })
        .strict(),
      readOnly: false,
      destructive: false,
      idempotent: true,
      openWorld: false,
    },
    async (args) => {
      await allow();
      let view: WikiPageView;
      try {
        view = await createWikiPage(wiki, person, p.orgId, {
          title: args.title,
          body: args.body,
          folder: args.folder,
          tags: args.tags,
          note: noteThroughApp(p.app.name, "created the page"),
        });
      } catch (error) {
        // The title's address is a page the person sees (one they don't see never conflicts): that page, unchanged.
        const slug = error instanceof ConflictError && error.code === "slug_taken" ? error.params?.slug : null;
        if (typeof slug !== "string") throw error;
        return { ...pageOut(await getWikiPage(deps.db, person, p.orgId, slug)), existing: true };
      }
      await audited("apps.created", view.id, { name: view.title });
      return { ...pageOut(view), existing: false };
    },
  );

  tool(
    "update_wiki_page",
    {
      scope: "manage",
      title: "Change a wiki page",
      description: `Replaces the Markdown text, the tags or both of a wiki page as ${name}, as a new version. base_version is the version last read: when the page changed after it, nothing is saved and the result has version_conflict with the current version. The same text and tags save no new version (changed: false). The page's history shows the version as written through this app.`,
      input: z
        .object({
          page: PAGE,
          base_version: z
            .number()
            .int()
            .min(1)
            .describe("The page's version when it was read (from read_wiki_page or list_wiki_pages)"),
          body: z.string().max(WIKI_LIMITS.body).optional().describe("The page's whole new text, in Markdown"),
          tags: TAGS.optional(),
        })
        .strict(),
      readOnly: false,
      destructive: true,
      idempotent: true,
      openWorld: false,
    },
    async (args) => {
      if (args.body === undefined && args.tags === undefined)
        throw new ValidationError("Nothing to change: give body, tags or both.");
      await allow();
      let view: WikiPageView;
      try {
        view = await updateWikiPage(wiki, person, p.orgId, args.page, {
          baseVersion: args.base_version,
          body: args.body,
          tags: args.tags,
          note: noteThroughApp(p.app.name, "edited"),
        });
      } catch (error) {
        if (!(error instanceof WikiVersionConflictError)) throw error;
        throw new AppToolError(
          `version_conflict: the page changed after version ${args.base_version} and is at version ${error.currentVersion} now. Nothing was saved. read_wiki_page returns its current text.`,
          { code: "version_conflict", current_version: error.currentVersion },
        );
      }
      const changed = view.version !== args.base_version;
      if (changed)
        await audited("apps.updated", view.id, {
          changed: [...(args.body !== undefined ? ["body"] : []), ...(args.tags !== undefined ? ["tags"] : [])],
          version: view.version,
        });
      return { ...pageOut(view), changed };
    },
  );

  tool(
    "delete_wiki_page",
    {
      scope: "manage",
      title: "Move a wiki page to the trash",
      description: `Moves a wiki page to the wiki's trash as ${name}. People who edit it can restore it from the trash for ${WIKI_TRASH_DAYS} days, then it is gone with its history.`,
      input: z.object({ page: PAGE }).strict(),
      readOnly: false,
      destructive: true,
      idempotent: true,
      openWorld: false,
    },
    async (args) => {
      const view = await getWikiPage(deps.db, person, p.orgId, args.page);
      await allow();
      await deleteWikiPage(wiki, person, p.orgId, view.id);
      await audited("apps.deleted", view.id, { name: view.title });
      return { id: view.id, slug: view.slug, title: plain(view.title, WIKI_LIMITS.title), in_trash: true };
    },
  );
}
