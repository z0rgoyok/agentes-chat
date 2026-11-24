import { Stack } from "expo-router";
import { useTranslation } from "react-i18next";
import { RefreshControl } from "react-native";
import { STORED } from "@/lib/storage";
import { Button, LargeTitleScreen, SkeletonList, useWide } from "@/ui";
import { router } from "@/ui/navigation";
import { LoadFailed } from "../shared/FirstUse";
import { usePullRefresh } from "../shared/hooks";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { TeamSkyEmpty } from "../shared/TeamSkyEmpty";
import { useTabHeader } from "../shared/tabHeader";
import { ChatHandoff, ChatSplit, OpenFirstChat } from "./ChatsSplit";
import { ConversationItem } from "./ConversationRowView";
import { CollapsibleSection, useCollapsedSections } from "./HomeSection";
import { THREAD_SECTIONS, threadRows, threadSections } from "./logic";
import { firstChatOf, threadSplit, useChatOpener } from "./split";
import { useConversationRows, useRowFacts } from "./useRows";

/** Rows whose agent moves (a long list stays light). */
const LIVE_ROWS = 8;

/** Said either way: a screen's options merge, so the bar the split hid stays hidden until it is shown again. */
const SPLIT_OPTIONS = { headerShown: false };
const LIST_OPTIONS = { headerShown: true };

/**
 * Threads, the second tab. On a large screen (ADR 0212: the iPhone Duo's inner display) the list and the open thread
 * or mission side by side, as Conversas does (`ChatSplit`, its own choice in `threadSplit`), each pane with its own
 * bar: the tab's bar would stand over both. With none chosen yet, the list's first one opens; closing and opening the
 * device moves it between the pane and a pushed conversation. A compact window shows the list alone, as before.
 * `pushed`: the list pushed from You › Work in a personal workspace (ADR 0159), which has no Threads tab; it stays one
 * pane, its threads pushed.
 */
export function ThreadsScreen({ pushed = false }: { pushed?: boolean }) {
  const { t } = useTranslation();
  const wide = useWide();
  if (pushed) return <ThreadsList pushed />;
  return (
    <>
      <Stack.Screen options={wide ? SPLIT_OPTIONS : LIST_OPTIONS} />
      <ChatHandoff wide={wide} store={threadSplit} owner="threads" home="/threads" />
      {wide ? (
        <ChatSplit
          store={threadSplit}
          list={<ThreadsList />}
          testID="threads-split"
          empty={t("mobile.threads.splitEmpty")}
        />
      ) : (
        <ThreadsList />
      )}
    </>
  );
}

/**
 * The threads' list, named as its tab is: like the home, under the native large title with Você and "+" in the bar,
 * the sections Missões and Threads (collapsible, remembered) in Conversas' rows, each with its faint line ("Missão ·
 * #produto") over the name and its state as words (amber for what waits on you, the orbit for who works); what is
 * closed sits at the end of its section. What waits on you is in Atividade, not repeated here. Loading: rows of its own
 * shape. Empty: the sky with the team, and the way to the conversations. `pushed`: the same list pushed from You ›
 * Work, with the back button in its bar, where a personal workspace (ADR 0159) keeps it instead of a tab. Beside the
 * open thread (ADR 0212) a row opens its thread there and stays lit (`ConversationItem`'s opener).
 */
function ThreadsList({ pushed = false }: { pushed?: boolean }) {
  const { t } = useTranslation();
  const header = useTabHeader();
  // Rows kept while nothing in them changes, their words worked out once here: a row redraws only when its own did.
  const list = useConversationRows();
  const factsOf = useRowFacts();
  const { collapsed, toggle } = useCollapsedSections(STORED.threadsCollapsed, THREAD_SECTIONS);
  const rows = threadRows(list.rows);
  const sections = threadSections(rows);
  const pull = usePullRefresh(() => list.refetch());
  // In the split with nothing open yet, the first thread or mission of the list opens beside it.
  const opener = useChatOpener();
  const first = opener ? firstChatOf(sections.flatMap((s) => s.rows)) : null;
  let live = 0;
  const body = (
    <>
      {opener ? <OpenFirstChat channelId={first?.channelId ?? null} threadId={first?.threadId ?? null} /> : null}
      {list.loading ? (
        // The sections as they will stand (closed if closed, no count until known): nothing moves when rows land.
        <>
          <CollapsibleSection
            title={t("mobile.threads.section.missions")}
            collapsed={collapsed.includes("missions")}
            onToggle={() => toggle("missions")}
          >
            <SkeletonList rows={2} />
          </CollapsibleSection>
          <CollapsibleSection
            title={t("mobile.threads.section.threads")}
            collapsed={collapsed.includes("threads")}
            onToggle={() => toggle("threads")}
          >
            <SkeletonList rows={3} />
          </CollapsibleSection>
        </>
      ) : list.failed && rows.length === 0 ? (
        // Nothing kept to read: the list's error, with the way to ask again.
        <LoadFailed onRetry={() => void list.refetch()} />
      ) : rows.length === 0 ? (
        <TeamSkyEmpty
          title={t("mobile.empty.threads.title")}
          text={t("mobile.empty.threads.text")}
          action={
            <Button
              variant="secondary"
              size="sm"
              label={t("mobile.empty.threads.action")}
              onPress={() => router.navigate("/")}
            />
          }
        />
      ) : (
        sections.map((s) => {
          const off = collapsed.includes(s.key);
          return (
            <CollapsibleSection
              key={s.key}
              title={t(`mobile.threads.section.${s.key}`)}
              count={s.rows.length}
              collapsed={off}
              onToggle={() => toggle(s.key)}
            >
              {s.rows.map((r, i) => (
                <ConversationItem
                  key={r.key}
                  row={r}
                  facts={factsOf(r)}
                  divider={i > 0}
                  live={!off && live++ < LIVE_ROWS}
                />
              ))}
            </CollapsibleSection>
          );
        })
      )}
    </>
  );
  if (pushed)
    return (
      <PushedLargeTitle
        title={t("mobile.threads.title")}
        refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
      >
        {body}
      </PushedLargeTitle>
    );
  return (
    <LargeTitleScreen title={t("mobile.threads.title")} {...header} pull={pull}>
      {body}
    </LargeTitleScreen>
  );
}
