import { type Agent, useRoles, useUpdateAgent } from "@agenteschat/client";
import { sameEditors } from "@agenteschat/client/lib/agent-edit";
import {
  canEditAudience,
  type EditorsMode,
  type EditorsValue,
  editorsPatch,
  editorsSummary,
  editorsValueOf,
  seesDetails,
} from "@agenteschat/client/lib/audience";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import { isEveryone, sortRoles } from "@agenteschat/client/lib/roles";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/providers/org";
import { EmptyState, GroupedFooter, GroupedHeader, GroupedList, GroupedRow, RoleMark, SkeletonList } from "@/ui";
import { router } from "@/ui/navigation";
import { useFailed } from "../routines/hooks";
import { usePersonalView } from "../settings/hooks";
import { Gap, SettingsPage, useUnsavedGuard } from "../settings/parts";
import { Face } from "../shared/Face";
import { useDirectory, useMeId, useOrgId } from "../shared/hooks";
import { goBack, successHaptic, tapHaptic } from "../shared/parts";

/** Opens an agent's "Who can edit" (ADR 0085 addendum of 2026-11-17). */
export const openAgentEditors = (agentId: string) =>
  router.push({ pathname: "/agent-editors/[id]", params: { id: agentId } });

/** "Who can edit" in one line, the web's: its owner, then the people and roles it names, or "Only who looks after it". */
export function useEditorsSummary() {
  const { t } = useTranslation();
  const dir = useDirectory();
  const roles = useRoles(useOrgId()).data?.roles;
  return (agent: Agent) =>
    editorsSummary(
      t,
      agent,
      (id) => dir.memberById.get(id)?.name,
      (id) => roles?.find((r) => r.id === id)?.name,
    );
}

/**
 * "Who can edit" an agent (ADR 0085 addendum of 2026-11-17), the web's choice as a pushed form: only who looks after
 * it, or some people and roles too, checked on the page, Save in the bar. Its owner and who manages it change it
 * (`canEditAudience`, the server's rule); anyone else who sees how it works reads who edits it (`EditorsRead`). The
 * right hand has none: nobody edits how it works (ADR 0137).
 */
export function AgentEditorsScreen({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory();
  const meId = useMeId();
  const agent = dir.agentById.get(agentId);
  const rightHand = isRightHand(agent);
  // Opened for the right hand by its address alone: nothing to set, back where it came from.
  useEffect(() => {
    if (rightHand) goBack();
  }, [rightHand]);
  if (!agent || rightHand) {
    return (
      <SettingsPage title={t("editors.section")}>
        {rightHand ? null : dir.loading ? (
          <SkeletonList rows={3} />
        ) : (
          <EmptyState icon="agent" title={t("mobile.agentEdit.missing")} />
        )}
      </SettingsPage>
    );
  }
  if (!canEditAudience(org ?? undefined, agent, meId ?? "")) return <EditorsRead agent={agent} />;
  return <EditorsForm agent={agent} />;
}

/**
 * For whoever only reads it: who edits it in one line, and what editing changes. Who doesn't see how it works gets no
 * editors from the server (the line would name nobody): only that its workings are kept for others, as its public card
 * says (ADR 0085 addendum of 2026-11-17).
 */
function EditorsRead({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const summary = useEditorsSummary();
  const g = agentGrammar(agent.name);
  return (
    <SettingsPage title={t("editors.title", g)}>
      <Gap />
      {seesDetails(agent) ? (
        <>
          <GroupedList>
            <GroupedRow icon="pen" label={summary(agent)} labelLines={0} />
          </GroupedList>
          <GroupedFooter>{t("editors.note", g)}</GroupedFooter>
        </>
      ) : (
        <GroupedFooter>{t("profile.detailsHidden", g)}</GroupedFooter>
      )}
    </SettingsPage>
  );
}

/**
 * The two choices as the web's, each with the line that says who it means; under "Also some people or roles", the
 * workspace's roles and its people but the owner (who always edits), checked as they're tapped. Choosing "Only who looks
 * after it" keeps the picks on the page, and a save names nobody then (`editorsPatch`). Saved, it goes back.
 */
function EditorsForm({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const failed = useFailed();
  const dir = useDirectory();
  const roles = useRoles(orgId);
  const { personal } = usePersonalView();
  const update = useUpdateAgent(orgId, agent.id);
  const saved = editorsValueOf(agent);
  const [draft, setDraft] = useState<EditorsValue>(saved);
  // "Also some people or roles" with nobody picked names nobody, as the other choice: nothing to save.
  const changed = !sameEditors(draft, saved);
  // Leaving with a choice not saved asks first, as Edit agent does; one on its way and a finished save leave without
  // asking (there is nothing left to discard).
  const leave = useUnsavedGuard(changed && !update.isPending);
  const g = agentGrammar(agent.name);
  const owner = agent.ownerUserId ? dir.memberById.get(agent.ownerUserId)?.name : undefined;
  // The workspace's own roles, top first: "everyone" would be every member (the server takes only its own roles).
  const roleList = sortRoles((roles.data?.roles ?? []).filter((r) => !isEveryone(r)));
  const people = [...dir.memberById.values()].filter((m) => m.userId !== agent.ownerUserId);
  const pick = (mode: EditorsMode) => {
    tapHaptic();
    setDraft((d) => ({ ...d, mode }));
  };
  const flip = (kind: "userIds" | "roleIds", id: string) => {
    tapHaptic();
    setDraft((d) => ({ ...d, [kind]: d[kind].includes(id) ? d[kind].filter((x) => x !== id) : [...d[kind], id] }));
  };
  const save = () =>
    update.mutate(
      { editors: editorsPatch(draft) },
      {
        onSuccess: () => {
          leave();
          successHaptic();
          goBack();
        },
        onError: failed,
      },
    );
  const roleGroup =
    roleList.length > 0 ? (
      <>
        <GroupedHeader hint={{ name: t("common.about", { label: t("audience.roles") }), text: t("editors.rolesHint") }}>
          {t("audience.roles")}
        </GroupedHeader>
        <GroupedList>
          {roleList.map((r) => (
            <GroupedRow
              key={r.id}
              leading={<RoleMark color={r.color} icon={r.icon} size={22} />}
              label={r.name}
              checked={draft.roleIds.includes(r.id)}
              onPress={() => flip("roleIds", r.id)}
            />
          ))}
        </GroupedList>
      </>
    ) : null;
  const peopleGroup =
    people.length > 0 ? (
      <>
        <GroupedHeader>{t("audience.people")}</GroupedHeader>
        <GroupedList>
          {people.map((m) => (
            <GroupedRow
              key={m.userId}
              leading={<Face who={{ type: "person", id: m.userId }} size={26} live={false} />}
              label={m.name}
              checked={draft.userIds.includes(m.userId)}
              onPress={() => flip("userIds", m.userId)}
            />
          ))}
        </GroupedList>
      </>
    ) : null;
  return (
    <SettingsPage
      title={t("editors.title", g)}
      // Saving: the bar's spinner where Save was, the page locked under it.
      busy={update.isPending}
      action={{ label: t("common.save"), onPress: save, disabled: !changed }}
    >
      <Gap />
      <GroupedList>
        <GroupedRow
          label={t("editors.mode.owner", g)}
          labelLines={2}
          sub={owner ? t("editors.modeText.owner", { ...g, owner }) : t("editors.modeText.noOwner", g)}
          subLines={0}
          checked={draft.mode === "owner"}
          onPress={() => pick("owner")}
        />
        <GroupedRow
          label={t("editors.mode.people", g)}
          labelLines={2}
          sub={t("editors.modeText.people", g)}
          subLines={0}
          checked={draft.mode === "people"}
          onPress={() => pick("people")}
        />
      </GroupedList>
      {draft.mode === "people" ? (
        <>
          {owner ? <GroupedFooter>{t("audience.ownerAlways", { name: owner })}</GroupedFooter> : null}
          {/* A personal workspace's family picks people first (ADR 0159), as on the web. */}
          {personal ? peopleGroup : roleGroup}
          {personal ? roleGroup : peopleGroup}
        </>
      ) : null}
      <GroupedFooter>{t("editors.note", g)}</GroupedFooter>
    </SettingsPage>
  );
}
