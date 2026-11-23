import {
  type Issue,
  type IssueColumn,
  type UnreadTask,
  useIssueColumns,
  useIssueProjects,
  useIssues,
  useUnreadTasks,
} from "@agenteschat/client";
import { dueLabel } from "@agenteschat/client/lib/format";
import { liveProjectFilter, NO_PROJECT } from "@agenteschat/client/lib/issue-projects";
import { assigneeNames } from "@agenteschat/client/lib/issues";
import { Fragment, memo, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  RefreshControl,
  ScrollView,
  type ScrollViewInstance,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import Animated, { FadeIn, FadeOut, LayoutAnimationConfig, LinearTransition } from "react-native-reanimated";
import { useOrg } from "@/providers/org";
import {
  Button,
  EmptyState,
  Filters,
  Icon,
  LIST_PREVIEW,
  ListRow,
  SCREEN_X,
  SearchField,
  SectionHeader,
  Segmented,
  SkeletonList,
  Text,
  textLineOf,
  useFontScale,
  useReducedMotion,
} from "@/ui";
import { mediaRowAxis } from "@/ui/media-row";
import { router } from "@/ui/navigation";
import { useRowDirectory } from "../chat/row-data";
import { mayCreate } from "../new/logic";
import { Face } from "../shared/Face";
import { FirstUse, LoadFailed } from "../shared/FirstUse";
import { useColors, useMeId, useOrgId, usePullRefresh } from "../shared/hooks";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { type BoardColumn, issueBoard, taskListSections, taskTitleText } from "./logic";
import {
  AssigneeFace,
  BoardCard,
  ColumnHeader,
  ProjectDot,
  ProjectName,
  PropChip,
  StateWords,
  useCardState,
  useColumnLabel,
} from "./parts";
import { openTaskPick } from "./pick";

/** Cards and rows whose agent moves (a long list stays light). */
const LIVE_CARDS = 8;
const COLUMN_GAP = 12;
/** How much of the next column shows at the edge. */
const PEEK = 41;
/** The check in the rows' lead column (`LIST_AVATAR`), where a face sits in the app's other lists. */
const CHECK = 24;

type TaskView = "list" | "board";

/**
 * Tasks, pushed from Você, under one header in both views: the system's large title on iOS (drawn on Android), as
 * Drive's (`PushedLargeTitle`), the "+" for a new task in its bar. First under the title the views, Lista and Quadro,
 * on one segmented control that stays where it is when the view changes (with the project chip under it once the
 * workspace has projects); then Lista's search or Quadro's stages.
 *
 * Lista (the default): one list by state, "Para você" first, in the app's list rows: the check in the lead column
 * (green once done), the title on two lines at most, who has it (an agent alive while it works) and its one state or
 * its due date in words. Quadro: the stages side by side, swiped one at a time with the next one showing at the edge,
 * the stage chips over them with their counts; custom board columns show as headers, each of A fazer's with "+" for a
 * task in it. A column is as long as its cards and the page scrolls as Lista does, folding the large title into the
 * bar: one header and one pull to refresh in both views (a column scrolling on its own would leave the large title
 * standing over it, and a second scroll under the page's). Switching views is a choice made often: it doesn't animate
 * beyond the control's own slide. The project chip opens its pushed picker; both views then show only that project's
 * tasks (or those with none), which the server filters, and a new task starts in it. Columns are edited on the web.
 */
export function IssuesScreen() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const all = useIssues(orgId);
  const projects = useIssueProjects(orgId).data?.projects ?? [];
  const [view, setView] = useState<TaskView>("list");
  // "": every task. A project's id, or `none`.
  const [filter, setFilter] = useState("");
  // A project deleted while it was picked: every task again.
  const shown = liveProjectFilter(projects, filter);
  const project = projects.find((p) => p.id === shown);
  const issues = useIssues(orgId, "", shown);
  const columns = useIssueColumns(orgId);
  const pull = usePullRefresh(() => Promise.all([issues.refetch(), columns.refetch()]));
  const mayNew = mayCreate(useOrg().org, "task");
  const openNew = () =>
    project && !project.archived
      ? router.push({ pathname: "/issues/new", params: { project: project.id } })
      : router.push("/issues/new");
  const pickProject = () => {
    openTaskPick({ what: "projectFilter", value: shown, apply: setFilter });
    router.push("/issues/pick");
  };
  // Nothing at all in the workspace (whatever the filter): its first use, without the views.
  const empty = all.isSuccess && (all.data ?? []).length === 0;
  const list = issues.data ?? [];
  return (
    <PushedLargeTitle
      title={t("mobile.issues.title")}
      {...(mayNew ? { actions: [{ icon: "plus", sf: "plus", label: t("mobile.issues.new"), onPress: openNew }] } : {})}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
    >
      {all.isLoading ? (
        // Loading: the rows' own shape, never a spinner.
        <SkeletonList rows={4} />
      ) : all.isError && !all.data ? (
        <LoadFailed onRetry={() => void all.refetch()} />
      ) : empty ? (
        <FirstUse place="tasks" acts={mayNew} label={t("mobile.issues.new")} onPress={openNew} />
      ) : (
        <>
          <View style={styles.views}>
            <Segmented
              wide
              items={[
                { key: "list", label: t("mobile.issues.viewList") },
                { key: "board", label: t("mobile.issues.viewBoard") },
              ]}
              value={view}
              onChange={(k) => setView(k as TaskView)}
            />
            {projects.length > 0 ? (
              <View style={styles.project}>
                <PropChip
                  label={t("issues.projects.label")}
                  value={project?.name ?? t(shown === NO_PROJECT ? "issues.projects.none" : "issues.projects.all")}
                  {...(shown ? { leading: <ProjectDot color={project?.color} /> } : { icon: "issue" as const })}
                  onPress={pickProject}
                />
              </View>
            ) : null}
          </View>
          {/* A project just picked loads under the views, which stay where they are. */}
          {issues.isLoading ? (
            <SkeletonList rows={4} />
          ) : issues.isError && !issues.data ? (
            <LoadFailed onRetry={() => void issues.refetch()} />
          ) : view === "board" ? (
            <Board issues={list} columns={columns.data ?? []} mayNew={mayNew} project={shown} />
          ) : (
            <TaskList issues={list} project={shown} onAllProjects={() => setFilter("")} />
          )}
        </>
      )}
    </PushedLargeTitle>
  );
}

/**
 * Lista: the search, then the sections ("Para você", Em andamento, Em revisão, A fazer, Feitas hoje). A search or a
 * project with nothing in it says so, with the way to clear it.
 */
function TaskList({
  issues,
  project,
  onAllProjects,
}: {
  issues: Issue[];
  /** The project filter: "" for every task. */
  project: string;
  onAllProjects: () => void;
}) {
  const { t } = useTranslation();
  const meId = useMeId();
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const sections = useMemo(() => {
    const shown = query
      ? issues.filter((i) => `${taskTitleText(i.title)} #${i.number}`.toLowerCase().includes(query))
      : issues;
    return taskListSections(shown, meId);
  }, [issues, query, meId]);
  let row = 0;
  return (
    <>
      <View style={styles.search}>
        <SearchField
          value={q}
          onChangeText={setQ}
          placeholder={t("mobile.issues.search")}
          accessibilityLabel={t("mobile.issues.search")}
          returnKeyType="search"
        />
      </View>
      {sections.length === 0 ? (
        query ? (
          <EmptyState
            size="inline"
            title={t("mobile.issues.noMatch")}
            action={<Button variant="secondary" size="sm" label={t("filters.clearSearch")} onPress={() => setQ("")} />}
          />
        ) : project ? (
          <EmptyState
            size="inline"
            title={t("issues.noResults")}
            action={<Button variant="secondary" size="sm" label={t("filters.clearAll")} onPress={onAllProjects} />}
          />
        ) : (
          <EmptyState size="inline" title={t("mobile.issues.columnEmpty")} />
        )
      ) : (
        sections.map((s) => (
          <Fragment key={s.key}>
            <SectionHeader title={t(`mobile.issues.list.${s.key}`)} count={s.items.length} />
            {s.items.map((i, n) => {
              row += 1;
              return <TaskRow key={i.id} issue={i} divider={n > 0} live={row <= LIVE_CARDS} project={project === ""} />;
            })}
          </Fragment>
        ))
      )}
    </>
  );
}

/**
 * A task in the list, in the app's list row: the check in the lead column (green once done, faint before), the title in
 * the row's own type on two lines at most (its screen says it whole), then who has it (the agent's face, moving while
 * it works) and its one state in the board card's words ("Pergunta algo" in the attention color), else its due date in
 * words. A long name wraps beside its face, and a state that doesn't fit goes under it, whole. Drawn again only when
 * its task changes: a letter typed in the search redraws none of the rows that stay.
 */
const TaskRow = memo(function TaskRow({
  issue: i,
  divider,
  live,
  project,
}: {
  issue: Issue;
  divider: boolean;
  live: boolean;
  /** Its project after who has it. A project's own list leaves it out. */
  project: boolean;
}) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const dir = useRowDirectory();
  const { state, words } = useCardState(i);
  const done = i.status === "done";
  const running = state?.kind === "running";
  const title = taskTitleText(i.title);
  const who =
    i.assignees.length > 0
      ? assigneeNames(
          t,
          i.assignees.map((a) => dir.nameOf(a)),
        )
      : t("mobile.issues.nobody");
  const due = i.dueDate && !done ? dueLabel(t, i18n.language, i.dueDate) : null;
  const axis = mediaRowAxis(16, textLineOf("small", useFontScale(), LIST_PREVIEW));
  return (
    <ListRow
      divider={divider}
      leading={<Icon name={done ? "checkc" : "circle"} size={CHECK} color={done ? c.ok : c.faint} />}
      title={title}
      titleLines={2}
      sub={
        <View style={styles.subLine}>
          <View style={styles.person}>
            {i.assignees.length > 1 ? (
              <View style={{ marginTop: axis.face }}>
                <AssigneeFace issue={i} size={20} live={live} ring={c.bg} />
              </View>
            ) : i.assignees[0] ? (
              <View style={{ marginTop: axis.face }}>
                <Face who={i.assignees[0]} size={16} live={live} mode={running ? "run" : "idle"} />
              </View>
            ) : null}
            <Text variant="small" tone="muted" style={[LIST_PREVIEW, styles.shrink, { paddingTop: axis.words }]}>
              {who}
              {!state && due ? ` · ${due}` : ""}
            </Text>
          </View>
          {project && i.project ? <ProjectName project={i.project} variant="small" /> : null}
          {state && words ? <StateWords issue={i} state={state} words={words} /> : null}
        </View>
      }
      accessibilityRole="button"
      accessibilityLabel={[title, who, project ? i.project?.name : null, words ?? due].filter(Boolean).join(", ")}
      onPress={() => router.push(`/issues/${i.number}`)}
    />
  );
});

/**
 * Quadro, under the views: the stage chips with their counts, then the stages side by side, one column a swipe wide
 * with the next one's edge in sight. A column is as long as its cards; the page scrolls them with the title.
 */
function Board({
  issues,
  columns,
  mayNew,
  project,
}: {
  issues: Issue[];
  columns: IssueColumn[];
  mayNew: boolean;
  project: string;
}) {
  const { t } = useTranslation();
  const { width } = useWindowDimensions();
  const unreadList = useUnreadTasks(useOrgId()).data;
  // Each task's unread replies and mentions of me (ADR 0145), read once for the board: a card that reads the whole list
  // itself is drawn again, every card, whenever any task's count changes.
  const unread = useMemo(() => {
    const byTask = new Map<string, UnreadTask>();
    for (const u of unreadList ?? []) if (!byTask.has(u.issueId)) byTask.set(u.issueId, u);
    return byTask;
  }, [unreadList]);
  const pager = useRef<ScrollViewInstance>(null);
  const [tab, setTab] = useState(0);
  // A tab tapped: where the pager is going, so the columns it passes on the way don't light up.
  const going = useRef<number | null>(null);
  const board = useMemo(() => issueBoard(issues, columns), [issues, columns]);
  const columnWidth = width - PEEK - SCREEN_X;
  const step = columnWidth + COLUMN_GAP;
  const columnAt = (x: number) => Math.max(0, Math.min(board.length - 1, Math.round(x / step)));
  const onPagerScroll = (x: number) => {
    const at = columnAt(x);
    if (going.current === null) setTab(at);
    else if (at === going.current && Math.abs(x - at * step) < 1) going.current = null;
  };
  const go = (index: number) => {
    going.current = index === tab ? null : index;
    setTab(index);
    pager.current?.scrollTo({ x: index * step, animated: true });
  };
  return (
    <>
      <Filters
        items={board.map((b) => ({
          key: b.stage,
          label: t(`mobile.issues.section.${b.stage}`),
          count: b.count,
        }))}
        value={board[tab]?.stage ?? ""}
        onChange={(k) => go(board.findIndex((b) => b.stage === k))}
      />
      <ScrollView
        ref={pager}
        horizontal
        showsHorizontalScrollIndicator={false}
        snapToInterval={step}
        decelerationRate="fast"
        disableIntervalMomentum
        contentContainerStyle={styles.pager}
        scrollEventThrottle={32}
        onScrollBeginDrag={() => {
          going.current = null;
        }}
        onScroll={(e) => onPagerScroll(e.nativeEvent.contentOffset.x)}
      >
        {board.map((b) => (
          <Column key={b.stage} column={b} width={columnWidth} mayNew={mayNew} project={project} unread={unread} />
        ))}
      </ScrollView>
    </>
  );
}

/** A stage's column: its cards (under its board columns' headers where the board is customized), or that it's empty. */
function Column({
  column: b,
  width,
  mayNew,
  project,
  unread,
}: {
  column: BoardColumn;
  width: number;
  mayNew: boolean;
  project: string;
  unread: ReadonlyMap<string, UnreadTask>;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const columnLabel = useColumnLabel();
  // A task that moves to another stage while the person watches leaves this column and fades into its new one;
  // the rest slide into place. The cards there when the board loads don't each fade.
  const reduced = useReducedMotion();
  const fade = reduced ? {} : { entering: FadeIn.duration(160), exiting: FadeOut.duration(120) };
  const layout = reduced ? undefined : LinearTransition.duration(220);
  const newIn = (column: string) => () =>
    router.push({
      pathname: "/issues/new",
      params: { column, ...(project && project !== NO_PROJECT ? { project } : {}) },
    });
  let card = 0;
  return (
    <View style={[styles.column, { width, backgroundColor: c.sunken }]}>
      <LayoutAnimationConfig skipEntering>
        {b.groups.length === 0 ? (
          <Animated.View {...fade}>
            <Text variant="subhead" tone="faint" style={styles.none}>
              {t("mobile.issues.columnEmpty")}
            </Text>
          </Animated.View>
        ) : null}
        {b.groups.map((g) => (
          <Fragment key={g.key}>
            {b.showColumns && g.column ? (
              <ColumnHeader
                label={columnLabel(g.column)}
                count={g.items.length}
                {...(mayNew && g.column.stage === "todo" ? { onNew: newIn(g.column.id) } : {})}
              />
            ) : null}
            {g.items.map((i) => {
              card += 1;
              const counts = unread.get(i.id);
              return (
                <Animated.View key={i.id} {...fade} layout={layout}>
                  <BoardCard
                    issue={i}
                    live={card <= LIVE_CARDS}
                    project={project === ""}
                    mentions={counts?.mentions ?? 0}
                    unread={counts?.unread ?? 0}
                  />
                </Animated.View>
              );
            })}
          </Fragment>
        ))}
      </LayoutAnimationConfig>
    </View>
  );
}

const styles = StyleSheet.create({
  // The views first under the title, the project chip under them, in both views: neither moves when the view changes.
  views: { paddingHorizontal: SCREEN_X, paddingTop: 4, paddingBottom: 12, gap: 8 },
  project: { flexDirection: "row" },
  search: { paddingHorizontal: SCREEN_X, paddingBottom: 8 },
  // Who has it with the date, then the state, wrapping between them, never the face alone on a line.
  subLine: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 8, rowGap: 2, minWidth: 0 },
  person: { flexDirection: "row", alignItems: "flex-start", gap: 4, flexShrink: 1 },
  shrink: { flexShrink: 1, minWidth: 0 },
  // Edge to edge: the columns slide under the screen's sides, the first one on the title's line. Each column is as
  // long as its own cards.
  pager: {
    paddingLeft: SCREEN_X,
    paddingRight: PEEK - COLUMN_GAP,
    paddingTop: 8,
    gap: COLUMN_GAP,
    alignItems: "flex-start",
  },
  column: { borderRadius: 20, padding: 10, gap: 10 },
  none: { padding: 16, textAlign: "center" },
});
