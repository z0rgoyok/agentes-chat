import type { OrgRole } from "@agenteschat/client";
import { useReorderRoles } from "@agenteschat/client";
import { formatInt } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import { isEveryone, peopleWith, roleName, sortRoles } from "@agenteschat/client/lib/roles";
import { matchesWords } from "@agenteschat/ui/search";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { GroupedFooter, GroupedHeader, GroupedList, GroupedRow, SearchField, Text, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { SettingsPage } from "../settings/parts";
import { useColors } from "../shared/hooks";
import { successHaptic, tapHaptic } from "../shared/parts";
import { moveRole, OWNER_ROLE, orderChanged, orderSteps, ROLES_MAX, ROLES_SEARCH_FROM, reachLine } from "./logic";
import { CargoMark, rolesHref, useFail, useRolesData, Waiting } from "./parts";

/** How long "Salvo" stays where Ordenar was after the order is saved. */
const SAVED_MS = 1800;

/**
 * Configurações › Cargos (P2), the web's list: Criar cargo, Todos pinned under Base with what it gives, then the owners
 * and the cargos top first, each with what it adds, its people as the value. Ordenar, in the header, gives each cargo
 * the viewer may move ▲ and ▼, and OK saves the order once.
 */
export function RolesScreen() {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const toast = useToast();
  const fail = useFail();
  const { orgId, org, data, everyone, people, failed, error, retry } = useRolesData();
  const reorder = useReorderRoles(orgId);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<OrgRole[] | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), SAVED_MS);
    return () => clearTimeout(timer);
  }, [saved]);
  const title = t("settings.section.roles");
  if (!data || !people) return <Waiting title={title} failed={failed} error={error} retry={retry} />;

  const list = sortRoles(data.roles.filter((r) => !isEveryone(r)));
  const order = draft ?? list;
  const manages = can(org, "manage_roles");
  const movable = manages && list.filter((r) => r.editable).length > 1;
  const owners = people.filter((p) => p.role === "owner");
  const ownerName = t("roles.owner");
  const shown = query.trim() ? order.filter((r) => matchesWords(r.name, query)) : order;
  const showOwner = !query.trim() || matchesWords(ownerName, query);
  const full = list.length >= ROLES_MAX;
  const ordering = draft !== null;

  const save = () => {
    if (!draft) return;
    if (!orderChanged(draft, list)) return setDraft(null);
    reorder.mutate(
      draft.map((r) => r.id),
      {
        onSuccess: () => {
          successHaptic();
          setDraft(null);
          setSaved(true);
        },
        onError: (e) => {
          setDraft(null);
          // The rows go back (the cache is rolled back); a stale list says how to get the new one.
          if ((e as { code?: string }).code === "role.order_incomplete")
            toast({
              title: t("mobile.roles.orderChanged"),
              icon: "x",
              action: { label: t("common.reload"), onPress: retry },
            });
          else fail(e);
        },
      },
    );
  };

  const headerWord = !movable ? null : reorder.isPending ? (
    <ActivityIndicator color={c.muted} />
  ) : (
    <Pressable
      accessibilityRole="button"
      // The word's 18-point line grown to a finger's 44.
      hitSlop={{ top: 13, bottom: 13, left: 12, right: 12 }}
      disabled={saved && !ordering}
      onPress={() => {
        tapHaptic();
        if (ordering) save();
        else {
          setQuery("");
          setDraft(list);
        }
      }}
    >
      <Text variant="footnote" style={[styles.word, { color: saved && !ordering ? c.faint : c.ink }]}>
        {ordering ? t("mobile.roles.orderDone") : saved ? t("common.saved") : t("mobile.roles.order")}
      </Text>
    </Pressable>
  );

  const row = (role: OrgRole) => {
    const steps = orderSteps(order, role.id);
    const name = roleName(t, role);
    return (
      <GroupedRow
        key={role.id}
        leading={<CargoMark role={role} size={30} />}
        label={name}
        labelLines={0}
        sub={reachLine(t, role, everyone, data.areas)}
        subLines={2}
        media
        {...(ordering
          ? {
              buttons: role.editable
                ? [
                    {
                      icon: "up" as const,
                      label: t("mobile.roles.up", { name }),
                      disabled: !steps.up,
                      onPress: () => setDraft((d) => moveRole(d ?? list, role.id, -1)),
                    },
                    {
                      icon: "down" as const,
                      label: t("mobile.roles.down", { name }),
                      disabled: !steps.down,
                      onPress: () => setDraft((d) => moveRole(d ?? list, role.id, 1)),
                    },
                  ]
                : [],
            }
          : {
              value: formatInt(i18n.language, peopleWith(role, people).length),
              chevron: true,
              onPress: () => router.push(rolesHref.role(role.id)),
            })}
      />
    );
  };

  return (
    <SettingsPage title={title} locked={reorder.isPending}>
      {manages ? (
        <GroupedList>
          <GroupedRow
            icon="plus"
            label={t("rolesPage.create")}
            disabled={full || ordering}
            onPress={() => router.push(rolesHref.create)}
          />
        </GroupedList>
      ) : null}
      {full && manages ? <GroupedFooter>{t("mobile.roles.tooMany")}</GroupedFooter> : null}
      {list.length > ROLES_SEARCH_FROM && !ordering ? (
        <View style={styles.search}>
          <SearchField
            value={query}
            onChangeText={setQuery}
            placeholder={t("mobile.roles.search")}
            accessibilityLabel={t("mobile.roles.search")}
            returnKeyType="search"
          />
        </View>
      ) : null}
      {everyone && !query.trim() ? (
        <>
          <GroupedHeader
            hint={{ name: t("common.about", { label: t("rolesPage.base") }), text: t("mobile.roles.baseHint") }}
          >
            {t("rolesPage.base")}
          </GroupedHeader>
          <GroupedList>
            <GroupedRow
              leading={<CargoMark role={everyone} size={30} />}
              label={roleName(t, everyone)}
              sub={reachLine(t, everyone, everyone, data.areas)}
              subLines={2}
              media
              value={formatInt(i18n.language, people.length)}
              chevron={!ordering}
              disabled={ordering}
              onPress={() => router.push(rolesHref.role(everyone.id))}
            />
          </GroupedList>
        </>
      ) : null}
      <GroupedHeader
        hint={{ name: t("common.about", { label: title }), text: t("mobile.roles.orderHint") }}
        aside={headerWord}
      >
        {`${title} · ${list.length + 1}`}
      </GroupedHeader>
      <GroupedList>
        {showOwner ? (
          <GroupedRow
            leading={<CargoMark role={OWNER_ROLE} size={30} />}
            label={ownerName}
            sub={t("mobile.roles.reach.owner")}
            subLines={2}
            media
            value={formatInt(i18n.language, owners.length)}
            chevron={!ordering}
            disabled={ordering}
            onPress={() => router.push(rolesHref.role(OWNER_ROLE))}
          />
        ) : null}
        {shown.map(row)}
      </GroupedList>
      {list.length === 0 ? <GroupedFooter>{t("mobile.roles.none")}</GroupedFooter> : null}
      {query.trim() && shown.length === 0 && !showOwner ? (
        <>
          <GroupedFooter>{t("mobile.roles.noMatch", { q: query.trim() })}</GroupedFooter>
          <GroupedList>
            <GroupedRow icon="x" label={t("filters.clearSearch")} onPress={() => setQuery("")} />
          </GroupedList>
        </>
      ) : null}
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  search: { paddingTop: 10 },
  word: { fontWeight: "600" },
});
