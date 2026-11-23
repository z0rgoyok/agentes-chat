import { type AgentGroup, useAgentGroupAction, useAgentGroups, useMembers } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { can } from "@agenteschat/client/lib/permissions";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, StyleSheet, TextInput } from "react-native";
import { useOrg } from "@/providers/org";
import {
  GroupedField,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  haptics,
  useFieldText,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { plainRole } from "../agents/logic";
import { RowBones } from "../roles/parts";
import { chooseAction, Gap, SettingsPage, useUnsavedGuard } from "../settings/parts";
import { AgentFace } from "../shared/Face";
import { LoadFailed } from "../shared/FirstUse";
import { useColors, useDirectory, useOrgId } from "../shared/hooks";
import { goBack, successHaptic } from "../shared/parts";
import { closePersonChoose, openPersonChoose } from "./person-choose";

/** The web's name field (the server takes up to this many characters). */
const NAME_MAX = 80;

/** "Excluir setor", asked in the system's alert: its agents go back to Agentes. `done` runs once it is gone. */
export function useDeleteSector() {
  const { t } = useTranslation();
  const toast = useToast();
  const action = useAgentGroupAction(useOrgId());
  const ask = (group: AgentGroup, done?: () => void) =>
    Alert.alert(t("agentGroups.deleteTitle", { name: group.name }), t("agentGroups.deleteText"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("agentGroups.delete"),
        style: "destructive",
        onPress: () =>
          action.mutate(
            { type: "remove", groupId: group.id },
            {
              onSuccess: () => {
                haptics.medium();
                done?.();
              },
              onError: (e) => toast({ title: errorText(t, e), icon: "x" }),
            },
          ),
      },
    ]);
  return { ask, pending: action.isPending };
}

/**
 * A setor header's "…" and long press in Agentes (who manages agents): Editar (its page) and Excluir setor, in the
 * app's own action list, as every "…" of the phone.
 */
export function useSectorMenu() {
  const { t } = useTranslation();
  const remove = useDeleteSector();
  return (group: AgentGroup) =>
    chooseAction(
      group.name,
      [
        { icon: "pen", label: t("agentGroups.rename"), onPress: () => router.push(`/sector/${group.id}`) },
        { icon: "trash", label: t("agentGroups.delete"), destructive: true, onPress: () => remove.ask(group) },
      ],
      t("common.cancel"),
    );
}

/**
 * One setor (ADR 0148), from Equipe's list and a setor's menu in Agentes: its name (who manages agents renames it
 * here, saved from the bar), who cares for it and who stands in (a tap opens the people on a screen of their own, for
 * who manages agents), its agents (each opens its profile), and, last, deleting it as a red row the system's alert
 * confirms, saying its agents go back to Agentes. Its look and its channels stay on the web.
 */
export function SectorScreen({ id }: { id: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const words = useFieldText("body");
  const orgId = useOrgId();
  const { org } = useOrg();
  const dir = useDirectory();
  const toast = useToast();
  const groups = useAgentGroups(orgId);
  const members = useMembers(orgId);
  const action = useAgentGroupAction(orgId);
  const remove = useDeleteSector();
  const [name, setName] = useState<string | null>(null);
  const group = groups.data?.find((g) => g.id === id);
  const manages = can(org, "manage_agents");
  const failed = (e: unknown) => toast({ title: errorText(t, e), icon: "x" });
  const setPerson = (field: "leadUserId" | "backupUserId", userId: string | null) => {
    if (group) action.mutate({ type: "update", groupId: group.id, [field]: userId }, { onError: failed });
  };
  // The people's screen saves through the latest `setPerson` (the setor as it is then).
  const latest = useRef(setPerson);
  useLayoutEffect(() => {
    latest.current = setPerson;
  });
  useEffect(() => () => closePersonChoose(), []);
  // A new name typed and not saved: leaving asks first, as every form with a Save in its bar.
  const typed = name?.trim() ?? "";
  const leave = useUnsavedGuard(Boolean(group && name !== null && typed && typed !== group.name && !action.isPending));
  if (!group) {
    return (
      <SettingsPage title={t("agentGroups.group")}>
        {groups.isLoading ? (
          // The rows' own shape while the setor loads, never a spinner.
          <>
            <GroupedHeader>{t("agentGroups.group")}</GroupedHeader>
            <GroupedList>
              <RowBones />
              <RowBones name={56} />
            </GroupedList>
          </>
        ) : (
          <LoadFailed onRetry={() => void groups.refetch()} />
        )}
      </SettingsPage>
    );
  }
  const people = (members.data ?? []).filter((m) => m.userId);
  const nameOf = (userId: string | null | undefined) =>
    userId ? dir.nameOf({ type: "person", id: userId }) || t("channel.unknownPerson") : t("team.sectors.nobody");
  // The lead or the stand-in, on the people's own screen: "Ninguém" first to clear it, then each person with their
  // photo and @handle, the one in place checked.
  const pick = (title: string, field: "leadUserId" | "backupUserId") => {
    openPersonChoose({
      title,
      people: people.map((m) => ({ userId: m.userId, name: m.name, sub: `@${m.handle}` })),
      picked: group[field] ?? null,
      none: t("team.sectors.nobody"),
      apply: (userId) => {
        if (userId !== (group[field] ?? null)) latest.current(field, userId);
      },
    });
    router.push("/person-choose");
  };
  const renamed = (name ?? group.name).trim();
  const rename = () => {
    if (!renamed || renamed === group.name) return;
    action.mutate(
      { type: "update", groupId: group.id, name: renamed },
      {
        onSuccess: () => {
          successHaptic();
          setName(null);
        },
        onError: failed,
      },
    );
  };
  const agents = group.agentIds.flatMap((agentId) => {
    const a = dir.agentById.get(agentId);
    return a ? [a] : [];
  });
  return (
    <SettingsPage
      title={group.name}
      subtitle={t("team.agents", { count: agents.length })}
      // A change on its way: the bar's spinner where Save was, the page locked under it.
      busy={action.isPending}
      locked={remove.pending}
      {...(manages && renamed && renamed !== group.name
        ? { action: { label: t("common.save"), onPress: rename } }
        : {})}
    >
      <GroupedHeader>{t("agentGroups.group")}</GroupedHeader>
      <GroupedList>
        {manages ? (
          <GroupedField label={t("agentGroups.nameLabel")}>
            <TextInput
              value={name ?? group.name}
              onChangeText={setName}
              maxLength={NAME_MAX}
              autoCapitalize="words"
              returnKeyType="done"
              onSubmitEditing={rename}
              accessibilityLabel={t("agentGroups.nameLabel")}
              style={[styles.input, words, { color: c.ink }]}
            />
          </GroupedField>
        ) : null}
        <GroupedRow
          icon="person"
          label={t("team.sectors.leadLabel")}
          value={nameOf(group.leadUserId)}
          {...(manages ? { chevron: true, onPress: () => pick(t("team.sectors.leadLabel"), "leadUserId") } : {})}
        />
        <GroupedRow
          icon="members"
          label={t("team.sectors.backupLabel")}
          value={nameOf(group.backupUserId)}
          {...(manages ? { chevron: true, onPress: () => pick(t("team.sectors.backupLabel"), "backupUserId") } : {})}
        />
      </GroupedList>
      {!group.leadUserId ? <GroupedFooter>{t("team.sectors.gap.noLead")}</GroupedFooter> : null}
      <GroupedHeader>{t("mobile.agents.title")}</GroupedHeader>
      <GroupedList>
        {agents.map((a) => {
          // What it does in plain words, else its role; nothing under the name when it has neither.
          const does = plainRole(a.instructions) ?? a.role.trim();
          return (
            <GroupedRow
              key={a.id}
              leading={<AgentFace agentId={a.id} size={36} live={false} />}
              label={a.name}
              {...(does ? { sub: does } : {})}
              chevron
              onPress={() => router.push(`/agent/${a.id}`)}
            />
          );
        })}
        {agents.length === 0 ? <GroupedRow label={t("team.sectors.none")} faint /> : null}
      </GroupedList>
      {manages ? (
        <>
          <Gap />
          <GroupedList>
            <GroupedRow
              icon="trash"
              label={t("agentGroups.delete")}
              danger
              onPress={() =>
                remove.ask(group, () => {
                  leave();
                  goBack();
                })
              }
            />
          </GroupedList>
        </>
      ) : null}
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  input: { flex: 1, paddingVertical: 12, paddingHorizontal: 0 },
});
