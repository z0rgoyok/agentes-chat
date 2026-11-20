import {
  useAllInvitations,
  useAuthConfig,
  useEditInviteLink,
  useInviteLinks,
  useResendInvitation,
  useRoles,
  useTurnOffInviteLink,
  useUpdateInvitation,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { formatShortDate } from "@agenteschat/client/lib/format";
import { changedLists, inviteRefusal, inviteRefusalText, type RefusedPick } from "@agenteschat/client/lib/invite-start";
import { sendsEmail } from "@agenteschat/client/lib/join-requests";
import { can } from "@agenteschat/client/lib/permissions";
import { useLocalSearchParams, usePreventRemove } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { GroupedFooter, GroupedHeader, GroupedList, GroupedRow, Locked, Text, useToast } from "@/ui";
import { Note } from "../ai/parts";
import { RowBones } from "../roles/parts";
import { Gap, SettingsPage } from "../settings/parts";
import { LoadFailed } from "../shared/FirstUse";
import { copyText, errorHaptic, goBack, successHaptic } from "../shared/parts";
import { EMPTY_INVITE, useDraftStart, useInviteDraft } from "./draft";
import { openPick, useStartFields } from "./InviteFields";
import { draftFrom, invitationExpired, linkChanges, maxWord, ttlWord } from "./logic";

/** How long "Copiado" stays on the copy row. */
const COPIED_MS = 1800;

/** A form's refused pick: its line, its token marked, and a haptic; anything else goes back to the caller. */
function useRefusal() {
  const [refused, setRefused] = useState<RefusedPick | null>(null);
  return {
    refused,
    take: (e: unknown) => {
      const r = inviteRefusal(e);
      if (!r || r.kind === "role") return false;
      errorHaptic();
      setRefused(r);
      return true;
    },
  };
}

/** The lines under a form's fields: a refused pick (danger) first, then Agentes' own lines. */
function Lines({ refused, lines }: { refused: RefusedPick | null; lines: readonly string[] }) {
  const { t } = useTranslation();
  return (
    <>
      {refused ? (
        <GroupedFooter>
          <Text variant="footnote" tone="danger">
            {inviteRefusalText(t, refused)}
          </Text>
        </GroupedFooter>
      ) : null}
      {lines.map((line) => (
        <GroupedFooter key={line}>{line}</GroupedFooter>
      ))}
    </>
  );
}

/**
 * Editar link (ADR 0184), pushed from a link's sheet on Convites: its address with Copiar link, then what an approval
 * gives (Cargo, Canais, Agentes) and the link's Validade and Máximo, its own date first, never a maximum below the
 * people it took. Salvar sends only what changed; the address stays the same. Desativar link at the end.
 */
export function EditLinkScreen() {
  const { t, i18n } = useTranslation();
  const { orgId, org } = useOrg();
  const { id = "" } = useLocalSearchParams<{ id?: string }>();
  const toast = useToast();
  const links = useInviteLinks(orgId, can(org, "invite_people"));
  const roles = useRoles(orgId).data?.roles;
  const link = links.data?.find((l) => l.id === id);
  const key = `link:${id}`;
  const edit = useEditInviteLink(orgId);
  const turnOff = useTurnOffInviteLink(orgId);
  const { refused, take } = useRefusal();
  const [copied, setCopied] = useState(false);
  useDraftStart(
    key,
    link && roles
      ? () => ({
          ...EMPTY_INVITE,
          ...draftFrom(roles, link),
          expiresIn: link.neverExpires ? "never" : null,
          maxUses: link.maxUses ?? null,
          ...(link.neverExpires ? {} : { until: link.expiresAt }),
          uses: link.uses ?? 0,
        })
      : null,
  );
  const draft = useInviteDraft(key);
  const start = useStartFields(key, draft, { refused });
  const busy = edit.isPending || turnOff.isPending;
  // While it saves, nothing goes back from under it; a finished save goes back itself.
  const leaving = useRef(false);
  usePreventRemove(busy, ({ repeat }) => {
    if (leaving.current) repeat();
  });
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const changes = link && draft ? linkChanges(link, start.send, draft) : {};
  const changed = Object.keys(changes).length > 0;
  const failed = (e: unknown) => toast({ title: errorText(t, e, i18n.language), icon: "x" });
  const save = async () => {
    if (!changed || busy) return;
    try {
      await edit.mutateAsync({ id, ...changes });
      successHaptic();
      toast({ title: t("invites.linkSaved") });
      leaving.current = true;
      goBack();
    } catch (e) {
      if (!take(e)) failed(e);
    }
  };
  const off = async () => {
    try {
      await turnOff.mutateAsync(id);
      toast({ title: t("invites.linkTurnedOff") });
      leaving.current = true;
      goBack();
    } catch (e) {
      failed(e);
    }
  };
  const confirmOff = () =>
    Alert.alert(t("members.link.turnOffTitle"), t("members.link.turnOffText", { count: link?.waiting ?? 0 }), [
      { text: t("mobile.common.cancel"), style: "cancel" },
      { text: t("members.link.turnOff"), style: "destructive", onPress: () => void off() },
    ]);
  const title = t("invites.editLink");
  if (!link || !draft)
    return (
      <SettingsPage title={title}>
        {links.isPending || !roles ? (
          <>
            <Gap />
            <GroupedList>
              <RowBones />
              <RowBones name={56} />
            </GroupedList>
          </>
        ) : links.isError ? (
          // Not loaded is not gone: what happened, and the way to ask again.
          <LoadFailed onRetry={() => void links.refetch()} />
        ) : (
          <GroupedFooter>{t("common.gone")}</GroupedFooter>
        )}
      </SettingsPage>
    );
  const url = link.url;
  const uses = link.uses ?? 0;
  return (
    <SettingsPage
      title={title}
      action={{ label: t("common.save"), onPress: () => void save(), disabled: !changed }}
      busy={busy}
    >
      {url ? (
        <>
          <GroupedHeader>{t("members.link.title")}</GroupedHeader>
          <GroupedList>
            <GroupedRow icon="link" label={url} labelLines={0} />
            <GroupedRow
              icon={copied ? "check" : "copy"}
              label={copied ? t("common.copied") : t("members.copyLink")}
              onPress={() =>
                void copyText(url).then((ok) => {
                  // A copy the system refused says so, never a row that did nothing.
                  if (!ok) return toast({ title: t("mobile.app.failed"), icon: "x" });
                  successHaptic();
                  setCopied(true);
                })
              }
            />
          </GroupedList>
        </>
      ) : null}
      <GroupedHeader>{t("invites.onJoin")}</GroupedHeader>
      <GroupedList>{start.fields}</GroupedList>
      <Lines refused={refused} lines={start.lines} />
      <GroupedHeader>{t("invites.theLink")}</GroupedHeader>
      <GroupedList>
        <GroupedRow
          label={t("invites.expiresIn")}
          value={
            draft.expiresIn
              ? ttlWord(t, draft.expiresIn)
              : t("invites.untilDate", { date: formatShortDate(i18n.language, link.expiresAt) })
          }
          chevron
          onPress={() => openPick(key, "ttl")}
        />
        <GroupedRow
          label={t("invites.maxUses")}
          value={maxWord(t, draft.maxUses)}
          chevron
          onPress={() => openPick(key, "max")}
        />
      </GroupedList>
      {uses > 0 ? <GroupedFooter>{t("invites.usedSoFar", { count: uses })}</GroupedFooter> : null}
      <Gap />
      <GroupedList>
        <GroupedRow icon="x" label={t("invites.turnOff")} danger disabled={busy} onPress={confirmOff} />
      </GroupedList>
    </SettingsPage>
  );
}

/**
 * Editar convite (ADR 0090, 0184), pushed from an invitation's sheet: what the person gets on joining (Cargo, Canais,
 * Agentes), saved without sending anything; the link stays the same. An expired one says so and offers Renovar.
 */
export function EditInvitationScreen() {
  const { t, i18n } = useTranslation();
  const { orgId, org } = useOrg();
  const { id = "" } = useLocalSearchParams<{ id?: string }>();
  const toast = useToast();
  const invitations = useAllInvitations(orgId, can(org, "invite_people"));
  const roles = useRoles(orgId).data?.roles;
  const inv = invitations.data?.find((i) => i.id === id);
  const key = `invitation:${id}`;
  const update = useUpdateInvitation(orgId);
  const resend = useResendInvitation(orgId);
  const emails = sendsEmail(useAuthConfig().data);
  const { refused, take } = useRefusal();
  const [renewed, setRenewed] = useState(false);
  useDraftStart(key, inv && roles ? () => ({ ...EMPTY_INVITE, ...draftFrom(roles, inv) }) : null);
  const draft = useInviteDraft(key);
  const start = useStartFields(key, draft, { refused });
  const busy = update.isPending || resend.isPending;
  // While it saves, nothing goes back from under it; a finished save goes back itself.
  const leaving = useRef(false);
  usePreventRemove(busy, ({ repeat }) => {
    if (leaving.current) repeat();
  });
  const expired = Boolean(inv && invitationExpired(inv) && !renewed);
  const changes = inv ? changedLists(inv, start.send) : {};
  const changed = Object.keys(changes).length > 0;
  const failed = (e: unknown) => toast({ title: errorText(t, e, i18n.language), icon: "x" });
  const save = async () => {
    if (!inv || !changed || busy || expired) return;
    try {
      await update.mutateAsync({ id, ...changes });
      successHaptic();
      toast({ title: t("invites.invitationSaved", { email: inv.email }) });
      leaving.current = true;
      goBack();
    } catch (e) {
      if (!take(e)) failed(e);
    }
  };
  const renew = async () => {
    if (!inv) return;
    try {
      await resend.mutateAsync(id);
      setRenewed(true);
      successHaptic();
      toast({
        title: t(emails ? "members.invitations.renewed" : "members.invitations.renewedNoEmail", { email: inv.email }),
      });
    } catch (e) {
      failed(e);
    }
  };
  const title = t("invites.editInvitation");
  if (!inv || !draft)
    return (
      <SettingsPage title={title}>
        {invitations.isPending || !roles ? (
          <>
            <Gap />
            <GroupedList>
              <RowBones />
              <RowBones name={56} />
            </GroupedList>
          </>
        ) : invitations.isError ? (
          // Not loaded is not gone: what happened, and the way to ask again.
          <LoadFailed onRetry={() => void invitations.refetch()} />
        ) : (
          <GroupedFooter>{t("common.gone")}</GroupedFooter>
        )}
      </SettingsPage>
    );
  return (
    <SettingsPage
      title={title}
      action={{ label: t("common.save"), onPress: () => void save(), disabled: !changed || expired }}
      busy={busy}
    >
      {/* Whose it is, whole: a long address wraps here, where the bar would cut it. */}
      <GroupedFooter>{t("members.invitations.label", { email: inv.email })}</GroupedFooter>
      {expired ? (
        <>
          <View style={styles.note}>
            <Note icon="clock">{t("invites.invitationExpired")}</Note>
          </View>
          <GroupedList>
            <GroupedRow icon="replay" label={t("members.invitations.renew")} onPress={() => void renew()} />
          </GroupedList>
        </>
      ) : (
        <Gap />
      )}
      <Locked when={expired} readable>
        <GroupedList>{start.fields}</GroupedList>
      </Locked>
      <GroupedFooter>{t("members.invitations.roleText")}</GroupedFooter>
      <Lines refused={refused} lines={start.lines} />
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  note: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 8 },
});
