import { type InviteLinkTtl, useApi, useChannelCategories, useChannels, useRoles } from "@agenteschat/client";
import { formatShortDate } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { INVITE_LINK_MAX_USES, INVITE_LINK_TTLS, inviteStart } from "@agenteschat/client/lib/invite-start";
import { INVITE_NOTE_MAX } from "@agenteschat/client/lib/join-requests";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import { everyoneOf, ROLES_SEARCH_FROM } from "@agenteschat/client/lib/roles";
import { isPersonal, modeKey } from "@agenteschat/client/lib/workspace-mode";
import { matchesWords } from "@agenteschat/ui/search";
import { useQueries } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { GroupedFooter, GroupedHeader, GroupedList, GroupedRow, haptics, SearchField } from "@/ui";
import { router } from "@/ui/navigation";
import { openAgentAi } from "../ai/AgentAiScreen";
import { listedAgents } from "../roles/logic";
import { CargoMark } from "../roles/parts";
import { Gap, SettingsPage } from "../settings/parts";
import { AgentFace } from "../shared/Face";
import { useDirectory, useMeId } from "../shared/hooks";
import { goBack } from "../shared/parts";
import { TextArea } from "../shared/TextArea";
import { INVITE_NOTE_LIMIT, type InviteDraft, updateInviteDraft, useInviteDraft } from "./draft";
import type { InvitePick } from "./InviteFields";
import {
  agentMatches,
  agentPicks,
  asksMailboxes,
  cargoPicks,
  channelPicks,
  flipStart,
  fromCargosTitle,
  maxWord,
  ttlWord,
} from "./logic";

/**
 * A choice pushed over a form that says what someone gets (`app/(app)/invite-pick.tsx`): `draft` names the form,
 * `what` the choice. Each writes to the form as it is tapped; the single ones go back on their pick.
 */
export function InvitePickScreen() {
  const { t } = useTranslation();
  const { draft: key = "invite", what } = useLocalSearchParams<{ draft?: string; what?: InvitePick }>();
  const draft = useInviteDraft(key);
  // The form went away under it (a deep link replaced the stack): nothing to write to.
  if (!draft)
    return (
      <SettingsPage title={t("members.inviteTitle")}>
        <GroupedFooter>{t("common.gone")}</GroupedFooter>
      </SettingsPage>
    );
  const change = (next: (d: InviteDraft) => InviteDraft) => updateInviteDraft(key, next);
  if (what === "cargo") return <CargoPick draft={draft} change={change} />;
  if (what === "channels") return <ChannelsPick draft={draft} change={change} />;
  if (what === "agents") return <AgentsPick draft={draft} change={change} />;
  if (what === "ttl") return <TtlPick draft={draft} change={change} />;
  if (what === "max") return <MaxPick draft={draft} change={change} />;
  return <NotePick draft={draft} change={change} />;
}

interface PickProps {
  draft: InviteDraft;
  change: (next: (d: InviteDraft) => InviteDraft) => void;
}

/** Past `ROLES_SEARCH_FROM` rows a choice gets its search, as the cargo's own lists. */
function PickSearch({ value, onChange, label }: { value: string; onChange: (q: string) => void; label: string }) {
  return (
    <View style={styles.search}>
      <SearchField value={value} onChangeText={onChange} placeholder={label} accessibilityLabel={label} />
    </View>
  );
}

/** A search that names nothing: what was looked for, and a way to clear it. */
function NoMatch({ text, clear }: { text: string; clear: () => void }) {
  const { t } = useTranslation();
  return (
    <>
      <GroupedFooter>{text}</GroupedFooter>
      <GroupedList>
        <GroupedRow icon="x" label={t("filters.clearSearch")} onPress={clear} />
      </GroupedList>
    </>
  );
}

/**
 * Cargo: "Membro" first (no cargo past Todos), then the cargos this person may give, several at once, and one the form
 * already gives that they can't, to take out.
 */
function CargoPick({ draft, change }: PickProps) {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const [query, setQuery] = useState("");
  const [held] = useState(draft.roleIds);
  const roles = useRoles(orgId).data?.roles ?? [];
  const personal = isPersonal(org);
  const everyone = everyoneOf(roles);
  const picks = cargoPicks(t, roles, draft.roleIds, personal, held);
  const shown = picks.filter((p) => matchesWords(p.label, query));
  const flip = (id: string | null) =>
    change((d) => ({
      ...d,
      roleIds: id === null ? [] : d.roleIds.includes(id) ? d.roleIds.filter((x) => x !== id) : [...d.roleIds, id],
    }));
  return (
    <SettingsPage
      title={personal ? t("invites.rolePersonal") : t("members.role")}
      action={{ label: t("mobile.invitePeople.ok"), onPress: goBack }}
    >
      {picks.length > ROLES_SEARCH_FROM ? (
        <PickSearch value={query} onChange={setQuery} label={t("rolesPage.search")} />
      ) : null}
      {shown.length > 0 ? (
        <>
          <Gap />
          <GroupedList>
            {shown.map((p) => {
              const role = p.id === null ? everyone : roles.find((r) => r.id === p.id);
              return (
                <GroupedRow
                  key={p.id ?? "member"}
                  {...(role && !personal ? { leading: <CargoMark role={role} size={30} /> } : {})}
                  label={p.label}
                  labelLines={2}
                  sub={p.sub}
                  checked={p.on}
                  disabled={p.disabled}
                  onPress={() => flip(p.id)}
                />
              );
            })}
          </GroupedList>
          <GroupedFooter>
            {picks.some((p) => p.id !== null && !p.above) ? t("invites.rolesFoot") : t("members.noRolesToGive")}
          </GroupedFooter>
        </>
      ) : (
        <NoMatch text={t("rolesPage.noMatch", { q: query.trim() })} clear={() => setQuery("")} />
      )}
    </SettingsPage>
  );
}

/** Canais: what the picked cargos bring first, then the sidebar's categories; #general ticked and fixed. */
function ChannelsPick({ draft, change }: PickProps) {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const [query, setQuery] = useState("");
  const roles = useRoles(orgId).data?.roles ?? [];
  const channels = useChannels(orgId).data ?? [];
  const categories = useChannelCategories(orgId).data ?? [];
  const all = channelPicks(t, { channels, categories, roles, draft });
  const groups = query ? channelPicks(t, { channels, categories, roles, draft, query }) : all;
  const flip = (id: string) => change((d) => ({ ...d, ...flipStart(roles, d, "channelIds", id) }));
  return (
    <SettingsPage
      title={isPersonal(org) ? t("shell.channelsPersonal") : t("invites.channels")}
      action={{ label: t("mobile.invitePeople.ok"), onPress: goBack }}
    >
      {all.flatMap((g) => g.picks).length > ROLES_SEARCH_FROM ? (
        <PickSearch value={query} onChange={setQuery} label={t("rolesPage.channels.search")} />
      ) : null}
      {query && groups.length === 0 ? (
        <NoMatch text={t("rolesPage.channels.noMatch", { q: query.trim() })} clear={() => setQuery("")} />
      ) : null}
      {groups.map((g) => (
        // The one group without a title keeps its key while a search takes the cargo's group away above it.
        <View key={g.title ?? "none"}>
          {g.title ? <GroupedHeader>{g.title}</GroupedHeader> : <Gap />}
          <GroupedList>
            {g.picks.map((p) => (
              <GroupedRow
                key={p.channel.id}
                icon={p.channel.visibility === "private" ? "lock" : "hash"}
                label={p.channel.name}
                labelLines={0}
                {...(p.sub ? { sub: p.sub } : {})}
                checked={p.on}
                disabled={p.fixed}
                onPress={() => flip(p.channel.id)}
              />
            ))}
          </GroupedList>
        </View>
      ))}
    </SettingsPage>
  );
}

/**
 * Agentes: what the picked cargos bring first, then the team with the right hand on top (everyone has it), each row
 * saying how it would go. One that reads someone else's mailbox opens its page; one that keeps its plan for its owner
 * opens, for that owner, its "Atende outras pessoas"; the others that can't go are off, with their reason.
 */
function AgentsPick({ draft, change }: PickProps) {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const api = useApi();
  const meId = useMeId();
  const dir = useDirectory();
  const [query, setQuery] = useState("");
  const roles = useRoles(orgId).data?.roles ?? [];
  // Who may open an agent to them: its owner, or who manages that agent (`inviteAgentCase` reads it from the agent).
  const viewer = { userId: meId ?? "" };
  const listed = listedAgents(dir.agents);
  const right = dir.agents.find(isRightHand);
  const rightShown = right && agentMatches(right, query) ? right : undefined;
  const own = inviteStart(roles, draft.roleIds, NO_START, NO_START).agentIds;
  // Opening a restricted agent takes the mailboxes others gave it: asked for each one the viewer could open.
  const asked = listed.filter((a) => asksMailboxes(a, viewer, own));
  const mail = useQueries({
    queries: asked.map((a) => ({
      queryKey: ["org", orgId, "invite-mail-loss", a.id],
      queryFn: () => api.agents.mailLoss(orgId, a.id, { mode: "everyone", userIds: [], roleIds: [] }),
      staleTime: 30_000,
    })),
  });
  const mailboxOwners = (agentId: string) => {
    const i = asked.findIndex((a) => a.id === agentId);
    if (i < 0) return [];
    const q = mail[i];
    if (q?.data) return [...new Set(q.data.map((m) => m.ownerName ?? m.address))];
    // A failed ask lets it be picked: the server checks again, and a refusal says why.
    return q?.isError ? [] : undefined;
  };
  const { fromCargo, others } = agentPicks(t, {
    agents: listed,
    viewer,
    roles,
    draft,
    ownerName: (id) => (id ? (dir.memberById.get(id)?.name ?? null) : null),
    mailboxOwners,
    query,
  });
  const flip = (id: string) => change((d) => ({ ...d, ...flipStart(roles, d, "agentIds", id) }));
  const row = (p: (typeof others)[number]) => (
    <GroupedRow
      key={p.agent.id}
      leading={<AgentFace agentId={p.agent.id} size={30} live={false} />}
      label={p.agent.name}
      labelLines={2}
      {...(p.sub ? { sub: p.sub, subLines: 2 } : {})}
      checked={p.on}
      faint={p.disabled}
      disabled={p.disabled}
      chevron={Boolean(p.opens)}
      onPress={() =>
        p.opens === "agent"
          ? router.push(`/agent/${p.agent.id}`)
          : p.opens === "plan"
            ? openAgentAi(p.agent.id)
            : flip(p.agent.id)
      }
    />
  );
  return (
    <SettingsPage title={t("members.agents")} action={{ label: t("mobile.invitePeople.ok"), onPress: goBack }}>
      {listed.length + (right ? 1 : 0) > ROLES_SEARCH_FROM ? (
        <PickSearch value={query} onChange={setQuery} label={t("rolesPage.agents.search")} />
      ) : null}
      {fromCargo.length > 0 ? (
        <>
          <GroupedHeader>{fromCargosTitle(t, roles, draft.roleIds)}</GroupedHeader>
          <GroupedList>{fromCargo.map(row)}</GroupedList>
        </>
      ) : null}
      {rightShown || others.length > 0 ? (
        <>
          <GroupedHeader>{t("members.agents")}</GroupedHeader>
          <GroupedList>
            {rightShown ? (
              <GroupedRow
                key={rightShown.id}
                leading={<AgentFace agentId={rightShown.id} size={30} live={false} />}
                label={rightShown.name}
                sub={t("invites.agent.rightHand", agentGrammar(rightShown.name))}
                checked
                faint
                disabled
              />
            ) : null}
            {others.map(row)}
          </GroupedList>
        </>
      ) : null}
      {listed.length === 0 ? <GroupedFooter>{t("invites.noAgents")}</GroupedFooter> : null}
      {query && !rightShown && fromCargo.length + others.length === 0 ? (
        <NoMatch text={t("rolesPage.agents.noMatch", { q: query.trim() })} clear={() => setQuery("")} />
      ) : null}
    </SettingsPage>
  );
}

const NO_START = { channelIds: [], agentIds: [] };

/** Validade: how long the link works, from when it is made or saved; Editar link's own date first. */
function TtlPick({ draft, change }: PickProps) {
  const { t, i18n } = useTranslation();
  const choose = (expiresIn: InviteLinkTtl | null) => {
    haptics.selection();
    change((d) => ({ ...d, expiresIn }));
    goBack();
  };
  return (
    <SettingsPage title={t("invites.expiresIn")}>
      <Gap />
      <GroupedList>
        {draft.until ? (
          <GroupedRow
            key="keep"
            label={t("invites.untilDate", { date: formatShortDate(i18n.language, draft.until) })}
            checked={draft.expiresIn === null}
            onPress={() => choose(null)}
          />
        ) : null}
        {INVITE_LINK_TTLS.map((ttl) => (
          <GroupedRow key={ttl} label={ttlWord(t, ttl)} checked={draft.expiresIn === ttl} onPress={() => choose(ttl)} />
        ))}
      </GroupedList>
    </SettingsPage>
  );
}

/** Máximo de pessoas: the people the link takes; on Editar link never fewer than it already took. */
function MaxPick({ draft, change }: PickProps) {
  const { t } = useTranslation();
  const uses = draft.uses ?? 0;
  const choose = (maxUses: number | null) => {
    haptics.selection();
    change((d) => ({ ...d, maxUses }));
    goBack();
  };
  return (
    <SettingsPage title={t("invites.maxUses")}>
      <Gap />
      <GroupedList>
        {INVITE_LINK_MAX_USES.filter((max) => max === null || max >= uses).map((max) => (
          <GroupedRow
            key={String(max)}
            label={maxWord(t, max)}
            checked={draft.maxUses === max}
            onPress={() => choose(max)}
          />
        ))}
      </GroupedList>
      {uses > 0 ? <GroupedFooter>{t("invites.usedSoFar", { count: uses })}</GroupedFooter> : null}
    </SettingsPage>
  );
}

/** Recado no e-mail. */
function NotePick({ draft, change }: PickProps) {
  const { t } = useTranslation();
  const { org } = useOrg();
  return (
    <SettingsPage title={t("members.dialog.note")} action={{ label: t("mobile.invitePeople.ok"), onPress: goBack }}>
      <Gap />
      <TextArea
        value={draft.note}
        onChangeText={(note) => change((d) => ({ ...d, note }))}
        placeholder={t(modeKey(org, "members.dialog.notePlaceholder"), { org: org?.name ?? "" })}
        accessibilityLabel={t("members.dialog.note")}
        limit={INVITE_NOTE_LIMIT}
      />
      <GroupedFooter>{t("mobile.invitePeople.noteHelp", { max: INVITE_NOTE_MAX })}</GroupedFooter>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  search: { paddingTop: 10 },
});
