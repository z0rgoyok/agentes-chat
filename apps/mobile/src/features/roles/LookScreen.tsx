import type { OrgRole } from "@agenteschat/client";
import { ApiError, useCreateRole, useUpdateRole } from "@agenteschat/client";
import { isEveryone, newRoleInput, ROLE_TEMPLATES, roleLock, roleName } from "@agenteschat/client/lib/roles";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { GroupedFooter, GroupedHeader, GroupedList, GroupedRow, Icon, RoleMark, roleMarkIcon, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { SettingsPage } from "../settings/parts";
import { useColors } from "../shared/hooks";
import { pickOne } from "../shared/PickerSheet";
import { goBack, successHaptic, tapHaptic } from "../shared/parts";
import { TextArea } from "../shared/TextArea";
import { copiesWhole, copyableRoles } from "./logic";
import { CargoMark, Gone, rolesHref, useFail, useRolesData, Waiting } from "./parts";

/** A cargo's name: at most this many letters (`ROLE_NAME_MAX` on the server). */
const NAME_MAX = 40;
/** The icon grid's cells (P9): four a row. */
const CELL = 52;
const PER_ROW = 4;

/**
 * Nome, cor e ícone (P9): the name (its own screen), the color's swatches, the icons in a 4 × 4 grid, and whether its
 * people show apart in the members list. Each change saves at once. Todos keeps its name and icon: only its color.
 */
export function RoleLookScreen({ roleId }: { roleId: string }) {
  const { t } = useTranslation();
  const fail = useFail();
  const { orgId, org, data, failed, error, retry } = useRolesData();
  const update = useUpdateRole(orgId);
  const title = t("rolesPage.lookTitle");
  if (!data) return <Waiting title={title} failed={failed} error={error} retry={retry} />;
  const role = data.roles.find((r) => r.id === roleId);
  if (!role) return <Gone title={title} />;
  const base = isEveryone(role);
  const off = roleLock(org ?? { role: "member" }, role) !== null || update.isPending;
  const patch = (p: Parameters<typeof update.mutate>[0]["patch"]) =>
    update.mutate({ roleId: role.id, patch: p }, { onError: fail });
  return (
    <SettingsPage title={title} subtitle={roleName(t, role)}>
      <GroupedHeader>{t("rolesPage.name")}</GroupedHeader>
      <GroupedList>
        <GroupedRow
          leading={<CargoMark role={role} size={30} />}
          label={roleName(t, role)}
          labelLines={0}
          media
          chevron={!base && !off}
          disabled={base || off}
          onPress={() => router.push(rolesHref.tab("rename", role.id))}
        />
      </GroupedList>
      <GroupedHeader
        hint={{ name: t("common.about", { label: t("rolesPage.color") }), text: t("rolesPage.colorDesc") }}
      >
        {t("rolesPage.color")}
      </GroupedHeader>
      <GroupedList>
        <ColorPick colors={data.colors} value={role.color} disabled={off} onPick={(color) => patch({ color })} />
      </GroupedList>
      {base ? (
        <GroupedFooter>{t("rolesPage.locked.everyone")}</GroupedFooter>
      ) : (
        <>
          <GroupedHeader
            hint={{ name: t("common.about", { label: t("rolesPage.icon") }), text: t("rolesPage.iconDesc") }}
          >
            {t("rolesPage.icon")}
          </GroupedHeader>
          <GroupedList>
            <IconPick icons={data.icons} value={role.icon} disabled={off} onPick={(icon) => patch({ icon })} />
          </GroupedList>
          <View style={styles.gap} />
          <GroupedList>
            <GroupedRow
              label={t("rolesPage.hoist")}
              labelLines={0}
              hint={{ name: t("common.about", { label: t("rolesPage.hoist") }), text: t("rolesPage.hoistDesc") }}
              toggle={role.hoist}
              disabled={off}
              onPress={() => patch({ hoist: !role.hoist })}
            />
          </GroupedList>
        </>
      )}
    </SettingsPage>
  );
}

/** The cargo's color: its swatches in one row, the chosen one ringed. */
function ColorPick({
  colors,
  value,
  disabled,
  onPick,
}: {
  colors: string[];
  value: string;
  disabled: boolean;
  onPick: (color: string) => void;
}) {
  const { t } = useTranslation();
  const c = useColors();
  return (
    <View style={styles.swatches} accessibilityRole="radiogroup" accessibilityLabel={t("rolesPage.color")}>
      {colors.map((color) => {
        const on = color === value;
        return (
          <Pressable
            key={color}
            accessibilityRole="radio"
            accessibilityLabel={t(`look.colors.${color}`, { defaultValue: color })}
            accessibilityState={{ checked: on, disabled }}
            disabled={disabled}
            // 38 points drawn, 46 to the finger: as far as half the gap to the next swatch.
            hitSlop={4}
            onPress={() => {
              if (on) return;
              tapHaptic();
              onPick(color);
            }}
            style={({ pressed }) => [
              styles.swatch,
              { borderColor: on ? c.ink : "transparent", opacity: disabled ? 0.5 : pressed && !on ? 0.6 : 1 },
            ]}
          >
            <RoleMark color={color} size={30} />
          </Pressable>
        );
      })}
    </View>
  );
}

/** The cargo's icon: the sixteen in rows of four 52-point cells, the chosen one ringed. */
function IconPick({
  icons,
  value,
  disabled,
  onPick,
}: {
  icons: string[];
  value: string;
  disabled: boolean;
  onPick: (icon: string) => void;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const rows = Array.from({ length: Math.ceil(icons.length / PER_ROW) }, (_, i) =>
    icons.slice(i * PER_ROW, i * PER_ROW + PER_ROW),
  );
  return (
    <View style={styles.icons} accessibilityRole="radiogroup" accessibilityLabel={t("rolesPage.icon")}>
      {rows.map((row) => (
        <View key={row.join()} style={styles.iconRow}>
          {row.map((name) => {
            const on = name === value;
            return (
              <Pressable
                key={name}
                accessibilityRole="radio"
                accessibilityLabel={t(`mobile.roles.icons.${name}`, { defaultValue: name })}
                accessibilityState={{ checked: on, disabled }}
                disabled={disabled}
                onPress={() => {
                  if (on) return;
                  tapHaptic();
                  onPick(name);
                }}
                style={({ pressed }) => [
                  styles.cell,
                  {
                    backgroundColor: pressed && !on ? c.plate : c.sunken,
                    borderColor: on ? c.ink : "transparent",
                    opacity: disabled ? 0.5 : 1,
                  },
                ]}
              >
                <Icon name={roleMarkIcon(name)} size={24} color={on ? c.ink : c.ink2} />
              </Pressable>
            );
          })}
          {/* A short last row keeps the columns. */}
          {Array.from({ length: PER_ROW - row.length }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: blank fillers, never reordered
            <View key={i} style={styles.cellGap} />
          ))}
        </View>
      ))}
    </View>
  );
}

/** A cargo's name, pushed over Nome, cor e ícone. */
export function RenameRoleScreen({ roleId }: { roleId: string }) {
  const { t } = useTranslation();
  const fail = useFail();
  const { orgId, data } = useRolesData();
  const update = useUpdateRole(orgId);
  const role = data?.roles.find((r) => r.id === roleId);
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? role?.name ?? "";
  const next = value.trim();
  const ready = Boolean(role?.editable) && next.length > 0 && next !== role?.name && !update.isPending;
  const save = () => {
    if (!role || !ready) return;
    update.mutate({ roleId: role.id, patch: { name: next } }, { onSuccess: () => goBack(), onError: fail });
  };
  return (
    <SettingsPage
      title={t("rolesPage.name")}
      action={{ label: t("common.save"), disabled: !ready, onPress: save }}
      busy={update.isPending}
    >
      <GroupedHeader hint={{ name: t("common.about", { label: t("rolesPage.name") }), text: t("rolesPage.nameDesc") }}>
        {t("rolesPage.name")}
      </GroupedHeader>
      <TextArea
        value={value}
        onChangeText={setDraft}
        multiline={false}
        minHeight={50}
        maxLength={NAME_MAX}
        autoFocus
        returnKeyType="done"
        onSubmitEditing={save}
        accessibilityLabel={t("rolesPage.name")}
      />
      {draft !== null && !next ? <GroupedFooter>{t("errors.role.nameRequired")}</GroupedFooter> : null}
    </SettingsPage>
  );
}

/**
 * Criar cargo (P10): its name and what it starts from, a value row with a menu (Do zero, the three templates, or
 * "Igual a" a cargo: one below the viewer is copied whole, its channels and agents too). Criar opens the new cargo.
 */
export function NewRoleScreen() {
  const { t } = useTranslation();
  const fail = useFail();
  const toast = useToast();
  const { orgId, data, viewer } = useRolesData();
  const create = useCreateRole(orgId);
  const [name, setName] = useState("");
  const [from, setFrom] = useState("blank");
  const typed = name.trim();
  const copies: OrgRole[] = data ? copyableRoles(data.roles, viewer) : [];
  const choices = [
    ...ROLE_TEMPLATES.map((x) => ({
      key: x.id,
      label: t(`rolesPage.templates.${x.id}`),
      sub: t(`rolesPage.templates.${x.id}Desc`),
      subLines: 2,
    })),
    ...copies.map((r) => ({
      key: `copy:${r.id}`,
      label: t("rolesPage.templates.copyOf", { name: r.name }),
      leading: { kind: "node" as const, node: <CargoMark role={r} size={24} /> },
    })),
  ];
  const chosen = choices.find((x) => x.key === from) ?? choices[0];
  const submit = () => {
    if (!typed || create.isPending) return;
    const source = copies.find((r) => `copy:${r.id}` === from);
    create.mutate(
      source && copiesWhole(source) ? { name: typed, copyFrom: source.id } : newRoleInput(typed, from, copies),
      {
        onSuccess: (r) => {
          successHaptic();
          toast({ title: t("rolesPage.created", { name: typed }), icon: "check" });
          router.replace(rolesHref.role(r.id));
        },
        onError: (e) =>
          e instanceof ApiError && e.code === "role.too_many"
            ? toast({ title: t("mobile.roles.tooMany"), icon: "x" })
            : fail(e),
      },
    );
  };
  return (
    <SettingsPage
      title={t("rolesPage.newTitle")}
      action={{ label: t("mobile.roles.create"), disabled: !typed, onPress: submit }}
      busy={create.isPending}
    >
      <GroupedHeader>{t("rolesPage.name")}</GroupedHeader>
      <TextArea
        value={name}
        onChangeText={setName}
        multiline={false}
        minHeight={50}
        maxLength={NAME_MAX}
        autoFocus
        returnKeyType="done"
        onSubmitEditing={submit}
        placeholder={t("rolesPage.namePlaceholder")}
        accessibilityLabel={t("rolesPage.name")}
      />
      <View style={styles.gap} />
      <GroupedList>
        <GroupedRow
          label={t("rolesPage.startFrom")}
          sub={chosen?.label ?? ""}
          subLines={2}
          menu
          onPress={() =>
            void pickOne({ title: t("rolesPage.startFrom"), options: choices, value: from }).then(
              (key) => key && setFrom(key),
            )
          }
        />
      </GroupedList>
      {chosen && "sub" in chosen ? <GroupedFooter>{chosen.sub}</GroupedFooter> : null}
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  gap: { height: 14 },
  swatches: { flexDirection: "row", flexWrap: "wrap", gap: 8, padding: 12 },
  // The ring's circle sits 2 out from the mark's, 2 wide: concentric.
  swatch: { padding: 2, borderRadius: 19, borderWidth: 2 },
  icons: { padding: 16, gap: 12 },
  iconRow: { flexDirection: "row", justifyContent: "space-between" },
  cell: {
    width: CELL,
    height: CELL,
    borderRadius: Math.round(CELL * 0.3),
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  cellGap: { width: CELL },
});
