import { ACCOUNT_LOGIN_FAILURES } from "@agenteschat/adapters";
import {
  accountLoginStatus,
  aiHubView,
  beginAccountLogin,
  can,
  cancelAccountLogin,
  getMachineAccounts,
  getMembership,
  listAccountOrder,
  listAiAccounts,
  moveAccountInOrder,
  planKeyFallbackOn,
  publishMachineAgentsChanged,
  refreshAiAccounts,
  removeMachineAccount,
  renameMachineAccount,
  sendAccountLoginCode,
  setAccountPermissions,
  setAccountServes,
  setPlanKeyFallback,
  takeBackPlan,
  ValidationError,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { apiError, errorResponse } from "../../http/errors";
import {
  type AppDeps,
  body,
  createAppRouter,
  errors,
  json,
  noContent,
  OrgParams,
  requireSession,
  security,
} from "./context";
import {
  AccountAudience,
  AccountKind,
  AccountPermissions,
  AccountRights,
  BrainUnavailable,
  Credential,
  MachineAccount,
  PlanUsage,
} from "./schemas";
import { SecretBox } from "./secrets";

const tags = ["Connected computers"];

const MachineParams = OrgParams.extend({ machineId: z.uuid() });
const LoginParams = MachineParams.extend({ loginId: z.uuid() });
const AccountParams = MachineParams.extend({ accountId: z.uuid() });
const PlanParams = OrgParams.extend({ accountId: z.uuid() });

const AccountLogin = z
  .object({
    loginId: z.uuid(),
    kind: AccountKind,
    url: z.string().openapi({
      description: "The provider's page: Claude's sign-in, Codex's device page, or where a coding plan's key is made.",
    }),
    provider: z.string().optional().openapi({ description: "A coding plan's key account: the plan." }),
    publicKey: z.string().optional().openapi({
      description:
        "Claude Code: the computer's key for this sign-in (raw P-256, base64). The browser seals the pasted code to it (AAD `loginId|orgId|account`).",
    }),
    userCode: z.string().optional().openapi({ description: "Codex: the one-time code to type on its page." }),
    expiresAt: z.string(),
  })
  .openapi("AccountLogin");

const AccountLoginStatus = z
  .object({
    state: z.enum(["waiting", "done", "failed", "expired"]),
    account: MachineAccount.optional().openapi({ description: "Once `done`: the account, stored." }),
    error: z.string().optional().openapi({ description: "`failed`: why, for people." }),
    code: z.enum(ACCOUNT_LOGIN_FAILURES).optional().openapi({
      description:
        "`failed` or `expired` on the computer: why, for the app to say in its own words. `not_installed`, `no_tty` (no terminal to take the code), `network` (the provider out of reach), `bad_code` (the provider refused the pasted code), `cli_exit` (the CLI stopped with an error of its own), `not_signed_in_after_login` (it finished, but its status says signed out), `status_unknown` (its status didn't answer), `no_token`, `not_kept`, `sandbox` (Grok Build signed in, but its sandbox doesn't start there for an agent), `timeout` (`expired`), `canceled`. An older runner sends none.",
    }),
    message: z.string().optional().openapi({
      description: "With `code`: what the CLI itself said (English, credentials masked, at most 300 characters).",
    }),
    duplicate: z.object({ label: z.string(), account: MachineAccount }).optional().openapi({
      description:
        "`failed`: the account that signed in is one the caller already has on this computer (named `label`, and `account` itself). A new sign-in is removed there; signing in again leaves the account signed out.",
    }),
    signedInAs: z.string().optional().openapi({
      description: "`failed`: signing in again came back as another account, this email; the account stays signed out.",
    }),
  })
  .openapi("AccountLoginStatus");

const AccountOrderGroup = z
  .object({
    machineId: z.uuid(),
    computer: z.string(),
    kind: AccountKind,
    accounts: z.array(
      MachineAccount.extend({
        canMove: z.boolean().openapi({ description: "The caller may move it in the order: its owner or an admin." }),
      }),
    ),
  })
  .openapi("AccountOrderGroup", { description: "One computer's accounts of one kind, first to last." });

const AiHub = z
  .object({
    accounts: z.array(
      MachineAccount.extend({
        machineId: z.uuid(),
        computer: z.string(),
        permissions: AccountPermissions,
        rights: AccountRights,
      }),
    ),
    keys: z.array(
      Credential.pick({ id: true, provider: true, label: true, keyHint: true, endpoint: true, usedBy: true }).extend({
        isDefault: z.boolean(),
      }),
    ),
    order: z.array(AccountOrderGroup),
    keyFallback: z.boolean().openapi({
      description:
        "With every plan account of a run's order at its limit, the run goes on with the workspace's API key (off by default).",
    }),
    canManageKeys: z.boolean().openapi({ description: "The caller adds and removes keys (`manage_credentials`)." }),
    canConfigure: z.boolean().openapi({
      description: "The caller turns `keyFallback` on or off and moves anyone's account in the order (`configure`).",
    }),
  })
  .openapi("AiHub", {
    description:
      "\"Contas de IA\" as one view: every plan account on the workspace's computers, whoever connected it, with the caller's rights; the live API keys (who uses each only for `manage_credentials`); the order of use; and the API-key switch.",
  });

const offline = {
  409: errorResponse("The computer is offline (`machine.offline`) or its runner is too old (`account.runner_old`)"),
};

/**
 * Accounts of the computer brains on a connected computer (ADR 0041, ADR
 * 0059): an account is the person's who started its sign-in (through the
 * provider's own CLI on the computer). The person who connected the computer
 * adds accounts there, or anyone on a computer nobody connected; only an
 * account's owner sees its email, renames it, continues its sign-in or
 * signs in to it again; its owner or whoever connected the computer removes it.
 * Session + CSRF like the rest of `/api/app`.
 */
export function machineAccountRoutes(deps: AppDeps) {
  const { db } = deps;
  const pubsub = deps.adapters.pubsub;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  const withHub = () => {
    const hub = deps.extras?.sandbox?.machines?.hub;
    if (!hub) throw new ValidationError("Connected computers are not available on this server");
    return { db, pubsub, hub, ...(deps.log ? { log: deps.log } : {}) };
  };

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/machines/{machineId}/accounts",
      tags,
      security,
      summary:
        "The computer's Claude, ChatGPT and coding plan accounts (the person who connected it, an admin, or anyone where nobody did)",
      description:
        "Emails only of the caller's own accounts. Changes come as `machine.updated` org events with `accounts: true`.",
      request: { params: MachineParams },
      responses: {
        200: json(
          z.object({
            accounts: z.array(MachineAccount),
            canManage: z.boolean().openapi({
              description:
                "The caller adds accounts there (they connected it, or nobody did) and its runner knows accounts (protocol 13).",
            }),
            supported: z.boolean().openapi({ description: "Its runner knows accounts (protocol 13)." }),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, machineId } = c.req.valid("param");
      return c.json(await getMachineAccounts({ db }, c.get("user").id, orgId, machineId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/machines/{machineId}/account-logins",
      tags,
      security,
      summary: "Start signing in an account on the computer, through the provider's own CLI there",
      description:
        "The account is the caller's from now on. The person who connected the computer adds accounts there, or anyone on a computer nobody connected.",
      request: {
        params: MachineParams,
        body: body(
          z.object({
            kind: AccountKind,
            accountId: z
              .string()
              .uuid()
              .optional()
              .openapi({ description: "Sign in again to this account of the caller's (it was signed out)." }),
            email: z.string().max(254).optional().openapi({
              description:
                "Claude Code: which account to sign in to (the CLI's login hint). Letters, digits and `._+-` only (`account.invalid_email`).",
            }),
            provider: z.string().max(20).optional().openapi({
              description:
                "A coding plan on Claude Code (`zai`, `kimi`, `minimax`, `opencode`), `cursor` for a Cursor API key or `zen` for an OpenCode key: a key account. The key is sent next like a code, sealed to the computer. `enterprise` on `antigravity`: a Gemini Enterprise sign-in, not a key (`account.invalid_plan`; a runner without plans' keys: `account.runner_old`).",
            }),
          }),
        ),
      },
      responses: {
        201: json(AccountLogin, "Started"),
        429: errorResponse("Too many sign-ins started"),
        ...errors,
        ...offline,
      },
    }),
    async (c) => {
      const { orgId, machineId } = c.req.valid("param");
      const { kind, accountId, email, provider } = c.req.valid("json");
      const userId = c.get("user").id;
      // Each one starts the provider's CLI on the computer, and on a shared one any member may.
      const limit = await deps.adapters.rateLimiter.consume(`account-login:${userId}:${machineId}`, {
        limit: 10,
        windowMs: 15 * 60_000,
      });
      if (!limit.allowed) return apiError(c, 429, "rate_limited", "Too many sign-ins started. Try again later.");
      const login = await beginAccountLogin(withHub(), userId, orgId, machineId, kind, accountId, email, provider);
      return c.json(login, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/machines/{machineId}/account-logins/{loginId}/code",
      tags,
      security,
      summary:
        "Hand the Claude code (or a coding plan's key), sealed in the browser to the computer's key, to the waiting sign-in",
      description:
        "Only the person who started the sign-in. We relay it to the computer in memory and keep nothing of it.",
      request: { params: LoginParams, body: body(z.object({ box: SecretBox })) },
      responses: { 204: noContent[204], ...errors, ...offline },
    }),
    async (c) => {
      const { orgId, machineId, loginId } = c.req.valid("param");
      await sendAccountLoginCode(withHub(), c.get("user").id, orgId, machineId, loginId, c.req.valid("json").box);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/machines/{machineId}/account-logins/{loginId}",
      tags,
      security,
      summary: "Where a sign-in is; once done, the account is stored and returned (the person who started it)",
      request: { params: LoginParams },
      responses: { 200: json(AccountLoginStatus), ...errors, ...offline },
    }),
    async (c) => {
      const { orgId, machineId, loginId } = c.req.valid("param");
      return c.json(await accountLoginStatus(withHub(), c.get("user").id, orgId, machineId, loginId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/machines/{machineId}/account-logins/{loginId}",
      tags,
      security,
      summary: "Cancel a sign-in (the computer stops the CLI and removes its folder; the person who started it)",
      request: { params: LoginParams },
      responses: { 204: noContent[204], ...errors, ...offline },
    }),
    async (c) => {
      const { orgId, machineId, loginId } = c.req.valid("param");
      await cancelAccountLogin(withHub(), c.get("user").id, orgId, machineId, loginId);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/ai-accounts",
      tags,
      security,
      summary: "The caller's AI accounts on the organization's computers, and where they can add one (any member)",
      description:
        "Their plans and keys, each with its computer (emails and key hints are the caller's own). Changes come as `machine.updated` org events with `accounts: true`.",
      request: { params: OrgParams },
      responses: {
        200: json(
          z
            .object({
              accounts: z
                .array(MachineAccount.extend({ machineId: z.uuid(), computer: z.string() }))
                .openapi({ description: "The caller's own plans and keys (older apps read these)." }),
              hub: AiHub.optional().openapi({
                description: 'Every account in the workspace, as "Contas de IA" lists them.',
              }),
              computers: z.array(
                z.object({
                  machineId: z.uuid(),
                  name: z.string(),
                  online: z.boolean(),
                  mine: z.boolean().openapi({ description: "The caller connected it." }),
                  canAdd: z.boolean().openapi({
                    description:
                      "The caller adds accounts there (they connected it, or nobody did) and its runner knows accounts.",
                  }),
                  keys: z.boolean().openapi({ description: "Its runner takes coding plans' keys (protocol 20)." }),
                  shares: z
                    .object({
                      claude_code: z.boolean(),
                      codex: z.boolean(),
                      cursor: z.boolean(),
                      opencode: z.boolean(),
                      grok: z.boolean(),
                      antigravity: z.boolean(),
                      key: z.boolean(),
                    })
                    .openapi({
                      description:
                        "A new sign-in there thinks for all of the caller's agents on it (protocol 29): Claude's, ChatGPT's, Gemini's (protocol 58), a coding plan's key.",
                    }),
                  off: z
                    .record(z.string(), BrainUnavailable)
                    .openapi({ description: "Why a CLI of `brains` can't think there, by its kind." }),
                  brains: z
                    .object({
                      claude_code: z.boolean(),
                      codex: z.boolean(),
                      cursor: z.boolean(),
                      opencode: z.boolean(),
                      grok: z.boolean(),
                      antigravity: z.boolean(),
                    })
                    .openapi({
                      description:
                        "What it can think with now: Claude Code (Claude, the coding plans), Codex (ChatGPT), Cursor, OpenCode, Grok Build and the Antigravity CLI (Gemini).",
                    }),
                  own: z
                    .object({
                      claude_code: z.object({ plan: z.string().optional(), usage: PlanUsage.optional() }).optional(),
                      codex: z.object({ plan: z.string().optional(), usage: PlanUsage.optional() }).optional(),
                      opencode: z.object({}).optional(),
                    })
                    .openapi({
                      description:
                        "Each CLI's own sign-in there (\"this computer's account\"), on a computer the caller connected: its plan and usage when known. `opencode` also on a computer nobody connected: OpenCode's free tier thinks for anyone's agents (ADR 0132).",
                    }),
                }),
              ),
            })
            .openapi("AiAccounts"),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const userId = c.get("user").id;
      const { orgId } = c.req.valid("param");
      const [own, hub] = await Promise.all([listAiAccounts({ db }, userId, orgId), aiHubView(db, userId, orgId)]);
      return c.json({ ...own, hub }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/ai-accounts/refresh",
      tags,
      security,
      summary: "Look the caller's plans' usage up again (an accounts screen is open)",
      description:
        "The caller's accounts, and the own sign-ins of the computers they connected, on every online computer. Each computer looks at most every few minutes per account; what it finds comes as `machine.updated` org events with `accounts: true`.",
      request: { params: OrgParams },
      responses: { 202: { description: "Asked" }, ...errors },
    }),
    async (c) => {
      await refreshAiAccounts(withHub(), c.get("user").id, c.req.valid("param").orgId);
      return c.body(null, 202);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{orgId}/machines/{machineId}/accounts/{accountId}",
      tags,
      security,
      summary: "Rename an account (its owner)",
      request: { params: AccountParams, body: body(z.object({ label: z.string().min(1).max(40) })) },
      responses: { 200: json(MachineAccount), ...errors },
    }),
    async (c) => {
      const { orgId, machineId, accountId } = c.req.valid("param");
      const account = await renameMachineAccount(
        { db, pubsub },
        c.get("user").id,
        orgId,
        machineId,
        accountId,
        c.req.valid("json").label,
      );
      return c.json(account, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/machines/{machineId}/accounts/{accountId}",
      tags,
      security,
      summary:
        "Remove an account: the computer signs it out and deletes its folder; agents that used it go back to the computer's own sign-in",
      description:
        "Its owner, the person who connected the computer, or an admin where the computer or the account has no person. With the computer off, it is removed there when it comes back.",
      request: { params: AccountParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, machineId, accountId } = c.req.valid("param");
      await removeMachineAccount(withHub(), c.get("user").id, orgId, machineId, accountId);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/ai-accounts/{accountId}/take-back",
      tags,
      security,
      summary: "Take a plan back from agents someone else gave it to (its owner)",
      description:
        "ADR 0059 §3: an agent that thinks with the caller's account because someone who may use other people's plans gave it (`use_others_plans`) loses it, as when an account goes. `agentId`: that agent only; omitted: every such agent. Audited as `account.taken_back`; the `plan_lent` notifications are done.",
      request: {
        params: PlanParams,
        body: body(z.object({ agentId: z.uuid().optional() })),
      },
      responses: { 200: json(z.object({ agentIds: z.array(z.uuid()) })), ...errors },
    }),
    async (c) => {
      const { orgId, accountId } = c.req.valid("param");
      const result = await takeBackPlan(
        { db, pubsub },
        c.get("user").id,
        orgId,
        accountId,
        c.req.valid("json").agentId,
      );
      if (result.agentIds.length) await publishMachineAgentsChanged(pubsub, orgId);
      return c.json(result, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/ai-accounts/{accountId}/serves",
      tags,
      security,
      summary: "Choose who a plan thinks for: everyone in the workspace, or only you (the person who connected it)",
      description:
        "ADR 0059 §3: `everyone` (the default) lets every person's right hand and any agent think with it; `owner` keeps it to the caller's own, moving other people's agents off it as when a plan is taken back. Every login of the account changes together. Audited as `account.serves`; its `plan_serves` notification is done.",
      request: {
        params: PlanParams,
        body: body(z.object({ serves: z.enum(["everyone", "owner"]) })),
      },
      responses: {
        200: json(z.object({ serves: z.enum(["everyone", "owner"]), agentIds: z.array(z.uuid()) })),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, accountId } = c.req.valid("param");
      const result = await setAccountServes(
        { db, pubsub },
        c.get("user").id,
        orgId,
        accountId,
        c.req.valid("json").serves,
      );
      if (result.agentIds.length) await publishMachineAgentsChanged(pubsub, orgId);
      return c.json(result, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/ai-accounts/order",
      tags,
      security,
      summary: "The order of use of the workspace's Claude and ChatGPT accounts, by computer and kind (any member)",
      description:
        "ADR 0041 §6: at a plan's limit a run goes on with the next account of its computer and kind, its agent's owner's own first and then the others that serve everyone, each in this order. Only the CLI's own sign-ins (never a key). Owner-only accounts keep their place for their owner's agents. Changes come as `machine.updated` org events with `accounts: true`.",
      request: { params: OrgParams },
      responses: {
        200: json(
          z.object({
            groups: z.array(AccountOrderGroup),
            keyFallback: z.boolean().optional().openapi({
              description: '"Continuar com a chave de API quando todos os planos estiverem no limite", off by default.',
            }),
            canConfigure: z
              .boolean()
              .optional()
              .openapi({ description: "The caller may turn `keyFallback` on or off (`configure`)." }),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const userId = c.get("user").id;
      const { orgId } = c.req.valid("param");
      const [groups, keyFallback, canConfigure] = await Promise.all([
        listAccountOrder({ db }, userId, orgId),
        planKeyFallbackOn(db, orgId),
        getMembership(db, userId, orgId).then((m) => can(m, "configure")),
      ]);
      return c.json({ groups, keyFallback, canConfigure }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/ai-accounts/key-fallback",
      tags,
      security,
      summary:
        "Turn on or off going on with the workspace's API key once every plan of the order is at its limit (admins)",
      description:
        "Off by default, since it turns flat-rate plans into spend by the token. Needs `configure`. Audited as `ai.key_fallback`.",
      request: { params: OrgParams, body: body(z.object({ on: z.boolean() })) },
      responses: { 200: json(z.object({ on: z.boolean() })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const on = await setPlanKeyFallback(db, c.get("user").id, orgId, c.req.valid("json").on);
      return c.json({ on }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/ai-accounts/{accountId}/permissions",
      tags,
      security,
      summary: "Change an AI account's permissions: Gerenciar, Usar em agentes, Atender todos",
      description:
        "Only the ones given change, for every login of the account. `manage`: its owner. `use`: whoever manages it. `reply`: its owner or an administrator (else 403 `account.permission_forbidden`). Fewer people in `use` moves the agents and right hand of those it no longer serves off it, as when a plan is taken back (`agentIds`). Audited as `account.permissions`; when someone other than its owner lets more people in (`use` or `reply`), its owner gets one email.",
      request: {
        params: PlanParams,
        body: body(
          z.object({
            manage: AccountAudience.optional(),
            use: AccountAudience.optional(),
            reply: AccountAudience.optional(),
          }),
        ),
      },
      responses: {
        200: json(z.object({ permissions: AccountPermissions, agentIds: z.array(z.uuid()) })),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, accountId } = c.req.valid("param");
      const result = await setAccountPermissions(
        { db, pubsub },
        c.get("user").id,
        orgId,
        accountId,
        c.req.valid("json"),
      );
      if (result.agentIds.length) await publishMachineAgentsChanged(pubsub, orgId);
      return c.json(result, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/ai-accounts/{accountId}/order",
      tags,
      security,
      summary: "Move an account to a place in its order of use (its owner or an admin)",
      description:
        "`index` counts accounts, not logins: 0 is first; past the end, last. An account signed in once per agent moves with all its logins, named by any of them that has a place in the order (one with none: `account.not_found`). The other accounts of its computer and kind keep their order. Someone else's account: `account.order_forbidden`. Audited as `account.order`.",
      request: {
        params: PlanParams,
        body: body(z.object({ index: z.number().int().min(0) })),
      },
      responses: { 200: json(AccountOrderGroup), ...errors },
    }),
    async (c) => {
      const { orgId, accountId } = c.req.valid("param");
      const group = await moveAccountInOrder(
        { db, pubsub },
        c.get("user").id,
        orgId,
        accountId,
        c.req.valid("json").index,
      );
      return c.json(group, 200);
    },
  );

  return app;
}
