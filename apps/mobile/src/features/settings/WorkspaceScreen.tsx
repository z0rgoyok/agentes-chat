import {
  useComputerSetup,
  useConnections,
  useInvitations,
  useJoinRequests,
  useMachines,
  useOverview,
  useSkills,
  useStorage,
  useWorkspaceUsesApi,
} from "@agenteschat/client";
import { computerEdition } from "@agenteschat/client/lib/computer";
import { can } from "@agenteschat/client/lib/permissions";
import { settingsSectionNameKey } from "@agenteschat/client/lib/personal-view";
import type { TFunction } from "i18next";
import { Fragment, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/providers/org";
import { GroupedFooter, GroupedHeader, GroupedList, GroupedRow, haptics } from "@/ui";
import { router } from "@/ui/navigation";
import { OrgAvatar } from "../shared/OrgAvatar";
import { useLitPage, useOpenPage } from "../shared/SplitPanes";
import { usePersonalView } from "./hooks";
import {
  areaValues,
  GROUP_LABEL,
  PERSONAL_ICON,
  personalSections,
  SECTION_SHORT,
  SETTINGS_GROUPS,
  type SettingsEntry,
  type SettingsGroup,
  visibleSections,
} from "./logic";
import { confirmAction, Gap, SettingsPage } from "./parts";

/**
 * The workspace's settings, a screen pushed from Você on the grouped gray, as the phone's own settings: the web's
 * entries as groups, each thing once. Workspace: the workspace itself (its mark, its name, what Geral holds) and GIFs.
 * Pessoas, IA e uso, Conectores, Avançado: one neutral tile and one short value per row (a count or a state), the
 * area's own screen says the rest. Owners get "Apagar <nome>" alone in red at the end, behind the
 * system's alert (one firm haptic as it confirms), then the proof and the hold. A list of places to go, so it takes the
 * pushed lists' large title. Opened often, so nothing animates here beyond the rows' press highlight and the
 * platform's push. A personal workspace gets its short list instead
 * (ADR 0159 §3, `PersonalSettingsList`). On a large screen (ADR 0212) this is the left pane of `SettingsScreen`: a row
 * opens its screen beside the list (`useOpenPage`) and stays lit while it shows (`useLitPage`).
 */
export function WorkspaceScreen() {
  const { personal, others } = usePersonalView();
  return personal ? <PersonalSettingsList others={others} /> : <TeamSettingsList />;
}

/** A team's workspace settings: every section this person opens, in the phone's groups, then deleting it. */
function TeamSettingsList() {
  const { t } = useTranslation();
  const { org } = useOrg();
  return (
    <SettingsPage title={t("settings.title")} largeTitle>
      <SectionGroups areas={visibleSections(org)} />
      <DeleteWorkspaceRow />
    </SettingsPage>
  );
}

/**
 * A personal workspace's settings (ADR 0159 §3): one list with no group names. Your account, then About you, AI and
 * apps, Plan and usage, Vault and Computers (and People once someone else is a member), each opening the same screen
 * as in a team's; then Advanced, a screen of its own with every other section, delegated approvals and deleting the
 * workspace. Nothing here changes what anyone may open.
 */
function PersonalSettingsList({ others }: { others: number | undefined }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { main } = personalSections(org, others);
  const values = useAreaValues(main);
  // Pushed as always; beside the list on a large screen (ADR 0212), lit while it shows.
  const open = useOpenPage();
  const lit = useLitPage();
  return (
    <SettingsPage title={t("settings.title")} largeTitle>
      <Gap />
      <GroupedList>
        <GroupedRow
          key="account"
          icon="person"
          label={t("settings.section.account")}
          {...lit("/me/account")}
          chevron
          onPress={() => open("/me/account")}
        />
        {main.map((s) => (
          <GroupedRow
            key={s.id}
            icon={PERSONAL_ICON[s.id] ?? s.icon}
            label={t(settingsSectionNameKey(org, s.id))}
            {...(values[s.id] ? { value: values[s.id] } : {})}
            {...lit(s.href)}
            chevron
            onPress={() => open(s.href)}
          />
        ))}
      </GroupedList>
      <Gap />
      <GroupedList>
        <GroupedRow
          key="advanced"
          icon="list"
          label={t("settings.advanced")}
          {...lit("/settings/advanced")}
          chevron
          onPress={() => open("/settings/advanced")}
        />
      </GroupedList>
    </SettingsPage>
  );
}

/**
 * Sections in the phone's groups, each with its header: the workspace itself by its mark and name, the rest by a
 * neutral tile, a short name and one value. `extra`: rows a group ends with (a
 * personal workspace's delegated approvals under People); a group with none of either draws nothing.
 */
export function SectionGroups({
  areas,
  extra,
  untitled,
}: {
  areas: readonly SettingsEntry[];
  extra?: Partial<Record<SettingsGroup, ReactElement>>;
  /** The group the screen's own title already names (Advanced on the Advanced screen): its rows, no header. */
  untitled?: SettingsGroup;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const values = useAreaValues(areas);
  const name = org?.name ?? "";
  // Pushed as always (Advanced's own rows too); beside the settings' list on a large screen (ADR 0212), lit while it
  // shows.
  const open = useOpenPage();
  const lit = useLitPage();
  return (
    <>
      {SETTINGS_GROUPS.map((group) => {
        const rows = areas.filter((s) => s.group === group);
        const more = extra?.[group];
        if (rows.length === 0 && !more) return null;
        return (
          <Fragment key={group}>
            {group === untitled ? <Gap /> : <GroupedHeader>{t(GROUP_LABEL[group])}</GroupedHeader>}
            <GroupedList>
              {rows.map((s) =>
                s.id === "general" ? (
                  <GroupedRow
                    key={s.id}
                    leading={<OrgAvatar logo={org?.logo} size={36} />}
                    label={name}
                    sub={t("mobile.settings.editSub")}
                    {...lit(s.href)}
                    chevron
                    onPress={() => open(s.href)}
                  />
                ) : (
                  <GroupedRow
                    key={s.id}
                    icon={s.icon}
                    label={t(SECTION_SHORT[s.id] ?? `settings.section.${s.id}`)}
                    {...(values[s.id] ? { value: values[s.id] } : {})}
                    {...lit(s.href)}
                    chevron
                    onPress={() => open(s.href)}
                  />
                ),
              )}
              {more}
            </GroupedList>
          </Fragment>
        );
      })}
    </>
  );
}

/**
 * Deleting the workspace starts with the system's confirmation (one firm haptic as it confirms), then the proof and the
 * hold on a screen of their own: the same way from every row that offers it (here and on the owner's Account).
 */
export function confirmDeleteWorkspace(t: TFunction, name: string) {
  confirmAction({
    title: t("deleteOrg.title", { name }),
    text: t("mobile.settings.deleteAlert"),
    action: t("mobile.settings.deleteAction"),
    cancel: t("common.cancel"),
    onConfirm: () => {
      // One firm tap as the destructive step is taken, in the same moment the next screen comes.
      haptics.medium();
      router.push("/settings/delete");
    },
  });
}

/** Resetting the workspace: the system's confirmation first, as deleting it, then its own screen. */
export function confirmResetWorkspace(t: TFunction, name: string) {
  confirmAction({
    title: t("resetOrg.title", { name }),
    text: t("resetOrg.now"),
    action: t("resetOrg.submit"),
    cancel: t("common.cancel"),
    onConfirm: () => {
      haptics.medium();
      router.push("/settings/reset");
    },
  });
}

/**
 * Owners: "Reset workspace", then "Delete <name>" in red, each behind the system's alert (`confirmResetWorkspace`,
 * `confirmDeleteWorkspace`), then the proof and the hold on a screen of its own. Nothing for anyone else, nor while it is being deleted.
 */
export function DeleteWorkspaceRow() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const name = org?.name ?? "";
  if (org?.role !== "owner" || org.deletion) return null;
  return (
    <>
      <Gap />
      <Gap />
      <GroupedList>
        <GroupedRow label={t("resetOrg.row.title")} danger onPress={() => confirmResetWorkspace(t, name)} />
      </GroupedList>
      <GroupedFooter>{t("resetOrg.row.text")}</GroupedFooter>
      <Gap />
      <GroupedList>
        <GroupedRow
          label={t("mobile.settings.deleteName", { name })}
          danger
          onPress={() => confirmDeleteWorkspace(t, name)}
        />
      </GroupedList>
      <GroupedFooter>{t("mobile.settings.deleteFoot")}</GroupedFooter>
    </>
  );
}

/** Each area's value, as the web's tiles count (`areaValues`): asked only for the areas shown. */
function useAreaValues(areas: readonly SettingsEntry[]) {
  const { t, i18n } = useTranslation();
  const { orgId, org } = useOrg();
  const shown = (id: string) => areas.some((s) => s.id === id);
  const overview = useOverview(orgId);
  const invitations = useInvitations(orgId, can(org, "invite_people"));
  const waiting = useJoinRequests(orgId, shown("invites"));
  const connections = useConnections(orgId);
  const skills = useSkills(orgId, shown("skills"));
  const machines = useMachines(orgId, shown("computers"));
  const storage = useStorage(orgId, shown("storage"));
  const edition = computerEdition(useComputerSetup(orgId, shown("storage")).data);
  const usesApi = useWorkspaceUsesApi(orgId);
  return areaValues(t, i18n.language, {
    overview: overview.data,
    usesApi,
    invitations: invitations.data?.length,
    waiting: waiting.data?.length,
    connectors: connections.data?.filter((x) => !x.revokedAt).map((x) => x.label),
    skills: skills.data?.length,
    computers: machines.data
      ? { count: machines.data.length, online: machines.data.filter((m) => m.online).length }
      : undefined,
    storage: storage.data && edition ? { kind: storage.data.kind, edition } : undefined,
  });
}
