import {
  type InviteLink,
  type InviteLinkMade,
  useAgents,
  useAiStatus,
  useAllInvitations,
  useAuthConfig,
  useChannels,
  useInviteLinks,
  useInviteMany,
  useMakeInviteLink,
  usePeople,
  useWorkspaceLimits,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { formatShortDate } from "@agenteschat/client/lib/format";
import { useHeldWhile } from "@agenteschat/client/lib/hold";
import {
  INVITE_LINK_DEFAULTS,
  INVITE_LINK_TTL,
  inviteRefusal,
  inviteRefusalText,
  type LinkChoices,
  plainLink,
  type RefusedPick,
  sameChoices,
} from "@agenteschat/client/lib/invite-start";
import { sendsEmail } from "@agenteschat/client/lib/join-requests";
import { membersFull } from "@agenteschat/client/lib/limits";
import { overLimitText } from "@agenteschat/client/lib/message-length";
import { aiStateOf, onlyOwnerReplies } from "@agenteschat/client/lib/no-ai";
import { can } from "@agenteschat/client/lib/permissions";
import { playSound } from "@agenteschat/client/lib/sounds";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { useLocalSearchParams, usePreventRemove } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Share, StyleSheet, TextInput, type TextInputInstance, View } from "react-native";
import { paysHere } from "@/lib/store";
import { useOrg } from "@/providers/org";
import {
  Button,
  fieldText,
  GroupedField,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  PersonAvatar,
  Segmented,
  Text,
  TOKEN_GAP,
  TOKEN_H,
  Token,
  TokenWrap,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { usePlanHold } from "../ai/parts";
import { Page } from "../me/parts";
import { Gap } from "../settings/parts";
import { useColors, useMeId } from "../shared/hooks";
import { copyText, errorHaptic, goBack, successHaptic } from "../shared/parts";
import { overLimit } from "../shared/TextArea";
import {
  EMPTY_INVITE,
  INVITE_NOTE_LIMIT,
  type InviteDraft,
  setInviteDraft,
  updateInviteDraft,
  useInviteDraft,
} from "./draft";
import { openPick, type StartFields, useStartFields } from "./InviteFields";
import {
  addressesLeft,
  addressState,
  batchNews,
  type InviteAddress,
  listedPlainLink,
  maxWord,
  pendingInvitations,
  readTyped,
  ttlWord,
  withAddresses,
} from "./logic";
import { MembersFullNote } from "./MembersFullNote";

/** Convidar pessoas' form, for the choices pushed over it. */
const KEY = "invite";
/** How long "Copiado" stays on the copy row. */
const COPIED_MS = 1800;
/** The address row while the workspace's link is first made: the three lines its address takes, so nothing moves. */
const ADDRESS_PENDING = "…\n\u00a0\n\u00a0";

/**
 * Convidar pessoas (ADR 0090 §5, 0184), the web's one-screen dialog as a pushed screen: E-mail or Link on top, then
 * the same fields under both, each label over its field: Para (by e-mail), Cargo, Canais and Agentes, the cargos
 * bringing their own channels and agents. A server that sends no email invites through links only. A personal
 * workspace first asks who they are (ADR 0159 §4, `WhoQuestion`) on a screen of its own: "Family or friends" pushes the
 * form over it (`?family=1`, the same address with what opened it), so the system's back returns to the question.
 */
export function InvitePeopleScreen() {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const held = usePlanHold(orgId, org) !== null;
  const allowed = can(org, "invite_people");
  const personal = isPersonal(org);
  const params = useLocalSearchParams<{ emails?: string; channel?: string; role?: string; family?: string }>();
  // Family or friends, in a personal workspace: the form's own step, pushed over the question (ADR 0159 §4).
  const family = params.family === "1";
  if (!allowed)
    return (
      <Page title={t("members.inviteTitle")}>
        <GroupedFooter>{t("common.notAllowed")}</GroupedFooter>
      </Page>
    );
  if (held)
    return (
      <Page title={t("members.inviteTitle")}>
        <GroupedFooter>
          {t("common.joinSentences", {
            a: t("standing.billing.invites"),
            b: t(paysHere(can(org, "manage_billing")) ? "connectAi.billingWeb" : "standing.billing.askAdmin"),
          })}
        </GroupedFooter>
      </Page>
    );
  if (personal && !family)
    return (
      <WhoQuestion
        onFamily={() => router.push({ pathname: "/invite-people", params: { ...forwarded(params), family: "1" } })}
      />
    );
  return <InviteForm family={family} />;
}

/** What opened the invitation (an agent's card's addresses, a channel, a cargo), carried on to the form's step. */
const forwarded = (p: { emails?: string; channel?: string; role?: string }) => ({
  ...(p.emails ? { emails: p.emails } : {}),
  ...(p.channel ? { channel: p.channel } : {}),
  ...(p.role ? { role: p.role } : {}),
});

/** `family`: pushed over the personal workspace's question, so sending leaves both screens. */
function InviteForm({ family }: { family: boolean }) {
  const { t, i18n } = useTranslation();
  const { orgId } = useOrg();
  const c = useColors();
  const toast = useToast();
  const byLink = !sendsEmail(useAuthConfig().data);
  const [mode, setMode] = useState<"email" | "link">(byLink ? "link" : "email");
  const people = usePeople(orgId).data ?? [];
  const invitations = useAllInvitations(orgId).data ?? [];
  const channels = useChannels(orgId).data ?? [];
  const full = membersFull(useWorkspaceLimits(orgId).data) !== null;
  const inviteMany = useInviteMany(orgId);
  const make = useMakeInviteLink(orgId);
  // Read while E-mail shows, so Link has the workspace's address at once.
  const links = useInviteLinks(orgId).data;
  const input = useRef<TextInputInstance | null>(null);
  const [typed, setTyped] = useState("");
  // A pick the server turned down (gone, or no longer the sender's to give): its token and its line until it's out.
  const [refused, setRefused] = useState<RefusedPick | null>(null);
  // An agent's invite card opens it with its addresses (`?emails=a@x,b@y`), a channel's add sheet with that channel, a
  // cargo's "Convidar com este cargo" with that cargo, which brings its channels and agents.
  const { emails, channel, role } = useLocalSearchParams<{ emails?: string; channel?: string; role?: string }>();
  const opening = useMemo<InviteDraft>(
    () => ({
      ...EMPTY_INVITE,
      roleIds: role ? [role] : [],
      addresses: emails ? withAddresses([], emails) : [],
      added: { channelIds: channel ? [channel] : [], agentIds: [] },
    }),
    [emails, channel, role],
  );
  useEffect(() => {
    setInviteDraft(KEY, opening);
    return () => setInviteDraft(KEY, null);
  }, [opening]);
  // The form as it opens until its draft is in place: the first frame already shows the cargo, nothing jumps.
  const draft = useInviteDraft(KEY) ?? opening;
  const start = useStartFields(KEY, draft, { refused });
  const sending = inviteMany.isPending || make.isPending;
  // While it sends, nothing goes back from under it; a finished send goes back itself, before the screen has seen it end.
  const leaving = useRef(false);
  usePreventRemove(sending, ({ repeat }) => {
    if (leaving.current) repeat();
  });

  // Who is in already, and who has an invitation waiting: said on their token and left out of the send.
  const members = useHeldWhile(new Set(people.map((m) => m.email.toLowerCase())), inviteMany.isPending);
  const invited = useHeldWhile(
    new Set(pendingInvitations(invitations).map((i) => i.email.toLowerCase())),
    inviteMany.isPending,
  );
  const stateOf = (a: InviteAddress) => addressState(a, members, invited);
  // What's still in the field counts: the button is pressed with the keyboard up, so the field never lost focus.
  const all = withAddresses(draft.addresses, typed);
  const ready = all.filter((a) => stateOf(a) === "ok");
  const bad = draft.addresses.some((a) => !a.valid);
  const leftOut = draft.addresses.some((a) => stateOf(a) === "member" || stateOf(a) === "invited");
  const note = draft.note.trim();
  // A note past its size is never cut: Convidar waits, and the line under the form says why.
  const longNote = overLimit(note, INVITE_NOTE_LIMIT);
  const refusedHere =
    refused && (refused.kind === "channel" ? start.send.channelIds : start.send.agentIds).includes(refused.id)
      ? refused
      : null;

  const add = (text: string) => updateInviteDraft(KEY, (d) => ({ ...d, addresses: withAddresses(d.addresses, text) }));
  const onType = (next: string) => {
    const read = readTyped(typed, next);
    if (read.add) add(read.add);
    setTyped(read.keep);
  };
  const commit = () => {
    if (typed.trim()) add(typed);
    setTyped("");
  };
  const remove = (email: string) =>
    updateInviteDraft(KEY, (d) => ({ ...d, addresses: d.addresses.filter((a) => a.email !== email) }));
  /** An address to fix goes back to the field. */
  const fix = (a: InviteAddress) => {
    commit();
    remove(a.email);
    setTyped(a.email);
    input.current?.focus();
  };
  const refusedBy = (e: unknown) => {
    const r = inviteRefusal(e);
    if (!r || r.kind === "role") return false;
    errorHaptic();
    setRefused(r);
    return true;
  };

  const send = async () => {
    if (ready.length === 0 || full || longNote || inviteMany.isPending) return;
    const { roleIds, channelIds, agentIds } = start.send;
    try {
      const results = await inviteMany.mutateAsync({
        emails: ready.map((a) => a.email),
        roleIds,
        channelIds,
        agentIds,
        ...(note ? { note } : {}),
      });
      const names = channelIds.flatMap((id) => {
        const ch = channels.find((x) => x.id === id);
        return ch ? [`#${ch.name}`] : [];
      });
      const news = batchNews(t, results, names);
      if (news)
        toast({
          title: news.title,
          ...(news.subtitle ? { subtitle: news.subtitle } : {}),
          ...(news.failed ? { icon: "x" as const } : {}),
        });
      if (news && !news.failed) {
        successHaptic();
        playSound("approved");
      }
      // Only addresses to fix stay.
      const left = addressesLeft(all, results);
      updateInviteDraft(KEY, (d) => ({ ...d, addresses: left }));
      setTyped("");
      if (left.length === 0) {
        leaving.current = true;
        // Sent: the whole flow goes, the question under the form included (never back onto it).
        if (family && router.canDismiss()) router.dismiss(2);
        else goBack();
      }
    } catch (e) {
      // The form stays as it was, to send again.
      if (!refusedBy(e)) toast({ title: errorText(t, e, i18n.language), icon: "x" });
    }
  };

  const tokenNote = (a: InviteAddress) => {
    const state = stateOf(a);
    return state === "bad"
      ? t("members.chips.check")
      : state === "member"
        ? t("members.chips.memberPersonal")
        : state === "invited"
          ? t("members.chips.invited")
          : undefined;
  };
  const lines = [
    ...(mode === "email" && bad ? [{ text: t("members.dialog.checkMarked"), danger: true }] : []),
    ...(mode === "email" && !bad && leftOut ? [{ text: t("members.dialog.leftOut"), danger: false }] : []),
    ...(mode === "email" && longNote
      ? [{ text: overLimitText(t, i18n.language, note.length, INVITE_NOTE_LIMIT.max), danger: true }]
      : []),
    ...(refusedHere ? [{ text: inviteRefusalText(t, refusedHere), danger: true }] : []),
    ...start.lines.map((text) => ({ text, danger: false })),
  ];

  return (
    <Page
      title={t("members.inviteTitle")}
      {...(mode === "email"
        ? {
            footer: (
              <Button
                variant="primary"
                wide
                label={ready.length > 0 ? t("members.dialog.send", { count: ready.length }) : t("members.invite")}
                disabled={ready.length === 0 || full || longNote}
                loading={inviteMany.isPending}
                onPress={() => void send()}
              />
            ),
          }
        : {})}
      locked={sending}
    >
      {byLink ? null : (
        <View style={styles.how}>
          <Segmented
            wide
            items={[
              { key: "email", label: t("invites.byEmail"), icon: "mail" },
              { key: "link", label: t("invites.byLink"), icon: "link" },
            ]}
            value={mode}
            onChange={(key) => setMode(key === "link" ? "link" : "email")}
          />
        </View>
      )}
      <MembersFullNote />
      <OnlyYouNote />
      {mode === "email" ? (
        <>
          <Gap />
          <GroupedList>
            <GroupedField
              key="to"
              stacked
              label={t("invites.to")}
              hint={{ name: t("common.about", { label: t("invites.to") }), text: t("members.dialog.pasteHelp") }}
            >
              {draft.addresses.length > 0 ? (
                <TokenWrap>
                  {draft.addresses.map((a) => {
                    const state = stateOf(a);
                    const said = tokenNote(a);
                    return (
                      <Token
                        key={a.email}
                        label={a.email}
                        leading={<PersonAvatar name={a.email} size={20} />}
                        {...(said ? { note: said } : {})}
                        tone={state === "bad" ? "bad" : state === "ok" ? "neutral" : "soft"}
                        {...(state === "bad" ? { onPress: () => fix(a) } : {})}
                        onRemove={() => remove(a.email)}
                        removeLabel={t("common.removeName", { name: a.email })}
                        fresh
                      />
                    );
                  })}
                </TokenWrap>
              ) : null}
              <TextInput
                ref={input}
                value={typed}
                onChangeText={onType}
                onSubmitEditing={commit}
                onBlur={commit}
                submitBehavior="submit"
                placeholder={t(draft.addresses.length > 0 ? "members.dialog.moreEmails" : "members.emailsPlaceholder")}
                placeholderTextColor={c.faint}
                keyboardType="email-address"
                textContentType="emailAddress"
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="email"
                spellCheck={false}
                returnKeyType="done"
                accessibilityLabel={t("invites.to")}
                style={[
                  fieldText("callout"),
                  styles.input,
                  draft.addresses.length > 0 ? styles.inputAfter : null,
                  { color: c.ink },
                ]}
              />
            </GroupedField>
            {start.fields}
            <GroupedField key="note" stacked label={t("members.dialog.note")} onPress={() => openPick(KEY, "note")}>
              <Text variant="callout" tone={note ? "ink" : "faint"} numberOfLines={2}>
                {note || t("mobile.invitePeople.optional")}
              </Text>
            </GroupedField>
          </GroupedList>
        </>
      ) : (
        <LinkMode draft={draft} start={start} make={make} onRefused={refusedBy} listed={listedPlainLink(links)} />
      )}
      {lines.map((l) => (
        <GroupedFooter key={l.text}>
          {l.danger ? (
            <Text variant="footnote" tone="danger">
              {l.text}
            </Text>
          ) : (
            l.text
          )}
        </GroupedFooter>
      ))}
      {mode === "link" ? (
        <>
          <GroupedHeader>{t("invites.theLink")}</GroupedHeader>
          <GroupedList>
            <GroupedRow
              label={t("invites.expiresIn")}
              value={ttlWord(t, draft.expiresIn ?? INVITE_LINK_TTL)}
              chevron
              onPress={() => openPick(KEY, "ttl")}
            />
            <GroupedRow
              label={t("invites.maxUses")}
              value={maxWord(t, draft.maxUses)}
              chevron
              onPress={() => openPick(KEY, "max")}
            />
          </GroupedList>
        </>
      ) : null}
    </Page>
  );
}

/**
 * Link mode: the link for these choices, then Ao entrar (Cargo, Canais, Agentes). At the defaults it is the
 * workspace's link, shown at once as listed and renewed to 30 days as the mode opens, so "Vale até" agrees; any other
 * choice empties it to "Criar link", and the link made shows until a choice changes again. A link made never changes
 * from here, only from Editar link (Convites).
 */
function LinkMode({
  draft,
  start,
  make,
  onRefused,
  listed,
}: {
  draft: InviteDraft;
  start: StartFields;
  /** Making a link with these choices: the form is locked while it runs. */
  make: ReturnType<typeof useMakeInviteLink>;
  onRefused: (e: unknown) => boolean;
  /** The workspace's link as listed (`listedPlainLink`): renewing keeps its address. */
  listed: (InviteLink & { url: string }) | undefined;
}) {
  const { t, i18n } = useTranslation();
  const { orgId, org } = useOrg();
  const toast = useToast();
  // The workspace's own link, renewed as the mode opens: quick, so nothing locks for it.
  const renew = useMakeInviteLink(orgId);
  const [workspace, setWorkspace] = useState<InviteLinkMade | null>(null);
  const [made, setMade] = useState<{ choices: LinkChoices; link: InviteLinkMade } | null>(null);
  const [copied, setCopied] = useState(false);
  const choices: LinkChoices = { ...start.send, expiresIn: draft.expiresIn ?? INVITE_LINK_TTL, maxUses: draft.maxUses };
  const plain = plainLink(choices);
  const failedText = (e: unknown) => t("invites.linkFailed", { cause: errorText(t, e, i18n.language) });
  // The workspace's link: asked once per visit, the first time the choices are at the defaults. The defaults are sent
  // because they renew it to 30 days at the same address; an empty body only returns it as it is.
  const asked = useRef(false);
  useEffect(() => {
    if (!plain || asked.current) return;
    asked.current = true;
    // A refusal can mean the link itself is closed (a workspace being deleted, a hold): say why, as the web does.
    renew.mutateAsync(INVITE_LINK_DEFAULTS).then(setWorkspace, (e: unknown) => {
      toast({ title: t("invites.linkFailed", { cause: errorText(t, e, i18n.language) }), icon: "x" });
    });
  }, [plain, renew, toast, t, i18n.language]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const shown =
    (made && sameChoices(made.choices, choices) ? made.link : null) ??
    (plain ? (workspace ?? (renew.isError ? null : (listed ?? null))) : null);
  // The listed link may have been revoked since the list was read: it copies once the renewal confirms it.
  const unconfirmed = !shown || shown === listed;
  // Idle too: the first frame, before the renewal starts, already holds the address's place.
  const renewing = plain && !shown && (renew.isIdle || renew.isPending);
  const create = async () => {
    try {
      const link = await make.mutateAsync(choices);
      setMade({ choices, link });
      successHaptic();
    } catch (e) {
      if (!onRefused(e)) toast({ title: failedText(e), icon: "x" });
    }
  };
  // While the address is first made the line stays, empty: "Crie o link" would point at a row that isn't there.
  const until = shown
    ? shown.neverExpires
      ? t("invites.ttl.never")
      : t("members.link.until", { date: formatShortDate(i18n.language, shown.expiresAt) })
    : renewing
      ? "\u00a0"
      : t("invites.linkEmpty");
  return (
    <>
      <GroupedHeader
        hint={{ name: t("common.about", { label: t("invites.byLink") }), text: t("members.dialog.orLink.text") }}
      >
        {t("invites.byLink")}
      </GroupedHeader>
      <GroupedList>
        {shown || renewing
          ? [
              <GroupedRow key="url" icon="link" label={shown?.url ?? ADDRESS_PENDING} labelLines={0} faint={!shown} />,
              <GroupedRow
                key="copy"
                icon={copied ? "check" : "copy"}
                label={copied ? t("common.copied") : t("members.copyLink")}
                disabled={unconfirmed}
                onPress={() =>
                  shown
                    ? void copyText(shown.url).then((ok) => {
                        // A copy the system refused says so, never a row that did nothing.
                        if (!ok) return toast({ title: t("mobile.app.failed"), icon: "x" });
                        successHaptic();
                        setCopied(true);
                      })
                    : undefined
                }
              />,
              <GroupedRow
                key="share"
                icon="share"
                label={t("mobile.joinRequests.share")}
                disabled={unconfirmed}
                onPress={() =>
                  shown
                    ? void Share.share({
                        message: t("mobile.onb.shareMessage", { org: org?.name ?? "", url: shown.url }),
                      }).catch(() => undefined)
                    : undefined
                }
              />,
            ]
          : [
              <GroupedRow
                key="make"
                icon="plus"
                label={t("members.link.make")}
                disabled={make.isPending}
                onPress={() => void create()}
              />,
            ]}
      </GroupedList>
      <GroupedFooter>{until}</GroupedFooter>
      <GroupedHeader>{t("invites.onJoin")}</GroupedHeader>
      <GroupedList>{start.fields}</GroupedList>
    </>
  );
}

/**
 * Before inviting to a personal workspace (ADR 0159 §4), the web's question: family or friends join and it stays
 * personal; people from work switch it to a team's first, on the mode screen (only who configures it can; for anyone
 * else that choice is off and says why), which comes back here in a team's words. Who may invite, and the roles,
 * stay as they are.
 */
function WhoQuestion({ onFamily }: { onFamily: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const switches = can(org, "configure");
  return (
    <Page title={t("members.inviteTitle")}>
      <GroupedHeader>{t("personalMode.invite.title")}</GroupedHeader>
      <GroupedList>
        <GroupedRow
          icon="members"
          label={t("personalMode.invite.family")}
          sub={t("personalMode.invite.familyText")}
          subLines={3}
          chevron
          onPress={onFamily}
        />
        <GroupedRow
          icon="laptop"
          label={t("personalMode.invite.work")}
          sub={t(switches ? "personalMode.invite.workText" : "personalMode.invite.workLocked")}
          subLines={3}
          {...(switches ? { chevron: true, onPress: () => router.push("/settings/mode") } : { disabled: true })}
        />
      </GroupedList>
      <GroupedFooter>{t("personalMode.invite.lead")}</GroupedFooter>
    </Page>
  );
}

/** Before inviting, while every agent with an AI answers only the person: they'd invite people to a silent team. */
function OnlyYouNote() {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const meId = useMeId();
  const agents = useAgents(orgId).data ?? [];
  const status = useAiStatus(orgId).data;
  const thinks = (id: string) => (aiStateOf(status, id) ?? "no_ai") !== "no_ai";
  if (!meId || !onlyOwnerReplies(agents, thinks, meId)) return null;
  return (
    <GroupedFooter>
      {t("common.joinSentences", { a: t("members.agentsOnlyYou"), b: t("members.agentsOnlyYouHint") })}
    </GroupedFooter>
  );
}

const styles = StyleSheet.create({
  how: { paddingTop: 8 },
  // The field's line under the tokens, a token's height so typing moves nothing.
  input: { minHeight: TOKEN_H, paddingVertical: 0, paddingHorizontal: 0 },
  inputAfter: { marginTop: TOKEN_GAP },
});
