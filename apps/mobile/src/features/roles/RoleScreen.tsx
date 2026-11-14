import type { OrgRole, Person } from "@agenteschat/client";
import { useChangeRole, useCreateRole, useDeleteRole } from "@agenteschat/client";
import { formatInt } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import { holdsAll, isEveryone, peopleWith, roleLock, roleName } from "@agenteschat/client/lib/roles";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { GroupedFooter, GroupedHeader, GroupedList, GroupedRow, type IconName, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { Note } from "../ai/parts";
import { confirmAction, Gap, SettingsPage } from "../settings/parts";
import { Face } from "../shared/Face";
import { goBack, successHaptic } from "../shared/parts";
import { OWNER_ROLE, tabValues } from "./logic";
import { ask, CargoHead, CargoMark, Gone, rolesHref, useFail, useRolesData, Waiting } from "./parts";

/** A cargo's page (P3; `owner`: the owners', W11). */
export function RoleScreen({ roleId }: { roleId: string }) {
  const { t } = useTranslation();
  const { data, people, failed, error, retry } = useRolesData();
  const title = roleId === OWNER_ROLE ? t("roles.owner") : t("rolesPage.back");
  if (!data || !people) return <Waiting title={title} failed={failed} error={error} retry={retry} />;
  if (roleId === OWNER_ROLE) return <OwnerScreen people={people} />;
  const role = data.roles.find((r) => r.id === roleId);
  if (!role) return <Gone title={title} />;
  return <CargoPage role={role} people={people} />;
}

/**
 * A cargo (P3): its mark, name and glance on top, a lock note when it reads only, then its tabs as rows (Permissões,
 * Canais, Agentes, Pessoas, Nome, cor e ícone) and what can be done with it. Todos has no people, copy or delete.
 */
function CargoPage({ role, people }: { role: OrgRole; people: Person[] }) {
  const { t, i18n } = useTranslation();
  const fail = useFail();
  const toast = useToast();
  const { orgId, org, data, everyone } = useRolesData();
  const create = useCreateRole(orgId);
  const remove = useDeleteRole(orgId);
  if (!data) return null;
  const base = isEveryone(role);
  const name = roleName(t, role);
  const locked = roleLock(org ?? { role: "member" }, role);
  const holders = peopleWith(role, people);
  const values = tabValues(t, role, everyone, data.areas);
  const mine = !base && role.editable && holdsAll(org ?? { role: "member" }, role.permissions);
  const invites = !base && role.givable && can(org, "invite_people");
  const busy = create.isPending || remove.isPending;
  const tab = (key: "permissions" | "channels" | "agents" | "people" | "look") => () =>
    router.push(rolesHref.tab(key, role.id));
  const rows: { key: string; icon: IconName; label: string; value?: string; onPress: () => void }[] = [
    {
      key: "p",
      icon: "shield",
      label: t("mobile.roles.tabs.permissions"),
      value: values.permissions,
      onPress: tab("permissions"),
    },
    {
      key: "c",
      icon: "hash",
      label: t("mobile.roles.tabs.channels"),
      value: values.channels,
      onPress: tab("channels"),
    },
    { key: "a", icon: "agent", label: t("mobile.roles.tabs.agents"), value: values.agents, onPress: tab("agents") },
    ...(base
      ? []
      : [
          {
            key: "w",
            icon: "members" as const,
            label: t("rolesPage.peopleTitle"),
            value: formatInt(i18n.language, holders.length),
            onPress: tab("people"),
          },
        ]),
    { key: "l", icon: "pen", label: t("rolesPage.lookTitle"), onPress: tab("look") },
  ];
  const duplicate = () => {
    const copy = t("rolesPage.copyName", { name: role.name }).slice(0, 40);
    create.mutate(
      { name: copy, copyFrom: role.id },
      {
        onSuccess: (r) => {
          successHaptic();
          toast({ title: t("rolesPage.created", { name: copy }), icon: "check" });
          router.replace(rolesHref.role(r.id));
        },
        onError: fail,
      },
    );
  };
  const askDelete = () =>
    confirmAction({
      title: t("rolesPage.deleteTitle", { name }),
      text: t("common.joinSentences", { a: t("rolesPage.deleteText"), b: t("common.cantUndo") }),
      action: t("rolesPage.delete"),
      cancel: t("common.cancel"),
      onConfirm: () =>
        remove.mutate(role.id, {
          onSuccess: () => {
            successHaptic();
            toast({ title: t("rolesPage.deleted", { name }), icon: "trash" });
            goBack();
          },
          onError: fail,
        }),
    });
  return (
    <SettingsPage title={name} locked={busy}>
      <CargoHead role={role} everyone={everyone} areas={data.areas} people={holders.length} />
      {locked ? (
        <View style={styles.note}>
          <Note icon="lock">{t(`rolesPage.locked.${locked}`)}</Note>
        </View>
      ) : null}
      <Gap />
      <GroupedList>
        {rows.map((r) => (
          <GroupedRow
            key={r.key}
            icon={r.icon}
            label={r.label}
            {...(r.value ? { value: r.value } : {})}
            chevron
            onPress={r.onPress}
          />
        ))}
      </GroupedList>
      {invites || mine ? (
        <>
          <Gap />
          <GroupedList>
            {invites ? (
              <GroupedRow
                icon="person"
                label={t("mobile.roles.inviteWith")}
                onPress={() => router.push({ pathname: "/invite-people", params: { role: role.id } })}
              />
            ) : null}
            {mine ? <GroupedRow icon="copy" label={t("rolesPage.duplicate")} onPress={duplicate} /> : null}
            {mine ? <GroupedRow icon="trash" danger label={t("rolesPage.delete")} onPress={askDelete} /> : null}
          </GroupedList>
        </>
      ) : null}
    </SettingsPage>
  );
}

const OWNER_ITEMS: { icon: IconName; key: "transfer" | "owners" | "delete" }[] = [
  { icon: "swap", key: "transfer" },
  { icon: "members", key: "owners" },
  { icon: "trash", key: "delete" },
];

/** The owners as a cargo (W11): what only they do, each explained behind its ⓘ, and who they are. */
function OwnerScreen({ people }: { people: Person[] }) {
  const { t } = useTranslation();
  const fail = useFail();
  const toast = useToast();
  const { orgId, org, viewer } = useRolesData();
  const change = useChangeRole(orgId);
  const owners = people.filter((p) => p.role === "owner");
  const mine = can(org, "manage_owners");
  const owner = t("roles.owner");
  const sole = owners.length === 1;
  // As a cargo's ×: at once with Desfazer, asking first on oneself.
  const takeOut = async (p: Person) => {
    if (p.userId === viewer.userId) {
      const sure = await ask(
        {
          title: t("mobile.roles.people.selfTitle", { name: owner }),
          text: t("mobile.roles.people.selfText", { name: owner }),
        },
        t("common.cancel"),
        t("rolesPage.remove"),
        true,
      );
      if (!sure) return;
    }
    change.mutate(
      { userId: p.userId, role: "member" },
      {
        onSuccess: () => {
          successHaptic();
          toast({
            title: t("mobile.roles.people.removed", { person: p.name, name: owner }),
            icon: "check",
            action: {
              label: t("members.undo"),
              onPress: () => change.mutate({ userId: p.userId, role: "owner" }, { onError: fail }),
            },
          });
        },
        onError: fail,
      },
    );
  };
  return (
    <SettingsPage title={owner} locked={change.isPending}>
      <View style={styles.head}>
        <CargoMark role={OWNER_ROLE} size={56} />
      </View>
      <GroupedHeader>{t("rolesPage.owner.title")}</GroupedHeader>
      <GroupedList>
        {OWNER_ITEMS.map((i) => (
          <GroupedRow
            key={i.key}
            icon={i.icon}
            label={t(`rolesPage.owner.${i.key}`)}
            labelLines={2}
            hint={{
              name: t("common.about", { label: t(`rolesPage.owner.${i.key}`) }),
              text: t(`rolesPage.owner.${i.key}Desc`),
            }}
          />
        ))}
      </GroupedList>
      <GroupedFooter>{t("rolesPage.owner.sub")}</GroupedFooter>
      <GroupedHeader>{t("rolesPage.peopleTitle")}</GroupedHeader>
      <GroupedList>
        {mine ? (
          <GroupedRow
            icon="plus"
            label={t("mobile.roles.addOwners")}
            onPress={() => router.push(rolesHref.tab("add", OWNER_ROLE))}
          />
        ) : null}
        {owners.map((p) => (
          <GroupedRow
            key={p.userId}
            leading={<Face who={{ type: "person", id: p.userId }} size={30} live={false} />}
            label={p.userId === viewer.userId ? `${p.name}${t("common.youSuffix")}` : p.name}
            sub={p.email}
            subLines={2}
            media
            {...(mine && !sole
              ? {
                  remove: {
                    label: t("rolesPage.removeOf", { person: p.name, name: owner }),
                    onPress: () => void takeOut(p),
                  },
                }
              : {})}
          />
        ))}
      </GroupedList>
      <GroupedFooter>{sole ? t("rolesPage.soleOwner") : t("rolesPage.owner.foot")}</GroupedFooter>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  note: { paddingHorizontal: 4, paddingTop: 10 },
  head: { alignItems: "center", paddingTop: 12 },
});
