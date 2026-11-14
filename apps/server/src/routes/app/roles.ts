import {
  COMPUTER_STEPS,
  createRole,
  deleteRole,
  listRoles,
  PERMISSION_ROWS,
  ROLE_NAME_MAX,
  reorderRoles,
  roleMailLoss,
  setMemberRoles,
  setRowHolders,
  updateRole,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
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

const tags = ["Roles"];

const OrgRole = z
  .object({
    id: z.uuid(),
    kind: z.enum(["custom", "everyone"]).openapi({
      description: "`everyone`: the base every member holds (the apps call it Todos / Everyone); always last.",
    }),
    name: z.string(),
    icon: z.string(),
    color: z.string(),
    position: z.number().int().openapi({ description: "Order, 0 the highest." }),
    permissions: z.array(z.string()).openapi({ description: "Its keys; `administrator` grants every other one." }),
    mentionable: z.boolean(),
    hoist: z.boolean().openapi({ description: "Its people are listed apart." }),
    people: z.number().int(),
    editable: z
      .boolean()
      .openapi({ description: "Whether you may change it: you manage roles and it is below your own." }),
    givable: z.boolean().openapi({
      description:
        "Whether you may give it to people (invitations, requests, a person's roles): it is below your own and you hold every key it has.",
    }),
    channelIds: z.array(z.uuid()).openapi({
      description:
        "The channels it opens that you see: those limited to it (ADR 0125); for `everyone`, every public channel. Archived ones aside.",
    }),
    hiddenChannels: z
      .number()
      .int()
      .openapi({ description: "Channels limited to it that you don't see: counted, never named." }),
    agentIds: z.array(z.uuid()).openapi({
      description:
        "The agents it lets people talk to: those whose audience lists it; for `everyone`, those that answer the whole workspace. The right hand and archived agents aside.",
    }),
  })
  .openapi("OrgRole");

const PermissionArea = z
  .object({
    id: z.string(),
    use: z.array(z.string()).openapi({ description: 'The keys of the area\'s "use" level.' }),
    keys: z.array(z.string()).openapi({ description: 'Every key of the area: its "manage" level.' }),
  })
  .openapi("PermissionArea");

const RoleInput = z.object({
  name: z.string().min(1).max(ROLE_NAME_MAX),
  icon: z.string().max(40).optional(),
  color: z.string().max(40).optional(),
  permissions: z.array(z.string().max(60)).max(60).optional(),
  mentionable: z.boolean().optional(),
  hoist: z.boolean().optional(),
});

const RoleParams = OrgParams.extend({ roleId: z.uuid().openapi({ param: { name: "roleId", in: "path" } }) });
const RowParams = OrgParams.extend({
  row: z
    .enum(PERMISSION_ROWS as [string, ...string[]])
    .openapi({ param: { name: "row", in: "path" }, description: "A key, or `computers` for the four computer keys." }),
});
const Level = z.number().int().min(0).max(COMPUTER_STEPS.length);

const RolesPayload = z.object({
  roles: z.array(OrgRole),
  areas: z.array(PermissionArea),
  colors: z.array(z.string()),
  icons: z.array(z.string()),
});

const RoleMailLoss = z.object({
  agentId: z.uuid(),
  agentName: z.string(),
  accountId: z.uuid(),
  address: z.string(),
  ownerUserId: z.string().nullable(),
  ownerName: z.string().nullable(),
});
const MemberParams = OrgParams.extend({ userId: z.string().openapi({ param: { name: "userId", in: "path" } }) });

/**
 * A workspace's roles (ADR 0085): read by every member, changed by who may manage roles (and only the ones below
 * their own), given to people by who may manage people.
 */
export function roleRoutes(deps: AppDeps) {
  const { db } = deps;
  const pubsub = deps.adapters.pubsub;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));

  const rolesPayload = async (userId: string, orgId: string) => {
    const { roles, areas, colors, icons } = await listRoles(db, userId, orgId);
    return {
      roles,
      areas: areas.map((a) => ({ id: a.id, use: [...a.use], keys: [...a.keys] })),
      colors: [...colors],
      icons: [...icons],
    };
  };

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/roles",
      tags,
      security,
      summary: "The workspace's roles, top first, and the permission areas",
      request: { params: OrgParams },
      responses: { 200: json(RolesPayload), ...errors },
    }),
    async (c) => c.json(await rolesPayload(c.get("user").id, c.req.valid("param").orgId), 200),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/roles",
      tags,
      security,
      summary: "Create a role (at the bottom, above everyone)",
      description:
        "Needs `manage_roles`; you can only give keys you hold yourself. `copyFrom` (Duplicar): a role below yours whose keys you hold; what the body leaves out comes from it, and the new role joins its channels and agents (nobody holds it yet).",
      request: {
        params: OrgParams,
        body: body(
          RoleInput.extend({
            copyFrom: z.uuid().optional().openapi({ description: "The role to copy, with its channels and agents." }),
          }),
        ),
      },
      responses: { 201: json(z.object({ id: z.uuid() }), "Created"), ...errors },
    }),
    async (c) => {
      const role = await createRole(db, c.get("user").id, c.req.valid("param").orgId, c.req.valid("json"), {
        pubsub,
      });
      return c.json({ id: role.id }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{orgId}/roles/{roleId}",
      tags,
      security,
      summary: "Change a role below yours",
      description: "`everyone` keeps its name, icon and switches: only its keys and color change.",
      request: { params: RoleParams, body: body(RoleInput.partial()) },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, roleId } = c.req.valid("param");
      await updateRole(db, c.get("user").id, orgId, roleId, c.req.valid("json"), { pubsub });
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/roles/{roleId}",
      tags,
      security,
      summary: "Delete a role below yours",
      description: "Whoever held it keeps their other roles. `everyone` can't be deleted.",
      request: { params: RoleParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, roleId } = c.req.valid("param");
      await deleteRole(db, c.get("user").id, orgId, roleId, { pubsub });
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/roles/order",
      tags,
      security,
      summary: "Put the roles in this order, top first",
      description: "Every role but `everyone`, once. Roles at or above your own stay where they are.",
      request: { params: OrgParams, body: body(z.object({ ids: z.array(z.uuid()).max(200) })) },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      await reorderRoles(db, c.get("user").id, c.req.valid("param").orgId, c.req.valid("json").ids, { pubsub });
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/members/{userId}/roles",
      tags,
      security,
      summary: "Set a person's roles",
      description:
        "Needs `manage_members`. You only touch people below you (yourself aside) and roles below your own; an owner's roles only owners change.",
      request: {
        params: MemberParams,
        // The right hand's people card it was applied from, for the audit's "via" (ADR 0137 §4).
        query: z.object({ via: z.uuid().optional() }),
        body: body(
          z.object({
            roleIds: z.array(z.uuid()).max(100),
            mailLossSeen: z.array(z.uuid()).max(500).optional().openapi({
              description:
                "The mailboxes the person agreed agents lose (`roles/{roleId}/members/preview`). If one would lose another (given since), 409 `agent.mail_loss_changed` and nothing changes: ask again.",
            }),
          }),
        ),
      },
      responses: { 200: json(z.object({ roleIds: z.array(z.string()) })), ...errors },
    }),
    async (c) => {
      const { orgId, userId } = c.req.valid("param");
      const { roleIds, mailLossSeen } = c.req.valid("json");
      const saved = await setMemberRoles(db, c.get("user").id, orgId, userId, roleIds, {
        pubsub,
        via: c.req.valid("query").via,
        mailLossSeen,
      });
      return c.json({ roleIds: saved }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/roles/{roleId}/members/preview",
      tags,
      security,
      summary: "The mailboxes agents would lose if these people got the role, taking nothing",
      description:
        "Giving a role lets its people talk to the agents limited to it, which takes the mailboxes other people gave those agents (only a mailbox's owner gives an agent access to it, ADR 0038): the apps ask here first and name whose mail goes. Empty when nobody new reaches an agent that holds someone else's mailbox. For who may give the role (`manage_members`).",
      request: { params: RoleParams, body: body(z.object({ userIds: z.array(z.string().max(200)).min(1).max(100) })) },
      responses: { 200: json(z.object({ mailboxes: z.array(RoleMailLoss) })), ...errors },
    }),
    async (c) => {
      const { orgId, roleId } = c.req.valid("param");
      const mailboxes = await roleMailLoss(db, c.get("user").id, orgId, roleId, c.req.valid("json").userIds);
      return c.json({ mailboxes }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/permissions/{row}",
      tags,
      security,
      summary: "Set who holds one permission: everyone and the roles in one call",
      description:
        "\"Quem pode…\" (ADR 0085, addendum of 2026-11-13). `everyone` is the base role's level, each listed role gets its level, and every other role you may change goes to 0 on this row. A level is 0 or 1, or the step of the agents' computers (`computers`: 0 none, 1 their own agents' browser, 2 their own agents' computer, 3 any agent's browser, 4 any agent's computer). Roles above yours never change (listing one at another level is 403 `role.above_you`), nor do roles with `administrator`. Needs `manage_roles`; you only add or take keys you hold (`role.grant_forbidden`). Answers with the roles as `GET …/roles` does.",
      request: {
        params: RowParams,
        body: body(
          z.object({
            everyone: Level,
            roles: z.array(z.object({ id: z.uuid(), level: Level })).max(200),
          }),
        ),
      },
      responses: { 200: json(RolesPayload), ...errors },
    }),
    async (c) => {
      const { orgId, row } = c.req.valid("param");
      await setRowHolders(db, c.get("user").id, orgId, row, c.req.valid("json"), { pubsub });
      return c.json(await rolesPayload(c.get("user").id, orgId), 200);
    },
  );

  return app;
}
