import type { Agent, AgentAudience, OrgRole, Person } from "@agenteschat/client";
import { useAgents, useUpdateRole, useWidenAudience } from "@agenteschat/client";
import { sameAudience } from "@agenteschat/client/lib/agent-edit";
import { audienceOf, audiencePatch, canEditAudience } from "@agenteschat/client/lib/audience";
import { errorText } from "@agenteschat/client/lib/errors";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { can } from "@agenteschat/client/lib/permissions";
import { holdsAll, isEveryone, roleLock, roleName, sortRoles, withRow } from "@agenteschat/client/lib/roles";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { GroupedFooter, GroupedHeader, GroupedList, GroupedRow, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { Note } from "../ai/parts";
import { useWidenAsk } from "../chat/ReachLines";
import { SettingsPage } from "../settings/parts";
import { AgentFace, Face } from "../shared/Face";
import { useDirectory } from "../shared/hooks";
import { pickOne } from "../shared/PickerSheet";
import { goBack, successHaptic, tapHaptic } from "../shared/parts";
import {
  agentAudienceLine,
  agentIntent,
  agentLosingLine,
  agentTicked,
  agentWhoPatch,
  audienceValid,
  listedAgents,
  talkGate,
} from "./logic";
import { CargoMark, Gone, rolesHref, useFail, useRolesData, Waiting } from "./parts";

/**
 * A cargo's Agentes (P7): who its people talk to, each agent saying who talks to it now. A tap follows W7: one that
 * answers everyone asks who talks to it (P7b), one listing the cargo drops it, one listing others adds it after
 * today's questions (someone's plan, a mailbox). When neither Todos nor the cargo talks to agents, that comes first.
 */
export function RoleAgentsScreen({ roleId }: { roleId: string }) {
  const { t } = useTranslation();
  const fail = useFail();
  const { orgId, org, data, everyone, people, failed, error, retry, viewer } = useRolesData();
  const agents = useAgents(orgId);
  const update = useUpdateRole(orgId);
  const title = t("mobile.roles.tabs.agents");
  if (!data || !people || !agents.data)
    return (
      <Waiting
        title={title}
        failed={failed || agents.isError}
        error={error ?? agents.error}
        retry={() => {
          retry();
          void agents.refetch();
        }}
      />
    );
  const role = data.roles.find((r) => r.id === roleId);
  if (!role) return <Gone title={title} />;
  const name = roleName(t, role);
  const locked = roleLock(org ?? { role: "member" }, role) !== null;
  const list = listedAgents(agents.data);
  const gate = talkGate(role, everyone);
  const opens = !locked && holdsAll(viewer, ["talk_to_agents"]);
  const header = isEveryone(role) ? t("mobile.roles.agents.headerBase") : t("mobile.roles.agents.header", { name });
  return (
    <SettingsPage title={title} subtitle={name} locked={update.isPending}>
      {gate ? (
        <>
          <View style={styles.note}>
            <Note icon="agent">{t("mobile.roles.agents.gate", { name })}</Note>
          </View>
          {opens ? (
            <GroupedList>
              <GroupedRow
                icon="chat"
                label={t("mobile.roles.agents.gateOn")}
                onPress={() =>
                  update.mutate(
                    { roleId: role.id, patch: { permissions: withRow(role.permissions, "talk_to_agents", 1) } },
                    { onSuccess: () => successHaptic(), onError: fail },
                  )
                }
              />
            </GroupedList>
          ) : null}
        </>
      ) : null}
      <GroupedHeader hint={{ name: t("common.about", { label: header }), text: t("mobile.roles.agents.hint") }}>
        {header}
      </GroupedHeader>
      <GroupedList>
        {list.map((a) => (
          <AgentRow key={a.id} role={role} agent={a} roles={data.roles} locked={locked} />
        ))}
      </GroupedList>
      {list.length === 0 ? (
        <>
          <GroupedFooter>{t("mobile.roles.agents.none")}</GroupedFooter>
          {can(org, "create_agents") ? (
            <GroupedList>
              <GroupedRow icon="plus" label={t("shell.createAgent")} onPress={() => router.push("/new-agent")} />
            </GroupedList>
          ) : null}
        </>
      ) : null}
    </SettingsPage>
  );
}

/** One agent on a cargo's Agentes: its face, who talks to it, ticked when the cargo's people do. */
function AgentRow({ role, agent, roles, locked }: { role: OrgRole; agent: Agent; roles: OrgRole[]; locked: boolean }) {
  const { t } = useTranslation();
  const toast = useToast();
  const fail = useFail();
  const { orgId, org, viewer } = useRolesData();
  const dir = useDirectory();
  const widen = useWidenAudience(orgId, agent.id);
  const askWiden = useWidenAsk(agent);
  const mine = canEditAudience(org ?? undefined, agent, viewer.userId);
  const nameOf = (id: string) => dir.memberById.get(id)?.name;
  const tap = () => {
    tapHaptic();
    if (!mine) {
      const owner = agent.ownerUserId ? nameOf(agent.ownerUserId) : undefined;
      return toast({
        title: owner
          ? t("mobile.roles.agents.locked", { ...agentGrammar(agent.name), owner })
          : t("mobile.roles.agents.lockedNoOwner"),
        icon: "lock",
      });
    }
    const intent = agentIntent(role, agent, roles);
    if (intent.kind === "who") return router.push(rolesHref.agent(role.id, agent.id));
    const next = audiencePatch(intent.audience);
    widen.saveAsync(next, askWiden(next)).then((saved) => saved && successHaptic(), fail);
  };
  return (
    <GroupedRow
      leading={<AgentFace agentId={agent.id} size={30} live={false} />}
      label={agent.name}
      labelLines={0}
      sub={agentAudienceLine(t, agent, roles, nameOf)}
      subLines={2}
      media
      checked={agentTicked(role, agent)}
      faint={!mine}
      disabled={locked || widen.busy}
      onPress={tap}
    />
  );
}

/**
 * Quem fala com {{agent}} (P7b), pushed with Salvar: the agent page's "Quem pode falar". Todos, only some cargos and
 * people (the cargos, then the people with Adicionar pessoa), or only the person responsible. The line under it says
 * who stops talking to it.
 */
export function AgentWhoScreen({ roleId, agentId }: { roleId: string; agentId: string }) {
  const { t, i18n } = useTranslation();
  const { orgId, data, people, failed, error: loadError, retry, viewer } = useRolesData();
  const agents = useAgents(orgId);
  const dir = useDirectory();
  const widen = useWidenAudience(orgId, agentId);
  const agent = agents.data?.find((a) => a.id === agentId);
  const askWiden = useWidenAsk(agent);
  const [edit, setEdit] = useState<Partial<AgentAudience>>({});
  const [error, setError] = useState<unknown>(null);
  const title = agent?.name ?? t("audience.section");
  if (!data || !people || !agents.data)
    return <Waiting title={title} failed={failed || agents.isError} error={loadError ?? agents.error} retry={retry} />;
  const from = data.roles.find((r) => r.id === roleId);
  if (!from || !agent) return <Gone title={title} />;
  const intent = agentIntent(from, agent, data.roles);
  const start: AgentAudience = intent.kind === "who" ? intent.start : audienceOf(agent);
  const who: AgentAudience = { ...start, ...edit };
  const roleIds = who.roleIds ?? [];
  const owner = agent.ownerUserId ? dir.memberById.get(agent.ownerUserId)?.name : undefined;
  const saved = audienceOf(agent);
  const next = agentWhoPatch(who, saved);
  const changed = !sameAudience(next, saved);
  const valid = audienceValid(who, agent);
  const roles = sortRoles(data.roles.filter((r) => !isEveryone(r)));
  const picked = people.filter((p) => who.userIds.includes(p.userId));
  const flipRole = (id: string) => {
    tapHaptic();
    setEdit((e) => {
      const ids = e.roleIds ?? start.roleIds ?? [];
      return { ...e, roleIds: ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id] };
    });
  };
  const setPeople = (userIds: string[]) => setEdit((e) => ({ ...e, userIds }));
  const addPerson = async () => {
    const left = people.filter((p) => !who.userIds.includes(p.userId) && p.userId !== agent.ownerUserId);
    const key = await pickOne({
      title: t("mobile.roles.agents.addPerson"),
      options: left.map((p: Person) => ({
        key: p.userId,
        label: p.name,
        sub: p.email,
        leading: { kind: "person", userId: p.userId },
      })),
      search: true,
    });
    if (key) setPeople([...who.userIds, key]);
  };
  const save = () =>
    widen.saveAsync(next, askWiden(next)).then((done) => {
      if (!done) return;
      successHaptic();
      goBack();
    }, setError);
  return (
    <SettingsPage
      title={title}
      action={{ label: t("common.save"), disabled: !changed || !valid, onPress: () => void save() }}
      busy={widen.busy}
    >
      {error ? (
        <View style={styles.note}>
          <Note icon="x">{errorText(t, error, i18n.language)}</Note>
        </View>
      ) : null}
      <GroupedHeader>{t("audience.section")}</GroupedHeader>
      <GroupedList>
        <GroupedRow
          label={t("rolesPage.everyoneName")}
          checked={who.mode === "everyone"}
          onPress={() => setEdit((e) => ({ ...e, mode: "everyone" }))}
        />
        <GroupedRow
          label={t("mobile.roles.agents.some")}
          checked={who.mode === "people"}
          onPress={() => setEdit((e) => ({ ...e, mode: "people" }))}
        />
        <GroupedRow
          label={owner ? t("mobile.roles.only", { names: owner }) : t("audience.mode.owner")}
          checked={who.mode === "owner"}
          disabled={!agent.ownerUserId}
          onPress={() => setEdit((e) => ({ ...e, mode: "owner" }))}
        />
      </GroupedList>
      {who.mode === "people" ? (
        <>
          {roles.length ? (
            <>
              <GroupedHeader>{t("settings.section.roles")}</GroupedHeader>
              <GroupedList>
                {roles.map((r) => {
                  const count = people.filter((p) => (p.roleIds ?? []).includes(r.id)).length;
                  return (
                    <GroupedRow
                      key={r.id}
                      leading={<CargoMark role={r} size={30} />}
                      label={r.name}
                      labelLines={0}
                      sub={count ? t("rolesPage.people", { count }) : t("mobile.roles.nobody")}
                      media
                      checked={roleIds.includes(r.id)}
                      onPress={() => flipRole(r.id)}
                    />
                  );
                })}
              </GroupedList>
            </>
          ) : null}
          <GroupedHeader>{t("audience.people")}</GroupedHeader>
          <GroupedList>
            {picked.map((p) => (
              <GroupedRow
                key={p.userId}
                leading={<Face who={{ type: "person", id: p.userId }} size={30} live={false} />}
                label={p.name}
                sub={p.email}
                subLines={2}
                media
                remove={{
                  label: t("common.removeName", { name: p.name }),
                  onPress: () => setPeople(who.userIds.filter((id) => id !== p.userId)),
                }}
              />
            ))}
            <GroupedRow icon="plus" label={t("mobile.roles.agents.addPerson")} onPress={() => void addPerson()} />
          </GroupedList>
          {owner ? <GroupedFooter>{t("audience.ownerAlways", { name: owner })}</GroupedFooter> : null}
        </>
      ) : null}
      <GroupedFooter>
        {valid ? agentLosingLine(t, agent, next, people, viewer.userId) : t("audience.pickSomeone")}
      </GroupedFooter>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  note: { paddingHorizontal: 4, paddingTop: 10 },
});
