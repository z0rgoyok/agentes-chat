import { ApiError, useSetRowHolders, useUpdateRole } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { COMPUTERS_ROW, isEveryone, levelOn, peopleWith, roleLock, roleName } from "@agenteschat/client/lib/roles";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { GroupedFooter, GroupedHeader, GroupedList, GroupedRow, SearchField, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { Note } from "../ai/parts";
import { chooseAction, SettingsPage } from "../settings/parts";
import { goBack, successHaptic, tapHaptic } from "../shared/parts";
import {
  heldStep,
  type PermissionRow,
  permissionGroups,
  roleNames,
  rowIntent,
  stepIntent,
  tickable,
  type WhoCan,
  whoCanChanged,
  whoCanHolders,
  whoCanLines,
  whoCanStart,
} from "./logic";
import { ask, CargoMark, Gone, rolesHref, useFail, useRolesData, Waiting } from "./parts";

const STEPS = [0, 1, 2, 3, 4] as const;
const stepKey = (n: number) => `mobile.roles.computers.steps.${n}` as "mobile.roles.computers.steps.0";

/**
 * A cargo's Permissões (P4): one flat list in the web's groups, searchable. A row everyone has reads "Todos podem" and
 * stays live: turning it off asks who keeps it (P5). The computers are one row of five steps. Administrador last,
 * asking first; on, the groups fold into one line. Every switch saves at once, one save at a time.
 */
export function RolePermissionsScreen({ roleId }: { roleId: string }) {
  const { t } = useTranslation();
  const fail = useFail();
  const toast = useToast();
  const { orgId, org, data, everyone, people, failed, error, retry, viewer } = useRolesData();
  const update = useUpdateRole(orgId);
  const [query, setQuery] = useState("");
  const title = t("mobile.roles.tabs.permissions");
  if (!data || !people) return <Waiting title={title} failed={failed} error={error} retry={retry} />;
  const role = data.roles.find((r) => r.id === roleId);
  if (!role) return <Gone title={title} />;
  const name = roleName(t, role);
  const locked = roleLock(org ?? { role: "member" }, role);
  const admin = !isEveryone(role) && role.permissions.includes("administrator");
  const groups = permissionGroups(t, role, data, viewer, query);
  const save = (permissions: string[]) =>
    update.mutate(
      { roleId: role.id, patch: { permissions } },
      {
        onError: (e) => {
          // Someone moved it above the viewer meanwhile: the page reads only now, and says why.
          if (e instanceof ApiError && e.code === "role.above_you")
            toast({ title: t("mobile.roles.nowAbove"), icon: "lock" });
          else fail(e);
        },
      },
    );
  const flip = async (r: PermissionRow) => {
    tapHaptic();
    const intent = rowIntent(role, everyone, r.row, r.level === 0);
    if (intent.kind === "who") return router.push(rolesHref.who(role.id, r.row));
    if (intent.kind === "save") return save(intent.permissions);
    const count = peopleWith(role, people).length;
    const text = t("mobile.roles.admin.text", { name });
    const sure = await ask(
      {
        title: t("mobile.roles.admin.title", { name }),
        text: count ? t("common.joinSentences", { a: text, b: t("mobile.roles.admin.count", { count }) }) : text,
      },
      t("common.cancel"),
      t("mobile.roles.admin.on"),
    );
    if (sure) save([...role.permissions, "administrator"]);
  };
  const pickStep = (r: PermissionRow) => {
    const base = everyone ? levelOn(everyone.permissions, COMPUTERS_ROW) : 0;
    const top = heldStep(viewer);
    chooseAction(
      r.title,
      STEPS.filter((n) => n <= top).map((n) => ({
        label: n === base && !isEveryone(role) ? `${t(stepKey(n))} · ${t("rolesPage.everyoneName")}` : t(stepKey(n)),
        checked: n === r.level,
        onPress: () => {
          if (n === r.level) return;
          const intent = stepIntent(role, everyone, n);
          if (intent.kind === "who") router.push(rolesHref.who(role.id, COMPUTERS_ROW, n));
          else save(intent.permissions);
        },
      })),
      t("common.cancel"),
    );
  };
  const rowFor = (r: PermissionRow) => {
    const off = Boolean(locked) || !r.held || update.isPending;
    const sub = !r.held
      ? t("mobile.roles.notHeld")
      : r.fromEveryone
        ? t("mobile.roles.everyoneCan")
        : r.level === 0 && r.holders.length
          ? t("mobile.roles.only", {
              names: roleNames(
                t,
                r.holders.map((h) => h.id),
                data.roles,
              ),
            })
          : undefined;
    if (r.row === COMPUTERS_ROW) {
      const step = t(stepKey(r.level));
      return (
        <GroupedRow
          key={r.row}
          label={r.title}
          labelLines={0}
          hint={{ name: t("common.about", { label: r.title }), text: r.desc }}
          sub={r.fromEveryone ? `${step} · ${t("rolesPage.everyoneName")}` : !r.held ? sub : step}
          subLines={2}
          menu
          disabled={off}
          onPress={() => pickStep(r)}
        />
      );
    }
    return (
      <GroupedRow
        key={r.row}
        label={r.title}
        labelLines={0}
        hint={{ name: t("common.about", { label: r.title }), text: r.desc }}
        {...(sub ? { sub, subLines: 2 } : {})}
        toggle={r.level > 0}
        disabled={off}
        onPress={() => void flip(r)}
      />
    );
  };
  return (
    <SettingsPage title={title} subtitle={name}>
      {locked ? (
        <View style={styles.note}>
          <Note icon="lock">{t(`rolesPage.locked.${locked}`)}</Note>
        </View>
      ) : null}
      <View style={styles.search}>
        <SearchField
          value={query}
          onChangeText={setQuery}
          placeholder={t("mobile.roles.searchPermission")}
          accessibilityLabel={t("mobile.roles.searchPermission")}
          returnKeyType="search"
        />
      </View>
      {admin && !query.trim() ? (
        <View style={styles.note}>
          <Note icon="shield">{t("mobile.roles.admin.note", { name })}</Note>
        </View>
      ) : null}
      {groups.map((g) => (
        <View key={g.id}>
          <GroupedHeader>{g.title}</GroupedHeader>
          <GroupedList>{g.rows.map(rowFor)}</GroupedList>
        </View>
      ))}
      {groups.length === 0 ? (
        <>
          <GroupedFooter>{t("mobile.roles.noPermissionMatch", { q: query.trim() })}</GroupedFooter>
          <GroupedList>
            <GroupedRow icon="x" label={t("filters.clearSearch")} onPress={() => setQuery("")} />
          </GroupedList>
        </>
      ) : (
        <GroupedFooter>{t("mobile.roles.peopleOnly")}</GroupedFooter>
      )}
    </SettingsPage>
  );
}

/**
 * Quem pode {{short}} (P5), pushed with Salvar: Todos, or only some cargos and which. A cargo with Administrador is
 * ticked and fixed, one above the viewer stays as it is. The consequence under it, then "Donos sempre podem.";
 * Salvar changes Todos and the cargos in one call. For the computers it asks who keeps Todos' step (`step`: the one
 * Todos goes down to).
 */
export function WhoCanScreen({ roleId, row, step }: { roleId: string; row: string; step?: number }) {
  const { t, i18n } = useTranslation();
  const { orgId, data, people, failed, error: loadError, retry, viewer } = useRolesData();
  const setRow = useSetRowHolders(orgId);
  const [edit, setEdit] = useState<Partial<Pick<WhoCan, "mode" | "ticked">>>({});
  const [error, setError] = useState<unknown>(null);
  const title = t("mobile.roles.whoCan");
  if (!data || !people) return <Waiting title={title} failed={failed} error={loadError} retry={retry} />;
  const from = data.roles.find((r) => r.id === roleId);
  if (!from) return <Gone title={title} />;
  const start = whoCanStart(data.roles, row, from, step);
  const who: WhoCan = { ...start, ...edit };
  const computers = row === COMPUTERS_ROW;
  const heading = computers ? t(stepKey(start.keep)) : t(`permissions.${row}.title` as "permissions.post.title");
  const roles = data.roles.filter((r) => !isEveryone(r)).sort((a, b) => a.position - b.position);
  const changed = whoCanChanged(data.roles, who);
  const save = () =>
    setRow.mutate(
      { row, holders: whoCanHolders(data.roles, who) },
      {
        onSuccess: () => {
          successHaptic();
          goBack();
        },
        onError: setError,
      },
    );
  const tick = (id: string) => {
    tapHaptic();
    setEdit((e) => {
      const next = new Set(e.ticked ?? start.ticked);
      if (!next.delete(id)) next.add(id);
      return { ...e, ticked: next };
    });
  };
  return (
    <SettingsPage
      title={title}
      action={{ label: t("common.save"), disabled: !changed, onPress: save }}
      busy={setRow.isPending}
    >
      {error ? (
        <View style={styles.note}>
          <Note icon="x">{errorText(t, error, i18n.language)}</Note>
        </View>
      ) : null}
      <GroupedHeader>{heading}</GroupedHeader>
      <GroupedList>
        <GroupedRow
          label={t("rolesPage.everyoneName")}
          sub={t("mobile.roles.everyoneSub")}
          checked={who.mode === "everyone"}
          onPress={() => setEdit((e) => ({ ...e, mode: "everyone" }))}
        />
        <GroupedRow
          label={t("mobile.roles.someRoles")}
          checked={who.mode === "some"}
          onPress={() => setEdit((e) => ({ ...e, mode: "some" }))}
        />
      </GroupedList>
      {who.mode === "some" ? (
        roles.some(tickable) ? (
          <>
            <GroupedHeader>{t("settings.section.roles")}</GroupedHeader>
            <GroupedList>
              {roles.map((r) => {
                const isAdmin = r.permissions.includes("administrator");
                const count = people.filter((p) => (p.roleIds ?? []).includes(r.id)).length;
                const fixed = isAdmin || !r.editable;
                return (
                  <GroupedRow
                    key={r.id}
                    leading={<CargoMark role={r} size={30} />}
                    label={r.name}
                    labelLines={0}
                    sub={
                      isAdmin
                        ? t("rolesPage.administrator")
                        : !r.editable
                          ? t("rolesPage.aboveYou")
                          : count
                            ? t("rolesPage.people", { count })
                            : t("mobile.roles.nobody")
                    }
                    media
                    checked={isAdmin || (fixed ? levelOn(r.permissions, row) >= who.keep : who.ticked.has(r.id))}
                    faint={fixed}
                    disabled={fixed}
                    onPress={() => tick(r.id)}
                  />
                );
              })}
            </GroupedList>
          </>
        ) : (
          <>
            <GroupedFooter>{t("mobile.roles.noOtherRoles")}</GroupedFooter>
            <GroupedList>
              <GroupedRow icon="plus" label={t("rolesPage.create")} onPress={() => router.push(rolesHref.create)} />
            </GroupedList>
          </>
        )
      ) : null}
      {whoCanLines(t, data.roles, people, who, viewer.userId).map((line) => (
        <GroupedFooter key={line}>{line}</GroupedFooter>
      ))}
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  note: { paddingHorizontal: 4, paddingTop: 10 },
  search: { paddingTop: 10 },
});
