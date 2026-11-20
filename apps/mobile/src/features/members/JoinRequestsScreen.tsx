import {
  type JoinRequest,
  type OrgRole,
  useApproveJoinRequest,
  useDenyJoinRequest,
  useJoinRequests,
  useRoles,
  useWorkspaceLimits,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { joinNames } from "@agenteschat/client/lib/format";
import {
  approvalCargos,
  changedLists,
  inviteRefusal,
  inviteRefusalText,
  type RefusedPick,
} from "@agenteschat/client/lib/invite-start";
import { approvalNews, JOIN_REASON_MAX, waitsForRoom } from "@agenteschat/client/lib/join-requests";
import { membersFull } from "@agenteschat/client/lib/limits";
import { can } from "@agenteschat/client/lib/permissions";
import { Fragment, type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { Share, type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { useOrg } from "@/providers/org";
import {
  Button,
  Chip,
  EmptyState,
  GROUPED_ROW,
  Locked,
  PersonAvatar,
  SkeletonList,
  Text,
  useReducedMotion,
  useToast,
} from "@/ui";
import { Note } from "../ai/parts";
import { SettingsPage } from "../settings/parts";
import { LoadFailed } from "../shared/FirstUse";
import { useColors } from "../shared/hooks";
import { errorHaptic, successHaptic, useSurface } from "../shared/parts";
import { overLimit, TextArea } from "../shared/TextArea";
import { EMPTY_INVITE, useDraftStart, useInviteDraft } from "./draft";
import { useStartFields } from "./InviteFields";
import { draftFrom, focusedFirst, requestChips } from "./logic";
import { MembersFullNote } from "./MembersFullNote";

const REASON_LIMIT = { max: JOIN_REASON_MAX };
/**
 * Requests to join through an invitation link (ADR 0068, 0184), a screen pushed with the system's bar (the workspace
 * under its title): the web's Convites › Esperando você on the phone, opened by the push, Atividade's card and
 * `agenteschat://join-requests`. Each is approved with what its link gives (Cargo, Canais, Agentes, changed here first
 * if need be, each on its pushed choice over this screen; a suggestion starts on nothing past Todos), or denied with a
 * reason the person reads in the email. On a server that sends no email, approving hands the approver the invitation's
 * link to share. `focus`: the request tapped on Convites, on top. With no room left nobody can be approved, as on the
 * web, but an outside collaborator, who takes no seat (ADR 0191). A pull reads the requests again.
 */
export function JoinRequestsScreen({ focus }: { focus?: string | undefined }) {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const allowed = can(org, "invite_people");
  const list = useJoinRequests(orgId, allowed);
  const roles = useRoles(orgId);
  const full = membersFull(useWorkspaceLimits(orgId).data) !== null;
  // Every link handed over stays until the sheet closes: each is returned once, and the Share sheet can be dismissed.
  const [handOffs, setHandOffs] = useState<{ name: string; url: string }[]>([]);
  const orgName = org?.name ?? "";
  const share = (url: string) =>
    void Share.share({ message: t("mobile.onb.shareMessage", { org: orgName, url }) }).catch(() => undefined);

  let body: ReactNode;
  if (!allowed) body = <EmptyState size="inline" title={t("common.notAllowed")} />;
  // The cargos too before any card: each card starts on its link's choices from its first frame.
  else if (!list.data || !roles.data)
    body =
      list.isError || roles.isError ? (
        <LoadFailed
          onRetry={() => {
            if (list.isError) void list.refetch();
            if (roles.isError) void roles.refetch();
          }}
        />
      ) : (
        // The shape of what is coming, never a bare spinner.
        <SkeletonList rows={2} />
      );
  else if (list.data.length === 0) body = <EmptyState size="inline" title={t("members.requests.empty")} />;
  else
    body = focusedFirst(list.data, focus).map((r) => (
      <RequestCard
        key={r.id}
        request={r}
        roles={roles.data?.roles ?? []}
        full={full}
        onSend={(url) => {
          setHandOffs((all) => [...all, { name: r.name, url }]);
          share(url);
        }}
      />
    ));

  return (
    <SettingsPage
      title={t("members.requests.title")}
      {...(orgName ? { subtitle: orgName } : {})}
      onRefresh={() => Promise.allSettled([list.refetch(), roles.refetch()])}
    >
      {/* Cards answered here leave, and the links handed over arrive, while the screen is open: they fade. Those there
          as it opens simply are (the page skips its first entering). */}
      <View style={styles.list}>
        {handOffs.map((h) => (
          <HandOff key={h.url} name={h.name} onShare={() => share(h.url)} />
        ))}
        <MembersFullNote />
        {body}
      </View>
    </SettingsPage>
  );
}

const CARD_IN = FadeIn.duration(160);
const CARD_OUT = FadeOut.duration(120);

/**
 * A card of the screen that comes or goes while it is watched: it fades (none of it with reduced motion). No layout
 * transition: one would also stretch a card's own frame when denying swaps its answer for the reason field, the
 * words spilling past its edge while it grew.
 */
function Moving({ style, children }: { style: StyleProp<ViewStyle>; children: ReactNode }) {
  const reduced = useReducedMotion();
  return (
    <Animated.View entering={reduced ? undefined : CARD_IN} exiting={reduced ? undefined : CARD_OUT} style={style}>
      {children}
    </Animated.View>
  );
}

/**
 * One request: who and their address, its chips (`requestChips`), their note, then what approving gives (Cargo,
 * Canais, Agentes, starting on its link's choices, each opening its choice) and the answer. A link that took all its
 * people says so, and Aprovar waits until its maximum grows.
 */
function RequestCard({
  request: r,
  roles,
  full,
  onSend,
}: {
  request: JoinRequest;
  /** The workspace's cargos: the link's start on those the approver may give. */
  roles: readonly OrgRole[];
  /** No one more fits: only denying is left, but for an outside collaborator, who takes no seat. */
  full: boolean;
  onSend: (url: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const { orgId } = useOrg();
  const c = useColors();
  const surface = useSurface();
  const reduced = useReducedMotion();
  const chips = requestChips(t, i18n.language, r);
  const toast = useToast();
  const approve = useApproveJoinRequest(orgId);
  const deny = useDenyJoinRequest(orgId);
  const key = `request:${r.id}`;
  // The link's cargos, those still offered to this approver (the others said as left out); its channels and agents
  // as the link gives them.
  const { given, leftOut } = approvalCargos(roles, r.link?.roleIds ?? []);
  const opening =
    roles.length > 0
      ? () => ({
          ...EMPTY_INVITE,
          ...draftFrom(roles, {
            roleIds: given,
            channelIds: r.link?.channelIds ?? [],
            agentIds: r.link?.agentIds ?? [],
          }),
        })
      : null;
  useDraftStart(key, opening);
  // The link's choices from the first frame, before the draft is in place: nothing jumps.
  const draft = useInviteDraft(key) ?? opening?.() ?? null;
  const [refused, setRefused] = useState<RefusedPick | null>(null);
  const start = useStartFields(key, draft, { refused });
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const busy = approve.isPending || deny.isPending;
  const linkFull = r.link?.full === true;
  // Someone else answered first, or it ran out: said in words, and the list refreshes (the hooks refetch).
  const failed = (e: unknown) => {
    errorHaptic();
    const pick = inviteRefusal(e);
    if (pick && pick.kind !== "role") setRefused(pick);
    else toast({ title: errorText(t, e, i18n.language), icon: "x" });
  };

  // Awaited, not `mutate`'s callbacks: the answered card leaves the list (unmounting) before those would run, and
  // the link a server without email returns must still reach the approver.
  const approveIt = async () => {
    try {
      // Only roles still offered (one may have gone since it was picked); channels and agents only when changed, so
      // the link's own go as the server finds them now.
      const offered = approvalCargos(roles, start.send.roleIds).given;
      const changed = changedLists(
        { channelIds: r.link?.channelIds ?? [], agentIds: r.link?.agentIds ?? [] },
        { ...start.send, roleIds: [] },
      );
      const news = approvalNews(await approve.mutateAsync({ id: r.id, roleIds: offered, ...changed }));
      successHaptic();
      if ("send" in news) onSend(news.send);
      else
        toast({
          title:
            news.said === "joined"
              ? t("members.requests.joined", { name: r.name })
              : t("members.requests.invited", { email: r.email }),
        });
    } catch (e) {
      failed(e);
    }
  };
  const denyIt = async () => {
    if (overLimit(reason, REASON_LIMIT)) return;
    try {
      await deny.mutateAsync({ id: r.id, ...(reason.trim() ? { reason: reason.trim() } : {}) });
      toast({ title: t("members.requests.denied") });
    } catch (e) {
      failed(e);
    }
  };
  const lines = [...(refused ? [inviteRefusalText(t, refused)] : []), ...start.lines];

  return (
    <Moving style={[styles.card, surface]}>
      <View
        style={styles.who}
        accessible
        accessibilityLabel={`${t("members.requests.label", { name: r.name })}, ${r.email}`}
      >
        <PersonAvatar name={r.name} size={36} />
        <View style={styles.grow}>
          <Text variant="body" style={styles.bold} numberOfLines={2}>
            {r.name}
          </Text>
          <Text variant="small" tone="muted" numberOfLines={2}>
            {r.email}
          </Text>
        </View>
      </View>
      <View style={styles.chips}>
        {chips.unverified ? <Chip icon="mail" label={chips.unverified} /> : null}
        <Chip icon={r.outsideOf ? "globe" : r.suggestedBy ? "person" : "clock"} label={chips.asked} />
      </View>
      {/* Their note, in their words. */}
      {r.note ? (
        <Text variant="body" tone="ink">
          {t("members.requests.note", { note: r.note })}
        </Text>
      ) : null}
      {/* Denying swaps the answer for the reason, faded in place. */}
      {denying ? (
        <Animated.View key="deny" entering={reduced ? undefined : CARD_IN} style={styles.swap}>
          <Locked when={busy} style={styles.field}>
            <TextArea
              value={reason}
              onChangeText={setReason}
              placeholder={t("members.requests.reason")}
              accessibilityLabel={t("members.requests.denyTitle", { name: r.name })}
              limit={REASON_LIMIT}
              autoFocus
            />
            <Text variant="caption" tone="faint">
              {t("members.requests.reasonHelp")}
            </Text>
          </Locked>
          <View style={styles.acts}>
            <View style={styles.grow}>
              <Button
                variant="primary"
                wide
                label={t("members.requests.deny")}
                loading={deny.isPending}
                disabled={busy || overLimit(reason, REASON_LIMIT)}
                onPress={() => void denyIt()}
              />
            </View>
            <View style={styles.grow}>
              {/* Not denying after all: the card's answer comes back (a word for what it does, never a "Back"). */}
              <Button
                variant="ghost"
                wide
                label={t("mobile.common.cancel")}
                disabled={busy}
                onPress={() => setDenying(false)}
              />
            </View>
          </View>
        </Animated.View>
      ) : (
        <Animated.View key="answer" entering={reduced ? undefined : CARD_IN} style={styles.swap}>
          {/* Flat in the card (never a card in a card): the fields' text on the card's own 16 pt edge. */}
          <Locked when={busy} style={styles.rows}>
            {start.fields.map((field, i) => (
              <Fragment key={field.key}>
                {i > 0 ? <View style={[styles.divider, { backgroundColor: c.line2 }]} /> : null}
                {field}
              </Fragment>
            ))}
          </Locked>
          {lines.map((line, i) => (
            <Text key={line} variant="footnote" tone={refused && i === 0 ? "danger" : "faint"}>
              {line}
            </Text>
          ))}
          {leftOut.length > 0 ? (
            <Note icon="lock">{t("invites.roleLeftOut", { count: leftOut.length, roles: joinNames(leftOut, t) })}</Note>
          ) : null}
          {linkFull ? <Note icon="x">{t("errors.join.linkFullApproval")}</Note> : null}
          {r.outsideOf ? <Note icon="info">{t("members.requests.outsideSeat")}</Note> : null}
          <View style={styles.acts}>
            <View style={styles.grow}>
              <Button
                variant="primary"
                wide
                icon="check"
                label={t("members.requests.approve")}
                loading={approve.isPending}
                disabled={busy || waitsForRoom(r, full) || linkFull || !draft}
                onPress={() => void approveIt()}
              />
            </View>
            <View style={styles.grow}>
              <Button
                variant="secondary"
                wide
                label={t("members.requests.deny")}
                disabled={busy}
                onPress={() => setDenying(true)}
              />
            </View>
          </View>
        </Animated.View>
      )}
    </Moving>
  );
}

/** A server that sends no email: an approved person's invitation link, to share with them. */
function HandOff({ name, onShare }: { name: string; onShare: () => void }) {
  const { t } = useTranslation();
  const surface = useSurface();
  return (
    <Moving style={[styles.card, surface]}>
      <Text variant="title">{t("members.requests.copyTitle", { name })}</Text>
      <Text variant="small" tone="muted">
        {t("members.requests.copyText", { name })}
      </Text>
      <Button variant="primary" wide icon="share" label={t("mobile.joinRequests.share")} onPress={onShare} />
    </Moving>
  );
}

const styles = StyleSheet.create({
  // The cards on the grouped gray, a group's room above the first and between them.
  list: { gap: 12, paddingTop: 14 },
  card: { borderRadius: 20, paddingHorizontal: 16, paddingVertical: 14, gap: 10 },
  // The card's own column inside the swap.
  swap: { gap: 10 },
  who: { flexDirection: "row", alignItems: "center", gap: 10 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  grow: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  field: { gap: 6 },
  // A field pads its text as a grouped row does: pulled out by as much, the text meets the card's 16.
  rows: { marginHorizontal: -GROUPED_ROW.padX },
  // From the fields' text, as GroupedList's hairline for a row with no lead.
  divider: { height: StyleSheet.hairlineWidth, marginLeft: GROUPED_ROW.padX, marginRight: GROUPED_ROW.padX },
  acts: { flexDirection: "row", gap: 8 },
});
