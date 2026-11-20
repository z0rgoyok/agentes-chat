import { ApiError, type ArtifactSharing, useArtifact, useRoles, useSetArtifactSharing } from "@agenteschat/client";
import { CONVERSATION_ONLY, livesInPrivate, toggledSharing } from "@agenteschat/client/lib/drive";
import { errorText } from "@agenteschat/client/lib/errors";
import { joinNames } from "@agenteschat/client/lib/format";
import { filePath } from "@agenteschat/client/lib/message-links";
import { isEveryone, sortRoles } from "@agenteschat/client/lib/roles";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { serverUrl } from "@/lib/server";
import {
  Button,
  EmptyState,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  Icon,
  type IconName,
  Locked,
  RoleMark,
  SheetBar,
  SheetScreen,
  SkeletonList,
  Text,
  textLineOf,
  useToast,
} from "@/ui";
import { useFontScale } from "@/ui/text-scale";
import { leadBox } from "@/ui/type-scale";
import { Face } from "../shared/Face";
import { LoadFailed } from "../shared/FirstUse";
import { useColors, useDirectory, useMeId, useOrgId } from "../shared/hooks";
import { copyText, successHaptic } from "../shared/parts";

type Mode = ArtifactSharing["mode"];

const MODES: { mode: Mode; icon: IconName; label: string }[] = [
  { mode: "conversation", icon: "lock", label: "share.conversation" },
  { mode: "people", icon: "person", label: "share.people" },
  { mode: "everyone", icon: "globe", label: "share.everyone" },
];

const SAVED = {
  conversation: "share.savedConversation",
  people: "share.savedPeople",
  everyone: "share.savedEveryone",
} as const satisfies Record<Mode, string>;

/**
 * Compartilhar on the phone (ADR 0157), the web's share dialog as a sheet: the file's name, who sees it (changed in
 * place), who has access, and Copiar link, an address of the app. While only a private conversation sees the file,
 * it says people outside won't open the link, with the way to choose them right there. A file of the Drive itself
 * lives with its maker (amendment 2026-11-17): its first choice is "Só você" to its maker, who changes it with the
 * administrators.
 */
export function FileShareSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const orgId = useOrgId();
  const c = useColors();
  const fontScale = useFontScale();
  const toast = useToast();
  const dir = useDirectory();
  const meId = useMeId();
  const roles = useRoles(orgId);
  const query = useArtifact(orgId, id);
  const save = useSetArtifactSharing(orgId);
  const [picking, setPicking] = useState(false);
  const a = query.data;
  if (!a) {
    return (
      // The rows' shape while the file's details come; a file that's gone says so, a failure offers to try again.
      <SheetScreen>
        {query.error instanceof ApiError && query.error.status === 404 ? (
          <EmptyState size="inline" icon="file" title={t("errors.artifact.notFound")} />
        ) : query.isError ? (
          <LoadFailed onRetry={() => void query.refetch()} />
        ) : (
          <SkeletonList rows={4} />
        )}
      </SheetScreen>
    );
  }
  const sharing = a.sharing ?? CONVERSATION_ONLY;
  const listed = sharing.mode === "people" ? sharing : CONVERSATION_ONLY;
  const closed = livesInPrivate(a.audience);
  const canShare = closed && Boolean(a.canShare);
  const busy = save.isPending;
  // A file of the Drive itself: where it lives is its maker.
  const drive = a.audience.kind === "workspace";
  const maker = a.createdBy;
  const mine = maker.type === "person" && maker.id === meId;
  const makerName = dir.nameOf(maker);
  // "people" is chosen before anyone is picked: it's saved with the first one.
  const mode: Mode = picking && sharing.mode !== "people" ? "people" : sharing.mode;
  const apply = (next: ArtifactSharing) =>
    save.mutate(
      { id: a.id, sharing: next },
      {
        onSuccess: (saved) => {
          successHaptic();
          setPicking(false);
          const savedMode = saved.sharing?.mode ?? "conversation";
          const only = mine ? t("share.savedOnlyYou") : t("share.savedOnlyMaker", { name: makerName });
          toast({ title: drive && savedMode === "conversation" ? only : t(SAVED[savedMode]) });
        },
        onError: (e) => toast({ title: errorText(t, e, i18n.language), icon: "x" }),
      },
    );
  const choose = (m: Mode) => {
    if (m === "people") {
      if (sharing.mode !== "people") setPicking(true);
      return;
    }
    setPicking(false);
    if (m !== sharing.mode) apply({ mode: m, userIds: [], roleIds: [] });
  };
  const copy = async () => {
    if (await copyText(`${serverUrl().replace(/\/+$/, "")}${filePath(orgId, a.id)}`)) {
      successHaptic();
      toast({ title: t("share.copied"), icon: "link" });
    } else toast({ title: t("mobile.app.failed"), icon: "x" });
  };
  const aud = a.audience;
  const where =
    aud.kind === "dm"
      ? aud.between
        ? t("share.whereDmBetween", { names: joinNames(aud.between.map(dir.nameOf), t) })
        : aud.with
          ? t("share.whereDm", { name: dir.nameOf(aud.with) })
          : t("share.whereDmGone")
      : aud.kind === "channel"
        ? t("share.whereChannel", { name: aud.name })
        : mine
          ? t("share.you", { name: makerName })
          : makerName;
  const roleList = sortRoles((roles.data?.roles ?? []).filter((r) => !isEveryone(r)));
  // Who sees it where it lives (I do, to be here; a Drive file's maker) has nothing to gain from the list.
  const people = [...dir.memberById.values()].filter((m) => m.userId !== meId && !(drive && m.userId === maker.id));
  const personName = (userId: string) => {
    const name = dir.memberById.get(userId)?.name ?? t("channel.unknownPerson");
    return userId === meId ? t("share.you", { name }) : name;
  };
  const toggle = (kind: "user" | "role", who: string) => apply(toggledSharing(sharing, { kind, id: who }));
  // A sign beside words sits on their first line, where the eye reads it.
  const onLine = leadBox(textLineOf("body", fontScale), 16);

  return (
    <SheetScreen>
      {/* A task sheet: the close plate and the title in its bar, as every task sheet has them (no "Concluído" under it). */}
      <SheetBar inset title={t("share.title", { name: a.title })} onClose={onClose} />
      <Locked when={busy} style={styles.fields}>
        {closed ? (
          <View>
            <GroupedHeader>{t("whoSees.label")}</GroupedHeader>
            <GroupedList>
              {MODES.map((m) => (
                <GroupedRow
                  key={m.mode}
                  icon={m.icon}
                  label={
                    drive && m.mode === "conversation"
                      ? mine
                        ? t("share.onlyYou")
                        : t("share.onlyMaker", { name: makerName })
                      : t(m.label as "share.people")
                  }
                  checked={mode === m.mode}
                  disabled={!canShare}
                  onPress={() => choose(m.mode)}
                />
              ))}
            </GroupedList>
            {!canShare ? <GroupedFooter>{t(drive ? "share.readOnlyDrive" : "share.readOnly")}</GroupedFooter> : null}
          </View>
        ) : (
          <View style={styles.line}>
            <View style={onLine}>
              <Icon name="globe" size={16} color={c.muted} />
            </View>
            <Text tone="muted" style={styles.grow}>
              {t("share.open")}
            </Text>
          </View>
        )}
        {canShare && mode === "people" ? (
          <View>
            <GroupedHeader>{t("share.add")}</GroupedHeader>
            <GroupedList>
              {roleList.map((r) => (
                <GroupedRow
                  key={r.id}
                  label={r.name}
                  sub={t("share.role")}
                  leading={<RoleMark color={r.color} icon={r.icon} size={22} />}
                  checked={listed.roleIds.includes(r.id)}
                  onPress={() => toggle("role", r.id)}
                />
              ))}
              {people.map((m) => (
                <GroupedRow
                  key={m.userId}
                  label={personName(m.userId)}
                  leading={<Face who={{ type: "person", id: m.userId }} size={26} live={false} />}
                  checked={listed.userIds.includes(m.userId)}
                  onPress={() => toggle("user", m.userId)}
                />
              ))}
            </GroupedList>
            <GroupedFooter>{t("share.admins")}</GroupedFooter>
          </View>
        ) : null}
        {closed ? (
          <View>
            <GroupedHeader>{t("share.access")}</GroupedHeader>
            <GroupedList>
              {sharing.mode === "everyone" ? (
                <GroupedRow icon="globe" label={t("share.everyone")} />
              ) : drive ? (
                <GroupedRow label={where} leading={<Face who={maker} size={26} live={false} />} />
              ) : (
                <GroupedRow icon={aud.kind === "dm" ? "chat" : "hash"} label={where} />
              )}
              {listed.userIds.map((userId) => (
                <GroupedRow
                  key={userId}
                  label={personName(userId)}
                  leading={<Face who={{ type: "person", id: userId }} size={26} live={false} />}
                  {...(canShare
                    ? {
                        remove: {
                          label: t("share.remove", { name: personName(userId) }),
                          onPress: () => toggle("user", userId),
                        },
                      }
                    : {})}
                />
              ))}
              {listed.roleIds.map((roleId) => {
                const r = roleList.find((role) => role.id === roleId);
                const name = r?.name ?? t("share.role");
                return (
                  <GroupedRow
                    key={roleId}
                    label={name}
                    sub={t("share.role")}
                    {...(r
                      ? { leading: <RoleMark color={r.color} icon={r.icon} size={22} /> }
                      : { icon: "members" as const })}
                    {...(canShare
                      ? { remove: { label: t("share.remove", { name }), onPress: () => toggle("role", roleId) } }
                      : {})}
                  />
                );
              })}
            </GroupedList>
            {drive && sharing.mode === "conversation" ? <GroupedFooter>{t("share.admins")}</GroupedFooter> : null}
          </View>
        ) : null}
        {closed && sharing.mode === "conversation" ? (
          <View style={styles.warn}>
            <View style={styles.line}>
              <View style={onLine}>
                <Icon name="lock" size={16} color={c.ink} />
              </View>
              <Text style={styles.grow}>
                {drive
                  ? mine
                    ? t("share.onlyYouLink")
                    : t("share.onlyMakerLink", { name: makerName })
                  : t("share.onlyHere")}
              </Text>
            </View>
            {canShare && !picking ? (
              <Button variant="secondary" wide label={t("share.choosePeople")} onPress={() => setPicking(true)} />
            ) : null}
          </View>
        ) : null}
        <Button variant="primary" wide icon="link" label={t("share.copyLink")} onPress={() => void copy()} />
      </Locked>
    </SheetScreen>
  );
}

const styles = StyleSheet.create({
  fields: { gap: 16 },
  line: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  grow: { flex: 1 },
  warn: { gap: 12 },
});
