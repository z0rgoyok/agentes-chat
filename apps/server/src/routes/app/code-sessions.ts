import {
  archiveCodeSession,
  type CodeSessionDeps,
  codeSessionCommitDiff,
  codeSessionDiff,
  codeSessionFile,
  codeSessionFiles,
  codeSessionGit,
  codeSessionGitLog,
  codeStartOptions,
  createCodeSession,
  getCodeSession,
  keepCodeSuggestionHere,
  listCodeSessions,
  openCodeSuggestion,
  postPersonMessage,
  renameCodeSession,
  retryCodeSession,
  saveCodeSessionFile,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { type AppDeps, createAppRouter, errors, json, OrgParams, requireSession, security } from "./context";

const tags = ["Code"];

const CodeSession = z
  .object({
    id: z.uuid(),
    channelId: z.uuid().openapi({ description: "The session's conversation (a channel of kind `code`)." }),
    rootId: z.uuid().openapi({ description: "Its root message: the session is that thread's replies." }),
    title: z.string(),
    repo: z.string().openapi({ description: "`owner/name`." }),
    branch: z.string().nullable(),
    baseBranch: z.string().nullable(),
    agentId: z.uuid(),
    machineId: z.uuid().nullable(),
    worktree: z.object({
      state: z.enum(["preparing", "ready", "failed", "removed"]),
      error: z.string().nullable(),
      errorCode: z
        .enum(["github_access"])
        .nullable()
        .openapi({ description: "A known failure the apps say in the person's words: no GitHub access here." }),
    }),
    local: z.boolean().openapi({ description: "A project only on the agent's computer (no remote)." }),
    pr: z.object({ number: z.number().int(), url: z.string().nullable() }).nullable(),
    stat: z.object({
      files: z.number().int(),
      added: z.number().int(),
      removed: z.number().int(),
      at: z.string().nullable(),
    }),
    work: z.enum(["preparing", "failed", "working", "waiting", "idle"]).openapi({
      description: "What it is doing now: its worktree being prepared or failed, a live run, waiting on you, or idle.",
    }),
    createdBy: z.string().nullable(),
    createdAt: z.string(),
    lastAt: z.string(),
    from: z
      .object({
        channelId: z.uuid(),
        messageId: z.uuid(),
        threadId: z.uuid().nullable(),
        kind: z.enum(["dm", "channel"]),
        name: z.string().openapi({ description: "The agent's name for a DM, else the channel's." }),
      })
      .optional()
      .openapi({
        description: "The conversation it was opened from (a suggestion there), on the session's own read only.",
      }),
  })
  .openapi("CodeSession");

const SessionParams = OrgParams.extend({ sessionId: z.uuid() });
const SuggestionParams = OrgParams.extend({ messageId: z.uuid() });

const CodeSuggestion = z
  .object({
    id: z.string(),
    agentId: z.uuid(),
    repo: z.string(),
    title: z.string(),
    request: z.string().openapi({ description: "The person's words the session starts with." }),
    requestMessageId: z.uuid(),
    askerId: z.string().openapi({ description: "The person who asked: the one who decides." }),
    status: z.enum(["pending", "opening", "opened", "here"]),
    sessionId: z.uuid().optional(),
    by: z.string().optional(),
    at: z.string().optional(),
  })
  .openapi("CodeSuggestion");

const CodeDiff = z
  .object({
    scope: z.enum(["base", "uncommitted", "commit"]),
    base: z.object({ branch: z.string().nullable(), sha: z.string().nullable() }),
    files: z.array(
      z.object({
        path: z.string(),
        patch: z.string(),
        added: z.number().int(),
        removed: z.number().int(),
        untracked: z.boolean().optional(),
      }),
    ),
    added: z.number().int(),
    removed: z.number().int(),
    truncated: z.boolean(),
  })
  .openapi("CodeDiff");

const CodeGit = z
  .object({
    uncommitted: z.number().int(),
    ahead: z.number().int(),
    upstream: z.boolean(),
    local: z.boolean(),
    pr: z.object({ number: z.number().int(), url: z.string().nullable() }).nullable(),
    next: z.enum(["commit", "push", "pr", "merge"]).nullable(),
  })
  .openapi("CodeGit");

const ChangeStatus = z.enum(["modified", "added", "deleted", "renamed", "untracked"]);

const CodeGitLog = z
  .object({
    branch: z.string().nullable(),
    base: z.object({ branch: z.string().nullable(), sha: z.string().nullable() }),
    changes: z.array(
      z.object({
        path: z.string(),
        from: z.string().optional().openapi({ description: "Where a renamed file was." }),
        status: ChangeStatus,
        added: z.number().int().nullable(),
        removed: z.number().int().nullable(),
      }),
    ),
    changesMore: z.boolean(),
    commits: z.array(
      z.object({
        sha: z.string(),
        short: z.string(),
        subject: z.string(),
        author: z.string(),
        at: z.string(),
        files: z.number().int(),
        added: z.number().int(),
        removed: z.number().int(),
      }),
    ),
    more: z.boolean().openapi({ description: "More commits than listed." }),
  })
  .openapi("CodeGitLog");

const CodeFiles = z
  .object({
    paths: z.array(z.string()),
    truncated: z.boolean(),
    changes: z.array(z.object({ path: z.string(), status: ChangeStatus })),
  })
  .openapi("CodeFiles");

const CodeFile = z
  .object({
    path: z.string(),
    state: z.enum(["ok", "binary", "missing", "ignored", "secret", "outside"]),
    content: z.string(),
    size: z.number().int(),
    truncated: z.boolean(),
    rev: z
      .string()
      .openapi({ description: "What it holds, as git's blob hash: a save sends the one it started from." }),
  })
  .openapi("CodeFile");

/**
 * Code sessions (ADR 0215): a request worked on in its own git worktree on the agent's computer, with its own
 * conversation. The conversation itself goes through the chat's routes (`…/channels/{channelId}/messages` with the
 * root as the thread); these routes open, list, rename and close sessions and read git in their worktree.
 */
export function codeSessionRoutes(deps: AppDeps) {
  const { db, adapters } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  const sessions = (): CodeSessionDeps => ({
    db,
    pubsub: adapters.pubsub,
    hub: deps.extras?.sandbox?.machines?.hub ?? null,
    git: deps.extras?.sandbox?.git ?? null,
    ...(deps.log ? { log: deps.log } : {}),
  });
  // A session opened by `userId`: its request goes in as their own message, through the chat's path.
  const openingAs = (userId: string, orgId: string) => ({
    ...sessions(),
    postRequest: (channelId: string, rootId: string, text: string) =>
      postPersonMessage(
        {
          db,
          pubsub: adapters.pubsub,
          judge: deps.extras?.context?.judge,
          talker: deps.extras?.talker,
          gifs: adapters.gifs,
        },
        userId,
        orgId,
        channelId,
        { body: text, threadId: rootId },
      ),
  });

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/code-sessions",
      tags,
      security,
      summary: "The code sessions I take part in, most recent activity first",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ sessions: z.array(CodeSession) })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json({ sessions: await listCodeSessions(db, c.get("user").id, orgId) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/code-sessions/start",
      tags,
      security,
      summary: "Where a session can start: the agents that think on a computer, with the repositories each may use",
      request: { params: OrgParams },
      responses: {
        200: json(
          z.object({
            agents: z.array(
              z.object({
                agentId: z.uuid(),
                repos: z.array(z.string()),
                any: z.boolean().openapi({ description: "Its list allows repositories it doesn't name." }),
              }),
            ),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json(await codeStartOptions(db, c.get("user").id, orgId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/code-sessions",
      tags,
      security,
      summary: "Opens a code session: its conversation now, its worktree on the agent's computer right after",
      request: {
        params: OrgParams,
        body: {
          content: {
            "application/json": {
              schema: z.object({
                agentId: z.uuid(),
                repo: z
                  .string()
                  .min(1)
                  .max(200)
                  .openapi({ description: "`owner/name` on GitHub, or a name for a project on the agent's computer." }),
                text: z.string().min(1).max(20_000).openapi({ description: "The request: the first message." }),
              }),
            },
          },
        },
      },
      responses: { 201: json(CodeSession), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const user = c.get("user");
      const session = await createCodeSession(openingAs(user.id, orgId), user.id, orgId, c.req.valid("json"));
      deps.wakeWorkers?.();
      return c.json(session, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/code-sessions/suggestions/{messageId}/open",
      tags,
      security,
      summary: "Opens the session an agent suggested in the chat (ADR 0215 §11): only the person who asked",
      description:
        "The session starts with the asker's own words and the suggestion's title, and remembers the conversation it came from. The reply's card says it was opened (`code.suggestion`).",
      request: { params: SuggestionParams },
      responses: { 201: json(CodeSession), ...errors },
    }),
    async (c) => {
      const { orgId, messageId } = c.req.valid("param");
      const user = c.get("user");
      const session = await openCodeSuggestion(openingAs(user.id, orgId), user.id, orgId, messageId);
      deps.wakeWorkers?.();
      return c.json(session, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/code-sessions/suggestions/{messageId}/here",
      tags,
      security,
      summary: "Keeps a suggested session's work in the chat: the agent is told to go on there",
      request: { params: SuggestionParams },
      responses: { 200: json(z.object({ suggestion: CodeSuggestion })), ...errors },
    }),
    async (c) => {
      const { orgId, messageId } = c.req.valid("param");
      const suggestion = await keepCodeSuggestionHere(
        { db, pubsub: adapters.pubsub },
        c.get("user").id,
        orgId,
        messageId,
      );
      deps.wakeWorkers?.();
      return c.json({ suggestion }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/code-sessions/{sessionId}",
      tags,
      security,
      summary: "One code session",
      request: { params: SessionParams },
      responses: { 200: json(CodeSession), ...errors },
    }),
    async (c) => {
      const { orgId, sessionId } = c.req.valid("param");
      return c.json(await getCodeSession(db, c.get("user").id, orgId, sessionId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{orgId}/code-sessions/{sessionId}",
      tags,
      security,
      summary: "Renames a code session",
      request: {
        params: SessionParams,
        body: { content: { "application/json": { schema: z.object({ title: z.string().min(1).max(120) }) } } },
      },
      responses: { 200: json(CodeSession), ...errors },
    }),
    async (c) => {
      const { orgId, sessionId } = c.req.valid("param");
      const { title } = c.req.valid("json");
      return c.json(await renameCodeSession(sessions(), c.get("user").id, orgId, sessionId, title), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/code-sessions/{sessionId}/retry",
      tags,
      security,
      summary: "Prepares a failed session's worktree again",
      request: { params: SessionParams },
      responses: { 200: json(CodeSession), ...errors },
    }),
    async (c) => {
      const { orgId, sessionId } = c.req.valid("param");
      const session = await retryCodeSession(sessions(), c.get("user").id, orgId, sessionId);
      deps.wakeWorkers?.();
      return c.json(session, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/code-sessions/{sessionId}",
      tags,
      security,
      summary: "Closes a code session: out of the list, its worktree removed from the computer (the branch stays)",
      request: { params: SessionParams },
      responses: { 204: { description: "Closed" }, ...errors },
    }),
    async (c) => {
      const { orgId, sessionId } = c.req.valid("param");
      await archiveCodeSession(sessions(), c.get("user").id, orgId, sessionId);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/code-sessions/{sessionId}/diff",
      tags,
      security,
      summary:
        "The session's change, read with git in its worktree: since its base, only what isn't committed, or one commit",
      request: {
        params: SessionParams,
        query: z.object({
          scope: z.enum(["base", "uncommitted", "commit"]).default("base"),
          sha: z
            .string()
            .regex(/^[0-9a-f]{7,40}$/)
            .optional()
            .openapi({ description: "The commit, with `scope=commit`." }),
        }),
      },
      responses: { 200: json(CodeDiff), ...errors },
    }),
    async (c) => {
      const { orgId, sessionId } = c.req.valid("param");
      const { scope, sha } = c.req.valid("query");
      const user = c.get("user").id;
      if (scope === "commit")
        return c.json(await codeSessionCommitDiff(sessions(), user, orgId, sessionId, sha ?? ""), 200);
      return c.json(await codeSessionDiff(sessions(), user, orgId, sessionId, scope), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/code-sessions/{sessionId}/git/log",
      tags,
      security,
      summary: "The Git tab: what isn't committed, and the branch's commits since the session's base",
      request: { params: SessionParams },
      responses: { 200: json(CodeGitLog), ...errors },
    }),
    async (c) => {
      const { orgId, sessionId } = c.req.valid("param");
      return c.json(await codeSessionGitLog(sessions(), c.get("user").id, orgId, sessionId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/code-sessions/{sessionId}/files",
      tags,
      security,
      summary: "The Files tab: the worktree's files git doesn't ignore, and which of them changed",
      request: { params: SessionParams },
      responses: { 200: json(CodeFiles), ...errors },
    }),
    async (c) => {
      const { orgId, sessionId } = c.req.valid("param");
      return c.json(await codeSessionFiles(sessions(), c.get("user").id, orgId, sessionId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/code-sessions/{sessionId}/file",
      tags,
      security,
      summary: "One file of the worktree (never one git ignores, a `.env` file or a link out of it)",
      request: {
        params: SessionParams,
        query: z.object({ path: z.string().min(1).max(1024).openapi({ description: "Relative to the worktree." }) }),
      },
      responses: { 200: json(CodeFile), ...errors },
    }),
    async (c) => {
      const { orgId, sessionId } = c.req.valid("param");
      const { path } = c.req.valid("query");
      return c.json(await codeSessionFile(sessions(), c.get("user").id, orgId, sessionId, path), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/code-sessions/{sessionId}/file",
      tags,
      security,
      summary:
        "Saves one file of the worktree, as its agent (409 `code_session.file_changed` when it changed since `rev`)",
      request: {
        params: SessionParams,
        body: {
          content: {
            "application/json": {
              schema: z.object({
                path: z.string().min(1).max(1024).openapi({ description: "Relative to the worktree." }),
                content: z.string().max(600_000),
                rev: z.string().max(64).openapi({ description: "The `rev` the file was read with." }),
                overwrite: z.boolean().optional().openapi({ description: "Save even if it changed since `rev`." }),
              }),
            },
          },
        },
      },
      responses: { 200: json(CodeFile), ...errors },
    }),
    async (c) => {
      const { orgId, sessionId } = c.req.valid("param");
      return c.json(
        await saveCodeSessionFile(sessions(), c.get("user").id, orgId, sessionId, c.req.valid("json")),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/code-sessions/{sessionId}/git",
      tags,
      security,
      summary: "Where the session's git stands, and the next step its button offers",
      request: { params: SessionParams },
      responses: { 200: json(CodeGit), ...errors },
    }),
    async (c) => {
      const { orgId, sessionId } = c.req.valid("param");
      return c.json(await codeSessionGit(sessions(), c.get("user").id, orgId, sessionId), 200);
    },
  );

  return app;
}
