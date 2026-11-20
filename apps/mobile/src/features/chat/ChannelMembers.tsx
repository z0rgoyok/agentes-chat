import {
  type AiRouting,
  type Channel,
  keys,
  type RosterMember,
  useAiStatus,
  useApi,
  useChannels,
  useLeaveChannel,
  useMuteChannel,
  useRoster,
} from "@agenteschat/client";
import { WORK_TICK_MS, workLine, workLineText } from "@agenteschat/client/lib/agent-work";
import { managesAgent, opensDetails } from "@agenteschat/client/lib/audience";
import { errorText } from "@agenteschat/client/lib/errors";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { useHeldWhile } from "@agenteschat/client/lib/hold";
import { isConnected, sheetGroups } from "@agenteschat/client/lib/member-groups";
import { can, leavesChannel, makesAgents, managesChannel, setsAutoReply } from "@agenteschat/client/lib/permissions";
import { agentMemberLine, agentStatusShort, agentWhyKey, isAgentOff, liveLine } from "@agenteschat/client/lib/presence";
import { joinsChannels } from "@agenteschat/client/lib/right-hand";
import { picksForMe, replyAloneKey } from "@agenteschat/client/lib/routing";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshControl, StyleSheet, View } from "react-native";
import { LayoutAnimationConfig } from "react-native-reanimated";
import { useOrg } from "@/providers/org";
import {
  Button,
  EmptyState,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  Locked,
  SCREEN_X,
  SearchField,
  SkeletonList,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { chooseAction, confirmAction, Gap, SettingsPage } from "../settings/parts";
import { AgentFace, Face, OpensAgent } from "../shared/Face";
import { LoadFailed } from "../shared/FirstUse";
import { useColors, useDirectory, useMeId, useNow, useOrgId, usePullRefresh } from "../shared/hooks";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { goBack, Loaded, successHaptic, tapHaptic, useLatest } from "../shared/parts";
import { usePresenceOf } from "../status/hooks";
import { lineText } from "../status/logic";
import { addTargets, channelMembersHrefs } from "./members";

/** Above this many members the list gets a search field (as the web's channel details). */
const SEARCH_FROM = 8;
/** A face in a members row: the lists' size, in GroupedRow's 36 column. */
const FACE = 30;

type Kind = "person" | "agent";
interface Who {
  kind: Kind;
  id: string;
  name: string;
  handle: string;
  email: string;
  autoReply: boolean;
  setsReply: boolean;
}

/** Refreshes who is in the channel after a change (the header's faces, the "@" picker, these screens). */
function useRefresh(channelId: string) {
  const orgId = useOrgId();
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: keys.roster(orgId, channelId) });
    void qc.invalidateQueries({ queryKey: keys.channelMembers(orgId, channelId) });
  };
}

/** An agent's line says how it answers my messages: on its own only while something reads the ones that mention nobody. */
const lineOf = (
  t: TFunction,
  w: Pick<Who, "kind" | "autoReply" | "handle" | "name" | "email">,
  routing: AiRouting | undefined,
) =>
  w.kind === "agent"
    ? !w.autoReply
      ? t("channelMembers.mentionLine", { handle: w.handle })
      : !picksForMe(routing)
        ? t(replyAloneKey(routing), agentGrammar(w.name))
        : t("channelMembers.aloneLine", agentGrammar(w.name))
    : w.email;

/**
 * "Tirar do canal", asked first in the system's confirmation (what it changes for them), then done: a toast says it and
 * the lists read who is in again. `after` runs once it is done (the agent's screen goes back).
 */
function useRemoveMember(channelId: string, channelName: string) {
  const { t, i18n } = useTranslation();
  const orgId = useOrgId();
  const api = useApi();
  const toast = useToast();
  const refresh = useRefresh(channelId);
  const remove = useMutation({
    mutationFn: (w: Pick<Who, "kind" | "id" | "name">) =>
      api.chat.removeMember(orgId, channelId, w.kind === "agent" ? { agentId: w.id } : { userId: w.id }),
    onSuccess: (_, w) => {
      successHaptic();
      refresh();
      toast({
        title: t("mobile.chat.memberRemoved", { name: w.name, channel: channelName }),
        ...(w.kind === "agent" ? { agentId: w.id } : { icon: "check" as const }),
      });
    },
    onError: (e) => toast({ title: errorText(t, e, i18n.language), icon: "x" }),
  });
  const ask = (w: Pick<Who, "kind" | "id" | "name">, after?: () => void) =>
    confirmAction({
      title: t("channelMembers.removeTitle", { name: w.name, channel: channelName }),
      text: t(
        w.kind === "agent" ? "channelMembers.removeAgentBody" : "channelMembers.removePersonBody",
        agentGrammar(w.name),
      ),
      action: t("channelMembers.removeConfirm"),
      cancel: t("common.cancel"),
      onConfirm: () => remove.mutate(w, after ? { onSuccess: () => after() } : {}),
    });
  return { ask, pending: remove.isPending };
}

/**
 * Who is in a channel (the web's channel details on the phone), a list screen pushed over the conversation (managing
 * is a screen, never a sheet), under the system's large title as the app's other pushed lists: the search first when
 * the list is long, agents and people in groups, off ones under Offline, each agent with what it does and how it
 * answers here; a pull reads who is in again. Whoever may manage the channel adds people and agents and takes them
 * out; an agent's owner sets how it answers; everyone reads the list. Muting and leaving the channel close it.
 */
export function ChannelMembersScreen({ channelId }: { channelId: string }) {
  const { t, i18n } = useTranslation();
  const orgId = useOrgId();
  const { org } = useOrg();
  const dir = useDirectory();
  const meId = useMeId();
  const c = useColors();
  const roster = useRoster(orgId, channelId);
  const pull = usePullRefresh(roster.refetch);
  const routing = useAiStatus(orgId).data?.routing;
  const channels = useChannels(orgId).data;
  // The channels by id, once per list: every agent's work line names where it works.
  const channelsById = useMemo(() => new Map((channels ?? []).map((ch) => [ch.id, ch])), [channels]);
  const channel = channelsById.get(channelId);
  const channelName = channel?.name ?? "";
  const removal = useRemoveMember(channelId, channelName);
  // An agent's work first, as the web's members column says it ("aqui" for this channel), then how it replies.
  const presence = usePresenceOf();
  const now = useNow(WORK_TICK_MS);
  const workText = (id: string) => {
    const line = workLine(
      t,
      i18n.language,
      presence.agent(id)?.work,
      {
        agentName: (x) => dir.agentById.get(x)?.name,
        channelName: (x) => channelsById.get(x)?.name,
        here: channelId,
      },
      now,
    );
    return line ? workLineText(line) : null;
  };
  const editable = managesChannel(channel, meId, org);
  const [q, setQ] = useState("");
  const all: Who[] = (roster.data ?? []).map((m: RosterMember) => ({
    kind: m.type === "agent" ? "agent" : "person",
    id: m.id,
    name: m.name,
    handle: m.handle ?? "",
    email: m.type === "agent" ? "" : (dir.memberById.get(m.id)?.email ?? ""),
    autoReply: Boolean(m.autoReply),
    setsReply: m.type === "agent" && setsAutoReply(channel, dir.agentById.get(m.id), meId, org),
  }));
  // The right hand (ADR 0137) is in no channel and isn't listed as a member: an @mention reaches it anywhere.
  const needle = q.trim().toLowerCase();
  const shown = all.filter((w) => !needle || `${w.name} ${w.handle} ${w.email}`.toLowerCase().includes(needle));
  // Off for now, as on the web: an agent out of office, held or with no AI, a person not here.
  const off = (w: Who) => {
    if (w.kind === "person") {
      const p = presence.person(w.id);
      return p !== null && !isConnected(p.presence);
    }
    const a = presence.agent(w.id);
    return a !== null && isAgentOff(a.presence);
  };
  const groups = sheetGroups(all, shown, off);
  const label = {
    agents: t("channelMembers.agents"),
    people: t("channelMembers.people"),
    offline: t("presence.offline"),
  };
  /** An off agent's line as the web's column (`agentMemberLine`), else its work and how it answers here. */
  const subtitleOf = (w: Who) => {
    if (w.kind === "person") return lineOf(t, w, routing);
    const a = presence.agent(w.id);
    const why = a ? agentWhyKey(a.presence, a.noAi) : null;
    if (!a || !why) return [workText(w.id), lineOf(t, w, routing)].filter(Boolean).join("\n");
    const own = liveLine(a.noAi ? null : a.status?.status, now);
    const under = agentMemberLine(workText(w.id), own && agentStatusShort(t, own, i18n.language), why);
    return under?.work ?? (under?.line ? lineText(under.line) : t(`presence.agentWhy.${why}`));
  };

  /**
   * What a row opens: an agent whose answers here can be set, or who can be taken out, its own screen; a person who can
   * be taken out, the short menu with that action (asked again before it goes); an agent with nothing to change here,
   * its profile. Not on my own row: taking myself out of my own list reads as a mistake (as on the web).
   */
  const opens = (w: Who, mine: boolean): RowOpens => {
    if (w.kind === "agent" && (w.setsReply || editable)) return "screen";
    if (w.kind === "person" && editable && !mine) return "menu";
    if (w.kind === "agent" && opensDetails(dir.anyAgent(w.id))) return "profile";
    return null;
  };
  // What a tap does, one function for every row (the rows are memoized), reading this render's state.
  const open = useLatest((w: Pick<Who, "kind" | "id" | "name">, what: Exclude<RowOpens, null>) => {
    if (what === "screen") router.push(channelMembersHrefs.agent(channelId, w.id));
    else if (what === "profile") router.push(`/agent/${w.id}`);
    else
      chooseAction(
        w.name,
        [{ label: t("channelMembers.remove"), icon: "x", destructive: true, onPress: () => removal.ask(w) }],
        t("common.cancel"),
      );
  });

  return (
    <PushedLargeTitle
      title={t("shell.members")}
      grouped
      keyboard
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
    >
      {/* The settings pages' body (`SettingsPage`): their sides, and what was there as it opened doesn't fade in. */}
      <Locked when={removal.pending} style={styles.page}>
        <LayoutAnimationConfig skipEntering>
          {all.length > SEARCH_FROM ? (
            <View style={styles.search}>
              <SearchField
                value={q}
                onChangeText={setQ}
                placeholder={t("channel.detailsSearch")}
                accessibilityLabel={t("channel.detailsSearch")}
                autoCorrect={false}
                returnKeyType="search"
              />
            </View>
          ) : null}
          <GroupedFooter>{t("channelMembers.caption")}</GroupedFooter>
          <Gap />
          {editable && !needle ? (
            <GroupedList>
              <GroupedRow
                icon="plus"
                label={t("channelMembers.addRow")}
                onPress={() => router.push(channelMembersHrefs.add(channelId))}
              />
            </GroupedList>
          ) : null}
          {roster.isPending ? (
            <SkeletonList rows={4} />
          ) : roster.isError ? (
            <LoadFailed onRetry={() => void roster.refetch()} />
          ) : needle && shown.length === 0 ? (
            <EmptyState
              size="inline"
              title={t("channel.detailsEmpty", { q: q.trim() })}
              action={
                <Button variant="secondary" size="sm" label={t("filters.clearSearch")} onPress={() => setQ("")} />
              }
            />
          ) : (
            <Loaded>
              {groups.map((g) =>
                g.rows.length > 0 ? (
                  <Fragment key={g.key}>
                    <GroupedHeader>{`${label[g.key]} · ${g.count}`}</GroupedHeader>
                    <GroupedList>
                      {g.rows.map((w) => {
                        const mine = w.kind === "person" && w.id === meId;
                        return (
                          <RosterRow
                            key={`${w.kind}:${w.id}`}
                            kind={w.kind}
                            id={w.id}
                            name={w.name}
                            label={mine ? `${w.name}${t("common.youSuffix")}` : w.name}
                            sub={subtitleOf(w)}
                            // Off for now (the web's Offline rows): in faint, under its own header.
                            faint={off(w)}
                            opens={opens(w, mine)}
                            ring={c.raised}
                            onOpen={open}
                            leading
                          />
                        );
                      })}
                    </GroupedList>
                  </Fragment>
                ) : null,
              )}
            </Loaded>
          )}
          {channel?.isMember ? (
            <>
              <Gap />
              <ChannelOwnActions channel={channel} />
            </>
          ) : null}
          {editable ? null : <GroupedFooter>{t("channelMembers.readOnly")}</GroupedFooter>}
        </LayoutAnimationConfig>
      </Locked>
    </PushedLargeTitle>
  );
}

/** What a member's row opens: its agent's screen here, the menu to take a person out, the agent's profile; nothing. */
type RowOpens = "screen" | "menu" | "profile" | null;

/**
 * One member: the face (an agent's opens its profile), the name, the line under it, faint while off. Drawn again only
 * when what it shows changes, not at every change of anyone's presence.
 */
const RosterRow = memo(function RosterRow({
  kind,
  id,
  name,
  label,
  sub,
  faint,
  opens,
  ring,
  onOpen,
}: {
  kind: Kind;
  id: string;
  name: string;
  label: string;
  sub: string;
  faint: boolean;
  opens: RowOpens;
  /** The surface the face's presence badge is ringed in. */
  ring: string;
  onOpen: (w: Pick<Who, "kind" | "id" | "name">, what: Exclude<RowOpens, null>) => void;
  /** Always with a face: GroupedList reads it to start the hairline after the face's column, as a GroupedRow's. */
  leading: boolean;
}) {
  const face = <Face who={{ type: kind, id }} size={FACE} live={false} presence ring={ring} />;
  const what = opens;
  const tap =
    what === null
      ? {}
      : { ...(what === "menu" ? { more: true } : { chevron: true }), onPress: () => onOpen({ kind, id, name }, what) };
  return (
    <GroupedRow
      // An agent's face opens its profile, as on every surface about it; the row its options.
      leading={kind === "agent" ? <OpensAgent agentId={id}>{face}</OpensAgent> : face}
      label={label}
      sub={sub}
      subLines={kind === "agent" ? 2 : 1}
      faint={faint}
      {...tap}
    />
  );
});

/**
 * What I do about a channel for myself, as the web's channel menu: mute it, and leave it. A public one goes at once;
 * a private one asks first, since only someone in it can bring me back, and the last person out archives it. Leaving
 * goes back past the conversation, which is no longer mine to read.
 */
function ChannelOwnActions({ channel }: { channel: Channel }) {
  const { t, i18n } = useTranslation();
  const orgId = useOrgId();
  const toast = useToast();
  const mute = useMuteChannel(orgId);
  const leave = useLeaveChannel(orgId);
  const roster = useRoster(orgId, channel.id);
  const failed = (e: unknown) => toast({ title: errorText(t, e, i18n.language), icon: "x" });
  const go = () =>
    leave.mutate(channel.id, {
      onSuccess: () => {
        successHaptic();
        toast({ title: t("channel.left", { channel: channel.name }), icon: "check" });
        // This screen and the conversation under it.
        router.dismiss(2);
      },
      onError: failed,
    });
  const ask = () => {
    if (channel.visibility !== "private") return go();
    const alone = (roster.data ?? []).filter((m) => m.type !== "agent").length === 1;
    confirmAction({
      title: t("channel.leaveTitle", { channel: channel.name }),
      text: t(alone ? "channel.leaveLast" : "channel.leavePrivate"),
      action: t(alone ? "channel.leaveLastConfirm" : "channel.leaveConfirm"),
      cancel: t("common.cancel"),
      onConfirm: go,
    });
  };
  const muted = Boolean(channel.muted);
  return (
    <GroupedList>
      <GroupedRow
        icon={muted ? "sound" : "mute"}
        label={t(muted ? "contextMenu.unmuteChannel" : "contextMenu.muteChannel")}
        disabled={mute.isPending}
        onPress={() => {
          tapHaptic();
          mute.mutate(
            { channelId: channel.id, muted: !muted },
            {
              onSuccess: () =>
                toast({
                  title: t(muted ? "mobile.chat.unmuted" : "mobile.chat.muted", { channel: channel.name }),
                  icon: muted ? "sound" : "mute",
                }),
              onError: failed,
            },
          );
        }}
      />
      {leavesChannel(channel) ? (
        <GroupedRow icon="out" label={t("channel.leave")} danger disabled={leave.isPending} onPress={ask} />
      ) : null}
    </GroupedList>
  );
}

/**
 * One agent in a channel, pushed from its row: who it is (its profile a tap away), how it answers here for whoever may
 * set it (on its own, or only when someone calls it), and "Tirar do canal" for whoever manages the channel.
 */
export function ChannelAgentScreen({ channelId, agentId }: { channelId: string; agentId: string }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const { org } = useOrg();
  const api = useApi();
  const dir = useDirectory();
  const meId = useMeId();
  const toast = useToast();
  const refresh = useRefresh(channelId);
  const roster = useRoster(orgId, channelId);
  const routing = useAiStatus(orgId).data?.routing;
  const channel = useChannels(orgId).data?.find((x) => x.id === channelId);
  const channelName = channel?.name ?? "";
  const member = roster.data?.find((m) => m.type === "agent" && m.id === agentId);
  const agent = dir.anyAgent(agentId);
  const name = member?.name ?? agent?.name ?? "";
  const g = agentGrammar(name);
  const editable = managesChannel(channel, meId, org);
  const setsReply = setsAutoReply(channel, dir.agentById.get(agentId), meId, org);
  const removal = useRemoveMember(channelId, channelName);
  // The choice shows at once; the server's answer confirms it, or the old one comes back with what happened.
  const [autoReply, setAutoReply] = useState<boolean | null>(null);
  const replies = autoReply ?? Boolean(member?.autoReply);
  const reply = useMutation({
    mutationFn: (on: boolean) => api.chat.setAutoReply(orgId, channelId, agentId, on),
    onMutate: (on) => {
      tapHaptic();
      setAutoReply(on);
    },
    onSuccess: refresh,
    onError: () => {
      setAutoReply(null);
      toast({ title: t("mobile.app.failed"), icon: "x" });
    },
  });
  // Taken out (here, from elsewhere meanwhile, or opened by an old link): nothing to set here any more. Once: the
  // removal's own success and the roster read again after it both lead here.
  const left = useRef(false);
  const leave = useCallback(() => {
    if (left.current) return;
    left.current = true;
    goBack();
  }, []);
  const gone = roster.isSuccess && !member;
  useEffect(() => {
    if (gone && !removal.pending) leave();
  }, [gone, removal.pending, leave]);
  const who = {
    kind: "agent" as const,
    id: agentId,
    name,
    handle: member?.handle ?? "",
    email: "",
    autoReply: replies,
  };

  return (
    <SettingsPage title={name} {...(channel ? { subtitle: `#${channelName}` } : {})} locked={removal.pending}>
      {roster.isPending ? (
        <SkeletonList rows={3} />
      ) : roster.isError ? (
        <LoadFailed onRetry={() => void roster.refetch()} />
      ) : member ? (
        <>
          <Gap />
          {/* The bar already says its name: the row is the way to its profile, not its name again. */}
          {agent && opensDetails(agent) ? (
            <GroupedList>
              <GroupedRow
                leading={<AgentFace agentId={agentId} size={FACE} live={false} />}
                label={t("profile.viewProfile")}
                chevron
                onPress={() => router.push(`/agent/${agentId}`)}
              />
            </GroupedList>
          ) : null}
          {/* How it answers here: the choice for whoever may set it, else said in a line. */}
          {setsReply ? null : <GroupedFooter>{lineOf(t, who, routing)}</GroupedFooter>}
          {setsReply ? (
            <>
              <GroupedHeader>{t("channelMembers.replyHeading", g)}</GroupedHeader>
              <GroupedList>
                <GroupedRow
                  label={t("channelMembers.replyAlone", g)}
                  sub={t(replyAloneKey(routing), g)}
                  subLines={0}
                  checked={replies}
                  disabled={reply.isPending}
                  onPress={() => !replies && reply.mutate(true)}
                />
                <GroupedRow
                  label={t("channelMembers.replyMention")}
                  sub={t("channelMembers.replyMentionHelp", { handle: who.handle })}
                  subLines={0}
                  checked={!replies}
                  disabled={reply.isPending}
                  onPress={() => replies && reply.mutate(false)}
                />
              </GroupedList>
            </>
          ) : null}
          {editable ? (
            <>
              <Gap />
              <GroupedList>
                <GroupedRow
                  icon="x"
                  label={t("channelMembers.remove")}
                  danger
                  disabled={removal.pending}
                  onPress={() => removal.ask(who, leave)}
                />
              </GroupedList>
            </>
          ) : null}
        </>
      ) : null}
    </SettingsPage>
  );
}

/**
 * Adds people and agents to the channel, pushed from its members: a search, a tap checks or unchecks someone, and the
 * bar's word adds everyone checked (as the web's dialog). Someone not in the workspace yet, or an agent still to make,
 * have screens of their own.
 */
export function AddChannelMembersScreen({ channelId }: { channelId: string }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const api = useApi();
  const toast = useToast();
  const dir = useDirectory();
  const meId = useMeId();
  const { org } = useOrg();
  const roster = useRoster(orgId, channelId);
  const refresh = useRefresh(channelId);
  const channelName = useChannels(orgId).data?.find((x) => x.id === channelId)?.name ?? "";
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const add = useMutation({
    mutationFn: async () => {
      for (const member of addTargets(selected)) await api.chat.addMember(orgId, channelId, member);
    },
    onSuccess: () => {
      successHaptic();
      refresh();
      toast({ title: t("mobile.chat.membersAdded", { count: selected.size, channel: channelName }), icon: "check" });
      goBack();
    },
    onError: (error) => {
      refresh();
      toast({ title: errorText(t, error), icon: "x" });
    },
  });
  // Who was in before Adicionar: the ones being added keep their rows until the screen moves on.
  const inChannel = useHeldWhile(
    new Set((roster.data ?? []).map((m) => `${m.type === "agent" ? "agent" : "person"}:${m.id}`)),
    add.isPending || add.isSuccess,
  );
  // Only the agents this person may place here, as the server's `requirePlacesAgent`: their own, or one they manage
  // (ADR 0085 addendum of 2026-11-17). Editing an agent, or talking to it, doesn't move it between channels.
  const candidates = [
    ...dir.agents
      .filter((a) => joinsChannels(a) && ((meId !== null && a.ownerUserId === meId) || managesAgent(a)))
      .map((a) => ({ kind: "agent" as const, id: a.id, name: a.name, line: `@${a.handle}` })),
    ...[...dir.memberById.values()].map((m) => ({
      kind: "person" as const,
      id: m.userId,
      name: m.name,
      line: m.email,
    })),
  ].filter((w) => !inChannel.has(`${w.kind}:${w.id}`));
  const needle = q.trim().toLowerCase();
  const rows = candidates.filter((w) => !needle || `${w.name} ${w.line}`.toLowerCase().includes(needle));
  const elsewhere = [
    ...(can(org, "invite_people")
      ? [
          {
            key: "invite",
            icon: "mail" as const,
            label: t("shell.invite"),
            href: `/invite-people?channel=${channelId}`,
          },
        ]
      : []),
    ...(makesAgents(org)
      ? [
          {
            key: "agent",
            icon: "plus" as const,
            label: t("shell.createAgent"),
            href: `/new-agent?channel=${channelId}`,
          },
        ]
      : []),
  ];
  const toggle = (key: string) => {
    tapHaptic();
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <SettingsPage
      title={t("channelMembers.addTitle", { channel: channelName })}
      action={{
        label:
          selected.size > 0 ? t("channelMembers.addConfirm", { count: selected.size }) : t("mobile.chat.membersAdd"),
        disabled: selected.size === 0,
        onPress: () => add.mutate(),
      }}
      busy={add.isPending}
    >
      <View style={styles.search}>
        <SearchField
          value={q}
          onChangeText={setQ}
          placeholder={t("channelMembers.addSearch")}
          accessibilityLabel={t("channelMembers.addSearch")}
          autoCorrect={false}
          returnKeyType="search"
        />
      </View>
      {roster.isPending || dir.loading ? (
        <SkeletonList rows={4} />
      ) : roster.isError ? (
        // Who is in already didn't load: listing everyone would offer to add them again.
        <LoadFailed onRetry={() => void roster.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          size="inline"
          title={
            needle
              ? t("channelMembers.addEmpty", { q: q.trim() })
              : t("channelMembers.addEveryone", { org: org?.name ?? "", channel: channelName })
          }
          {...(needle
            ? {
                action: (
                  <Button variant="secondary" size="sm" label={t("filters.clearSearch")} onPress={() => setQ("")} />
                ),
              }
            : {})}
        />
      ) : (
        <GroupedList>
          {rows.map((w) => {
            const key = `${w.kind}:${w.id}`;
            return (
              <GroupedRow
                key={key}
                leading={<Face who={{ type: w.kind, id: w.id }} size={FACE} live={false} />}
                label={w.name}
                {...(w.line ? { sub: w.line } : {})}
                checked={selected.has(key)}
                onPress={() => toggle(key)}
              />
            );
          })}
        </GroupedList>
      )}
      {elsewhere.length > 0 && !needle ? (
        <>
          <Gap />
          <GroupedList>
            {elsewhere.map((e) => (
              <GroupedRow
                key={e.key}
                icon={e.icon}
                label={e.label}
                chevron
                onPress={() => router.push(e.href as never)}
              />
            ))}
          </GroupedList>
        </>
      ) : null}
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  // A settings page's sides and top (`SettingsPage`'s body), under the large title.
  page: { paddingHorizontal: SCREEN_X, paddingTop: 4 },
  search: { paddingBottom: 12 },
});
