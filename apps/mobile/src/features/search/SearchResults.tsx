import { useChannels, useDms, useSearch } from "@agenteschat/client";
import { hitText } from "@agenteschat/client/lib/media";
import { previewBody } from "@agenteschat/client/lib/message-body";
import { makesAgents } from "@agenteschat/client/lib/permissions";
import { searchTerms } from "@agenteschat/client/lib/search-filters";
import { memo, type ReactNode, useDeferredValue, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { EmptyState, SCREEN_X, SectionHeader, SkeletonList } from "@/ui";
import { router } from "@/ui/navigation";
import { useOpenFile } from "../files/open";
import { chatHref } from "../links/logic";
import { AgentFace, Face } from "../shared/Face";
import { LoadFailed } from "../shared/FirstUse";
import { useDirectory, useOrgId, useWhen } from "../shared/hooks";
import { previewOf } from "../shared/logic";
import { type ActionItem, ActionList, Tile } from "../shared/parts";
import { hitHref, hitResults, isEmpty, localResults, SEARCH_KINDS, type SearchAction } from "./logic";
import { RESULT_LEAD } from "./SearchFilters";

const ACTION_ICON = { newConversation: "compose", newTask: "target", newAgent: "agent" } as const;

const runAction = (a: SearchAction) => {
  if (a === "newConversation") router.push("/new-chat");
  else if (a === "newAgent") router.push("/new-agent");
  else router.navigate("/agents");
};

/** A hit's conversation's name, when it is a channel the list knows. */
const nameIn = (names: ReadonlyMap<string, string>, id: string | undefined) => (id ? names.get(id) : undefined);

/**
 * Busca, under the field of the search tab (the phone's ⌘K): the actions with no words, then the results grouped
 * (Conversas, Ações do time, Mensagens, Arquivos), each group's count on its header and the words looked for lit in
 * the lines. A message opens its conversation at that message; a file opens in the app's own viewer. While the
 * results come, rows of their shape stand in. They follow the field a beat behind: a keystroke draws the field first,
 * and words typed quickly are asked of the server once they settle.
 */
export function SearchResults({ q }: { q: string }) {
  const settled = useDeferredValue(q);
  return <Results q={settled} />;
}

/** The results for `q`, drawn again only when the words or what they found change; each group's rows kept apart. */
const Results = memo(function Results({ q }: { q: string }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const dir = useDirectory();
  const when = useWhen();
  const createsAgents = makesAgents(useOrg().org);
  const channels = useChannels(orgId);
  const dms = useDms(orgId);
  const hits = useSearch(orgId, q, SEARCH_KINDS);
  const labels = useMemo<Record<SearchAction, string>>(
    () => ({
      newConversation: t("mobile.find.action.newConversation"),
      newTask: t("mobile.find.action.newTask"),
      newAgent: t("mobile.find.action.newAgent"),
    }),
    [t],
  );
  // What the phone finds and what the server's hits fill, apart: hits coming in leave the conversations' rows alone.
  const local = useMemo(
    () =>
      localResults(q, {
        actionLabels: labels,
        agents: dir.agents,
        channels: (channels.data ?? []).filter((x) => x.isMember),
        dms: dms.data ?? [],
      }),
    [q, labels, dir.agents, channels.data, dms.data],
  );
  const found = useMemo(() => hitResults(q, hits.data ?? []), [q, hits.data]);
  // "Novo agente" only for who may create one (ADR 0085).
  const actions = useMemo(
    () => (createsAgents ? local.actions : local.actions.filter((a) => a !== "newAgent")),
    [createsAgents, local.actions],
  );
  const r = { ...local, ...found, actions };
  // The channels by id, once: every hit names its conversation.
  const channelNames = useMemo(() => new Map((channels.data ?? []).map((x) => [x.id, x.name])), [channels.data]);
  // The app's own viewer (a document, an image), never the browser: a picture's name opens it straight in the pictures.
  const openFileNow = useOpenFile();
  const words = Boolean(q.trim());
  const terms = useMemo(() => searchTerms(q), [q]);
  // The server's results didn't come: said so with a retry, never as "nothing found".
  const failed = words && hits.isError && !hits.data;

  const actionItems = useMemo<ActionItem[]>(
    () => actions.map((a) => ({ key: a, icon: ACTION_ICON[a], label: labels[a], onPress: () => runAction(a) })),
    [actions, labels],
  );
  const chatItems = useMemo<ActionItem[]>(
    () => [
      ...local.agents.map((a) => ({
        key: `a:${a.id}`,
        leading: <AgentFace agentId={a.id} size={RESULT_LEAD} live={false} />,
        label: a.name,
        marks: terms,
        oneLine: true,
        ...(a.role ? { hint: a.role } : {}),
        onPress: () => router.push(`/agent/${a.id}`),
      })),
      ...local.dms.map((d) => ({
        key: `d:${d.channelId}`,
        leading: <Face who={{ type: d.with.type, id: d.with.id }} size={RESULT_LEAD} live={false} />,
        label: d.with.name,
        marks: terms,
        oneLine: true,
        ...(d.lastMessage
          ? {
              hint: previewBody(t, previewOf(d.lastMessage.body), d.lastMessage.meta ?? null, d.lastMessage.mediaKind),
            }
          : {}),
        onPress: () => router.push(chatHref(d.channelId)),
      })),
      ...local.channels.map((ch) => ({
        key: `c:${ch.id}`,
        leading: <Tile icon="hash" size={RESULT_LEAD} />,
        label: `#${ch.name}`,
        marks: terms,
        oneLine: true,
        ...(ch.topic ? { hint: ch.topic } : {}),
        onPress: () => router.push(chatHref(ch.id)),
      })),
    ],
    [local.agents, local.dms, local.channels, terms, t],
  );
  const teamItems = useMemo<ActionItem[]>(
    () =>
      found.team.map((h) => {
        const channelId = h.channelIds[0] ?? "";
        const where = nameIn(channelNames, channelId);
        return {
          key: h.sourceId,
          leading: h.author ? (
            <AgentFace agentId={h.author.id} size={RESULT_LEAD} live={false} />
          ) : (
            <Tile icon="reply" size={RESULT_LEAD} />
          ),
          label: previewOf(h.snippet || h.title),
          marks: terms,
          hint: [
            h.author?.name,
            where ? t("mobile.chats.waitIn", { where: `#${where}` }) : null,
            when.short(h.createdAt),
          ]
            .filter(Boolean)
            .join(" · "),
          onPress: () => router.push(chatHref(channelId)),
        };
      }),
    [found.team, channelNames, terms, t, when],
  );
  const messageItems = useMemo<ActionItem[]>(
    () =>
      found.messages.map((h) => {
        const where = nameIn(channelNames, h.channelIds[0]);
        // Who said it leads the line; where and when follow on one meta line.
        return {
          key: h.sourceId,
          leading: h.author ? (
            <Face who={h.author} size={RESULT_LEAD} live={false} />
          ) : (
            <Tile icon="chat" size={RESULT_LEAD} />
          ),
          label: previewOf(hitText(t, h) || h.title),
          marks: terms,
          hint: [
            h.author?.name,
            where ? t("mobile.chats.waitIn", { where: `#${where}` }) : null,
            when.short(h.createdAt),
          ]
            .filter(Boolean)
            .join(" · "),
          // The conversation opens at the message itself (a reply in its thread), not at its end.
          onPress: () => router.push(hitHref(h)),
        };
      }),
    [found.messages, channelNames, terms, t, when],
  );
  const fileItems = useMemo<ActionItem[]>(
    () =>
      found.files.map((h) => {
        const where = nameIn(channelNames, h.channelIds[0]);
        return {
          key: h.sourceId,
          leading: <Tile icon="doc" size={RESULT_LEAD} />,
          label: h.title || t("mobile.chat.file"),
          marks: terms,
          hint: [where ? t("mobile.chats.waitIn", { where: `#${where}` }) : null, when.short(h.createdAt)]
            .filter(Boolean)
            .join(" · "),
          onPress: () => void openFileNow({ id: h.sourceId, title: h.title }),
        };
      }),
    [found.files, channelNames, terms, t, when, openFileNow],
  );

  return (
    <View>
      <View style={styles.res}>
        {r.actions.length > 0 ? (
          <Group title={t("mobile.find.actions")}>
            <ActionList items={actionItems} />
          </Group>
        ) : null}
        {words && r.agents.length + r.channels.length + r.dms.length > 0 ? (
          <Group title={t("mobile.find.conversations")} count={r.agents.length + r.channels.length + r.dms.length}>
            <ActionList items={chatItems} />
          </Group>
        ) : null}
        {r.team.length > 0 ? (
          <Group title={t("searchPage.kinds.action")} count={r.team.length}>
            <ActionList items={teamItems} />
          </Group>
        ) : null}
        {r.messages.length > 0 ? (
          <Group title={t("mobile.find.messages")} count={r.messages.length}>
            <ActionList items={messageItems} />
          </Group>
        ) : null}
        {r.files.length > 0 ? (
          <Group title={t("mobile.find.files")} count={r.files.length}>
            <ActionList items={fileItems} />
          </Group>
        ) : null}
        {words && hits.isLoading ? <SkeletonList rows={3} /> : null}
        {failed ? <LoadFailed onRetry={() => void hits.refetch()} /> : null}
        {words && !failed && isEmpty(r) && !hits.isFetching ? (
          <EmptyState size="inline" title={t("mobile.find.nothing", { q: q.trim() })} />
        ) : null}
      </View>
    </View>
  );
});

/** A group of results under the app's section header, with how many it holds, said once; the list at the 16 margin. */
function Group({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <View>
      <SectionHeader title={title} {...(count !== undefined ? { count } : {})} />
      <View style={styles.list}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  res: { paddingTop: 2 },
  list: { paddingHorizontal: SCREEN_X },
});
