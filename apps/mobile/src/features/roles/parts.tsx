import type { OrgRole, Person } from "@agenteschat/client";
import { ApiError, useApi, usePeople, useRoles, useSetMemberRoles } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { everyoneOf, roleName } from "@agenteschat/client/lib/roles";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import { useOrg } from "@/providers/org";
import {
  GROUPED_ROW,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  RoleMark,
  Text,
  usePulse,
  useTheme,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { Note } from "../ai/parts";
import { SettingsPage } from "../settings/parts";
import { useMeId } from "../shared/hooks";
import { errorHaptic } from "../shared/parts";
import { glanceLine, mailLossQuestion, OWNER_MARK, OWNER_ROLE, type Viewer } from "./logic";

/** The cargos' screens (`app/(app)/settings/roles/*`): a cargo's id, or `owner` for the owners'. */
export const rolesHref = {
  list: "/settings/roles",
  role: (roleId: string) => `/settings/roles/${roleId}`,
  tab: (tab: "permissions" | "channels" | "agents" | "people" | "look" | "add" | "rename", roleId: string) => ({
    pathname: `/settings/roles/${tab}`,
    params: { roleId },
  }),
  who: (roleId: string, row: string, step?: number) => ({
    pathname: "/settings/roles/who",
    params: { roleId, row, ...(step !== undefined ? { step: String(step) } : {}) },
  }),
  channel: (roleId: string, channelId: string) => ({
    pathname: "/settings/roles/channel",
    params: { roleId, channelId },
  }),
  agent: (roleId: string, agentId: string) => ({ pathname: "/settings/roles/agent", params: { roleId, agentId } }),
  person: (userId: string) => ({ pathname: "/settings/roles/person", params: { userId } }),
  create: "/settings/roles/new",
} as const;

/** The roles and the people, and who looks: what every cargo screen reads. */
export function useRolesData() {
  const { orgId, org } = useOrg();
  const roles = useRoles(orgId);
  const people = usePeople(orgId);
  const meId = useMeId();
  const viewer: Viewer = {
    role: org?.role ?? "member",
    rank: org?.rank,
    userId: meId ?? "",
    permissions: org?.permissions,
  };
  const everyone = roles.data ? everyoneOf(roles.data.roles) : undefined;
  return {
    orgId,
    org,
    data: roles.data,
    everyone,
    people: people.data,
    failed: roles.isError || people.isError,
    error: roles.error ?? people.error,
    retry: () => {
      void roles.refetch();
      void people.refetch();
    },
    viewer,
  };
}

/** A failed save, said in a toast with its cause; the control it came from is back where it was. */
export function useFail() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  return (e: unknown) => {
    errorHaptic();
    toast({ title: errorText(t, e, i18n.language), icon: "x" });
  };
}

/** The system's alert as a question: true on `action`, false on `cancel` or when it is dismissed. */
export function ask(question: { title: string; text?: string }, cancel: string, action: string, destructive = false) {
  return new Promise<boolean>((answer) =>
    Alert.alert(
      question.title,
      question.text,
      [
        { text: cancel, style: "cancel", onPress: () => answer(false) },
        { text: action, style: destructive ? "destructive" : "default", onPress: () => answer(true) },
      ],
      { cancelable: true, onDismiss: () => answer(false) },
    ),
  );
}

/**
 * Giving people a cargo asks first when agents would lose a mailbox (only a mailbox's owner gives one, W9's step), and
 * sends what was asked (`mailLossSeen`): one given meanwhile makes the server refuse rather than take it unasked.
 * Resolves with the mailboxes agreed to (empty: none at stake), or null when the person went back.
 */
export function useMailLossAsk() {
  const { t } = useTranslation();
  const { orgId } = useRolesData();
  const api = useApi();
  return async (roleId: string, userIds: string[], anyway: string): Promise<string[] | null> => {
    const losses = await api.roles.mailLoss(orgId, roleId, userIds).catch((e: unknown) => {
      // An older server without the question: nothing to ask, as before it.
      if (e instanceof ApiError && e.status === 404) return [];
      throw e;
    });
    if (losses.length === 0) return [];
    return (await ask(mailLossQuestion(t, losses), t("common.back"), anyway)) ? losses.map((l) => l.accountId) : null;
  };
}

/**
 * Gives or takes one cargo of one person, the mailbox question first when giving; false when they went back or one is
 * running. Busy from the tap, the question included: a second save meanwhile would start from the same cargos and,
 * written last, drop the first one.
 */
export function useSetCargo() {
  const { t } = useTranslation();
  const { orgId } = useRolesData();
  const set = useSetMemberRoles(orgId);
  const askMail = useMailLossAsk();
  const [running, setRunning] = useState(false);
  const inFlight = useRef(false);
  const save = async (person: Pick<Person, "userId" | "roleIds">, roleId: string, on: boolean, anyway?: string) => {
    const now = person.roleIds ?? [];
    if (!on) {
      await set.mutateAsync({ userId: person.userId, roleIds: now.filter((id) => id !== roleId) });
      return true;
    }
    const seen = await askMail(roleId, [person.userId], anyway ?? t("mobile.roles.mail.giveAnyway"));
    if (seen === null) return false;
    await set.mutateAsync({ userId: person.userId, roleIds: [...new Set([...now, roleId])], mailLossSeen: seen });
    return true;
  };
  const run: typeof save = async (...args) => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setRunning(true);
    try {
      return await save(...args);
    } finally {
      inFlight.current = false;
      setRunning(false);
    }
  };
  return { run, busy: running || set.isPending };
}

/** A cargo's mark: its color and icon (Todos' are its own), the owners' violet. */
export function CargoMark({ role, size }: { role: Pick<OrgRole, "color" | "icon"> | "owner"; size: number }) {
  const look = role === OWNER_ROLE ? OWNER_MARK : role;
  return <RoleMark color={look.color} icon={look.icon} size={size} />;
}

/**
 * A cargo screen while the roles load (rows of the list's shape, never a spinner), or why they didn't, with the
 * cause and Tentar de novo.
 */
export function Waiting({
  title,
  failed,
  error,
  retry,
}: {
  title: string;
  failed: boolean;
  error?: unknown;
  retry: () => void;
}) {
  const { t, i18n } = useTranslation();
  return (
    <SettingsPage title={title}>
      {failed ? (
        <>
          <View style={styles.note}>
            <Note icon="x">{t("mobile.roles.loadFailed", { cause: errorText(t, error, i18n.language) })}</Note>
          </View>
          <GroupedList>
            <GroupedRow icon="replay" label={t("common.retry")} onPress={retry} />
          </GroupedList>
        </>
      ) : (
        <>
          <GroupedHeader>{t("rolesPage.base")}</GroupedHeader>
          <GroupedList>
            <RowBones />
          </GroupedList>
          <GroupedHeader>{t("settings.section.roles")}</GroupedHeader>
          <GroupedList>
            <RowBones />
            <RowBones name={56} />
            <RowBones name={34} />
          </GroupedList>
        </>
      )}
    </SettingsPage>
  );
}

/** A cargo row's shape while it loads: the mark's circle, the name and the reach line, pulsing. */
function RowBones({ name = 44 }: { name?: number }) {
  const { colors } = useTheme();
  const pulse = usePulse();
  const bone = { backgroundColor: colors.sunken };
  return (
    <Animated.View
      style={[styles.bones, pulse]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <View style={styles.lead}>
        <View style={[styles.circle, bone]} />
      </View>
      <View style={styles.grow}>
        <View style={[styles.bar, bone, { width: `${name}%` }]} />
        <View style={[styles.bar, styles.small, bone, { width: "72%" }]} />
      </View>
    </Animated.View>
  );
}

/** A cargo's head on its page (P3): its mark, its name, the glance line. */
export function CargoHead({
  role,
  everyone,
  areas,
  people,
}: {
  role: OrgRole;
  everyone: OrgRole | undefined;
  areas: Parameters<typeof glanceLine>[3];
  people: number;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.head} accessible accessibilityRole="header">
      <CargoMark role={role} size={56} />
      <Text variant="title2" style={styles.center}>
        {roleName(t, role)}
      </Text>
      <Text variant="footnote" tone="muted" style={styles.center}>
        {glanceLine(t, role, everyone, areas, people)}
      </Text>
    </View>
  );
}

/** Back to the list when the cargo is gone (someone deleted it, or a link to one that never was). */
export function Gone({ title }: { title: string }) {
  const { t } = useTranslation();
  return (
    <SettingsPage title={title}>
      <View style={styles.note}>
        <Note icon="x">{t("errors.role.unknown")}</Note>
      </View>
      <GroupedList>
        <GroupedRow icon="back" label={t("mobile.roles.backToList")} onPress={() => router.replace(rolesHref.list)} />
      </GroupedList>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  note: { paddingHorizontal: 4, paddingVertical: 10 },
  bones: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: GROUPED_ROW.minHeight,
    paddingHorizontal: GROUPED_ROW.padX,
    paddingVertical: GROUPED_ROW.padY,
  },
  lead: { width: 36, alignItems: "center" },
  circle: { width: 30, height: 30, borderRadius: 15 },
  grow: { flex: 1, gap: 6 },
  bar: { height: 12, borderRadius: 6 },
  small: { height: 10 },
  head: { alignItems: "center", gap: 6, paddingTop: 12, paddingBottom: 8, paddingHorizontal: 16 },
  center: { textAlign: "center" },
});
