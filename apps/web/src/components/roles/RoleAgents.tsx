import type { Agent, AgentAudience, OrgRole, OrgRoles, Person } from "@agenteschat/client";
import { useAgents, useUpdateRole, useWidenAudience } from "@agenteschat/client";
import {
  audienceOf,
  audiencePatch,
  audienceWithRole,
  canEditAudience,
  EVERYONE_AUDIENCE,
  roleTalksTo,
} from "@agenteschat/client/lib/audience";
import { errorText } from "@agenteschat/client/lib/errors";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import {
  everyoneOf,
  isEveryone,
  levelOn,
  ROLES_SEARCH_FROM,
  roleLock,
  roleName,
  sortRoles,
  withRow,
} from "@agenteschat/client/lib/roles";
import {
  Button,
  Checkbox,
  fold,
  GroupHeading,
  HintLine,
  Icon,
  List,
  SavedNote,
  SearchField,
  Tip,
  Toolbar,
} from "@agenteschat/ui";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { useWidenAsk } from "@/components/ReachLines";
import { useToast } from "@/lib/toast";
import { WhoChip } from "./parts";
import { WhoTalksDialog } from "./WhoDialogs";

/**
 * A cargo's Agentes (W7): which agents its people talk to, a checklist with who talks to each now. Narrowing saves at
 * once; widening asks today's questions first (someone's plan, a mailbox); an agent everyone talks to, or only its
 * owner, opens "Quem fala com…". Lodi isn't listed (everyone has Lodi), nor an archived agent.
 */
export function RoleAgents({
  role,
  data,
  people,
}: {
  role: OrgRole;
  data: OrgRoles;
  people: Person[];
  onPeople?: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const update = useUpdateRole(org.id);
  const toast = useToast();
  const agents = (useAgents(org.id).data ?? []).filter((a) => !isRightHand(a) && !a.former);
  const [query, setQuery] = useState("");
  const [saved, setSaved] = useState(false);
  const [talks, setTalks] = useState<{ agent: Agent; start: AgentAudience } | null>(null);
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 2000);
    return () => clearTimeout(timer);
  }, [saved]);
  const base = isEveryone(role);
  const name = roleName(t, role);
  const lock = roleLock(org, role) !== null;
  const everyone = everyoneOf(data.roles);
  const admin = !base && role.permissions.includes("administrator");
  // Neither Todos nor this cargo talks to agents: the list would change nothing for who only has it.
  const gate =
    !admin &&
    levelOn(role.permissions, "talk_to_agents") === 0 &&
    levelOn(everyone?.permissions ?? [], "talk_to_agents") === 0;
  const roles = sortRoles(data.roles.filter((r) => !isEveryone(r)));
  const byId = new Map(roles.map((r) => [r.id, r]));
  // Who talks to an agent has no rank rule and no Administrador pass: every other cargo starts ticked, whoever may
  // change it, or saving as it opens would take the agent from their people.
  const others = roles.filter((r) => r.id !== role.id);
  const q = fold(query.trim());
  const shown = agents.filter((a) => !q || fold(`${a.name} ${a.role}`).includes(q));
  return (
    <div className="roles-tab">
      <p className="roles-tabline">
        <HintLine name={t("common.about", { label: t("rolesPage.tabs.agents") })} hint={t("rolesPage.agents.hint")}>
          {base ? t("rolesPage.agents.lineBase") : t("rolesPage.agents.line", { name })}
        </HintLine>
      </p>
      {gate && (
        <p className="roles-talkgate ac-actline">
          <span className="ac-iconline">
            <Icon name="lock" size={16} />
            <span>{t("rolesPage.agents.noTalk", { name })}</span>
          </span>
          {!lock && (
            <Button
              size="sm"
              loading={update.isPending}
              onClick={() =>
                update.mutate(
                  { roleId: role.id, patch: { permissions: withRow(role.permissions, "talk_to_agents", 1) } },
                  { onError: (e) => toast.show(errorText(t, e), "error") },
                )
              }
            >
              {t("rolesPage.agents.turnOnTalk")}
            </Button>
          )}
        </p>
      )}
      <Toolbar
        size="sm"
        search={
          agents.length > ROLES_SEARCH_FROM ? (
            <SearchField
              size="sm"
              value={query}
              placeholder={t("rolesPage.agents.search")}
              aria-label={t("rolesPage.agents.search")}
              onChange={(e) => setQuery(e.target.value)}
              onClear={() => setQuery("")}
              clearLabel={t("filters.clearSearch")}
            />
          ) : undefined
        }
        actions={<SavedNote shown={saved} label={t("common.saved")} />}
      />
      {agents.length === 0 ? (
        <p className="roles-empty ac-actline">
          <span>{t("rolesPage.agents.none")}</span>
          <Button
            size="sm"
            variant="ghost"
            icon="plus"
            onClick={() => void navigate({ to: "/org/$orgId/agents/new", params: { orgId: org.id } })}
          >
            {t("shell.createAgent")}
          </Button>
        </p>
      ) : shown.length === 0 ? (
        <p className="roles-empty ac-actline">
          <span>{t("rolesPage.agents.noMatch", { q: query.trim() })}</span>
          <Button size="sm" variant="ghost" onClick={() => setQuery("")}>
            {t("filters.clearSearch")}
          </Button>
        </p>
      ) : (
        <section className="section section--tight">
          <GroupHeading title={t("rolesPage.tabs.agents")} count={shown.length} />
          <List className="roles-checks">
            {shown.map((a) => (
              <AgentRow
                key={a.id}
                agent={a}
                role={role}
                byId={byId}
                people={people}
                lock={lock}
                onSaved={() => setSaved(true)}
                onAsk={(on) =>
                  setTalks({
                    agent: a,
                    start: on
                      ? audienceWithRole(a, role.id, true)
                      : { mode: "people", userIds: [], roleIds: others.map((r) => r.id) },
                  })
                }
              />
            ))}
          </List>
        </section>
      )}
      <WhoTalksDialog
        agent={talks?.agent ?? null}
        start={talks?.start ?? EVERYONE_AUDIENCE}
        onClose={() => setTalks(null)}
        people={people}
      />
    </div>
  );
}

/** One agent: its box, face, name and função, and who talks to it; its own save, asking first when it widens. */
function AgentRow({
  agent,
  role,
  byId,
  people,
  lock,
  onSaved,
  onAsk,
}: {
  agent: Agent;
  role: OrgRole;
  byId: Map<string, OrgRole>;
  people: Person[];
  lock: boolean;
  onSaved: () => void;
  /** Opens "Quem fala com…": `on`, this cargo ticked (an agent only its owner talks to). */
  onAsk: (on: boolean) => void;
}) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const widen = useWidenAudience(org.id, agent.id);
  const asks = useWidenAsk(agent);
  const base = isEveryone(role);
  const a = audienceOf(agent);
  const on = roleTalksTo(role, agent);
  const mine = canEditAudience(org, agent, me.user.id);
  const owner = people.find((p) => p.userId === agent.ownerUserId);
  const g = agentGrammar(agent.name);
  const why = mine
    ? undefined
    : owner
      ? t("rolesPage.agents.notYours", { ...g, owner: owner.name })
      : t("rolesPage.agents.notYoursNoOwner");
  const write = (next: AgentAudience) => widen.widen(audiencePatch(next), asks.ask(next), onSaved);
  const change = (next: boolean) => {
    if (base) {
      if (next) write({ ...EVERYONE_AUDIENCE, consultable: a.consultable });
      else onAsk(false);
      return;
    }
    if (a.mode === "everyone" && !next) return onAsk(false);
    if (a.mode === "owner" && next) return onAsk(true);
    write(audienceWithRole(agent, role.id, next));
  };
  const chip =
    a.mode === "everyone" ? (
      <WhoChip everyone />
    ) : a.mode === "owner" ? (
      <WhoChip
        people={owner ? [{ userId: owner.userId, name: owner.name, image: owner.avatarUrl ?? owner.image }] : []}
      />
    ) : (
      <WhoChip
        roles={a.roleIds.flatMap((id) => (byId.has(id) ? [byId.get(id) as OrgRole] : []))}
        people={a.userIds.flatMap((id) => {
          const p = people.find((x) => x.userId === id);
          return p ? [{ userId: p.userId, name: p.name, image: p.avatarUrl ?? p.image }] : [];
        })}
      />
    );
  const id = `role-${role.id}-agent-${agent.id}`;
  const box = (
    <label htmlFor={id} className="roles-check ac-actrow__text" data-off={why || lock ? "" : undefined}>
      <Checkbox id={id} checked={on} disabled={Boolean(why) || lock || widen.busy} onCheckedChange={change} />
      <AgentAvatar agentId={agent.id} name={agent.name} size="sm" />
      <span className="roles-check__name">
        {agent.name}
        {agent.role && <small>{agent.role}</small>}
      </span>
    </label>
  );
  return (
    <div className="ac-list__row ac-actrow roles-checkrow">
      {why ? (
        <Tip tip={why} look="ac-msg__note-tip ac-glass" className="ac-actrow__text">
          {box}
        </Tip>
      ) : (
        box
      )}
      {chip}
      {asks.dialog}
    </div>
  );
}
