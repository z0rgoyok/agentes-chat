import type {
  Actor,
  Issue,
  IssueCardField,
  IssueColumn,
  IssueListColumn,
  IssuePriority,
  IssueStatus,
  IssuesView,
} from "@agenteschat/client";
import {
  keys,
  useIssue,
  useIssueColumns,
  useIssueProjectAction,
  useIssueProjects,
  useIssues,
  useIssuesView,
  useSetIssuesView,
  useTaskUnread,
} from "@agenteschat/client";
import { dueLabel, dueTone, joinNames, namesText, stoppedLine } from "@agenteschat/client/lib/format";
import { githubLinkLabel } from "@agenteschat/client/lib/github-link";
import { NO_PROJECT, projectOfFilter } from "@agenteschat/client/lib/issue-projects";
import {
  clampColumnWidth,
  ISSUE_COLUMN_WIDTHS,
  ISSUES_VIEW_DEFAULT,
  type IssuesViewChange,
  issueAssigneeKeys,
  issueInView,
  PRIORITY_ORDER,
  sortIssues,
  withColumnWidth,
} from "@agenteschat/client/lib/issues-view";
import { can } from "@agenteschat/client/lib/permissions";
import { shownSteps } from "@agenteschat/client/lib/work";
import {
  AvatarStack,
  Button,
  Chip,
  ColorDot,
  codeAndBold,
  cx,
  Dialog,
  DialogFooter,
  EmptyState,
  FactLine,
  GroupHeading,
  Icon,
  type IconName,
  Kbd,
  type LineFact,
  Menu,
  MenuItem,
  MenuSeparator,
  PageHeader,
  SearchField,
  Toolbar,
  WorkSweep,
} from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Trans, useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { ActorAvatar, ActorWho, AgentAvatar } from "@/components/AgentAvatar";
import { AskAgentButton } from "@/components/AskAgentButton";
import { actorFromKey, actorKey, NO_ACTOR, useActors } from "@/components/actors";
import { useFilterCopy } from "@/components/filters";
import { GitHubMark } from "@/components/GitHubMark";
import { ErrorState, LoadingCards, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { CardSky } from "@/components/Sky";
import { TaskMentions, useTaskLive } from "@/components/TaskConversation";
import { useRightHandLook } from "@/hooks/useRightHandLook";
import { copyText } from "@/lib/context-menu";
import { entityMenu } from "@/lib/entity-menu";
import {
  BOARD,
  boardStages,
  cardState,
  cardStateText,
  cardWaits,
  groupByColumn,
  isAssignee,
  isCustomBoard,
  isOpen,
  isStalled,
  rankAt,
  STATUS_ICON,
  type CardState as TaskState,
  taskAgentId,
  useAssigneeColor,
  useColumnTitle,
  useStageName,
  useStepText,
} from "@/lib/issues";
import { lookOf } from "@/lib/look";
import { inPlaceClick } from "@/lib/navigate";
import { useOpenParam } from "@/lib/open-param";
import { type ToastText, useToast } from "@/lib/toast";
import { AssigneeFaces } from "./IssueAssignees";
import { AddColumnDialog, Board, type CardState, type IssueGroup, useMoveIssue, usePatchIssue } from "./IssueBoard";
import { IssueDeleteProvider, useIssueDeleting } from "./IssueDelete";
import { IssueDialog } from "./IssuePage";
import { DeleteProjectDialog, ProjectChip, ProjectDialog } from "./IssueProjects";
import { DisplayButton, IssueFilters, PRIORITY_ICON } from "./IssuesToolbar";
import { type CardMove, type DropResult, type IssueDrag, useIssueDrag } from "./issue-drag";
import { NewIssueDialog } from "./NewIssueDialog";
import "./issues.css";

export { BOARD, PRIORITIES, STATUSES, splitCriteria } from "@/lib/issues";

export function StatusChip({ status }: { status: IssueStatus }) {
  const { t } = useTranslation();
  return <Chip icon={STATUS_ICON[status]}>{t(`issues.status.${status}`)}</Chip>;
}

/**
 * The project whose board this is, in the URL (`?project=<id>`, `none` for the tasks with no project): a board of its
 * own to link to and go back from, so picking one is a new history entry.
 */
function useProjectParam(): [string | undefined, (value: string | undefined) => void] {
  const value = useRouterState({ select: (s) => (s.location.search as { project?: string }).project });
  const navigate = useNavigate();
  const set = (next: string | undefined) =>
    void navigate({
      to: ".",
      search: ((prev: Record<string, unknown>) => {
        const { project: _project, open: _open, m: _m, ...rest } = prev;
        return next ? { ...rest, project: next } : rest;
      }) as never,
    });
  return [value, set];
}

/**
 * Tarefas (issues in the code): agents working now, then the tasks as a board or a list, grouped by stage (the org's
 * custom columns in fixed stages), by assignee or by priority, with a details dialog. How the person looks at them
 * (layout, grouping, order, what the cards show, filters) is theirs per workspace, on the server, so every device
 * opens it the same way; the search is not kept. A project's board is this same board with only its tasks, which the
 * server filters (the list is capped, so filtering here would leave a busy workspace's project half empty).
 */
export function IssuesPage() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const viewQuery = useIssuesView(org.id);
  const view = viewQuery.data ?? ISSUES_VIEW_DEFAULT;
  const changeView = useSetIssuesView(org.id);
  const [q, setQ] = useState("");
  // The open issue lives in the URL (`?open=131`): a reload or a shared link reopens it.
  const [openParam, setOpenParam] = useOpenParam();
  // A message of the open task's conversation to open at (a notice, a link: ADR 0145).
  const [focusParam] = useOpenParam("m");
  const openNumber = openParam && /^\d+$/.test(openParam) ? Number(openParam) : null;
  const copy = useFilterCopy();
  const searchRef = useRef<HTMLInputElement>(null);
  // "Nova tarefa": false, or open (in a given column of A fazer, or the first).
  const [creating, setCreating] = useState<false | { columnId: string | null }>(false);
  const [addingColumn, setAddingColumn] = useState(false);
  const search = useDeferredValue(q.trim());
  const [projectParam, setProjectParam] = useProjectParam();
  const projectsQuery = useIssueProjects(org.id);
  const project = projectOfFilter(projectsQuery.data?.projects, projectParam);
  const projectAction = useIssueProjectAction(org.id);
  // "Novo projeto", "Editar projeto" and "Excluir projeto", one at a time.
  const [projectDialog, setProjectDialog] = useState<"new" | "edit" | "delete" | null>(null);
  // A project deleted elsewhere, or a link to one that is gone: back to every task.
  const projectGone = Boolean(
    projectParam && projectParam !== NO_PROJECT && projectsQuery.isSuccess && !projectsQuery.isFetching && !project,
  );
  useEffect(() => {
    if (!projectGone) return;
    setProjectDialog(null);
    setProjectParam(undefined);
  });
  const issues = useIssues(org.id, search, projectParam);
  const columnsQuery = useIssueColumns(org.id);
  const columns = columnsQuery.data;
  const all = issues.data ?? [];
  const filtered = all.filter((i) => issueInView(i, issueAssigneeKeys(i), view));
  const noIssues = issues.isSuccess && all.length === 0 && !search && !projectParam;
  const emptyProject = issues.isSuccess && all.length === 0 && !search && Boolean(projectParam);
  // A new task on a project's board starts in it. An archived project takes none, so its board offers none.
  const presetProject = project && !project.archived ? project.id : null;
  const look = useRightHandLook();
  const posts = can(org, "post");
  const adds = posts && !project?.archived;
  const open = all.filter(isOpen);
  const listed = all.find((i) => i.number === openNumber) ?? null;
  // On a project's board a task that isn't in it still opens (a link, or its project changed in its own dialog).
  const outside = useIssue(
    org.id,
    openNumber ?? 0,
    Boolean(projectParam) && openNumber !== null && issues.isSuccess && !listed,
  );
  const opened = listed ?? (projectParam && outside.data?.number === openNumber ? outside.data : null);
  const toggle = (n: number) => setOpenParam(openNumber === n ? null : n);
  // The saved view decides the layout: until it comes, the skeleton (not the default board, then the list).
  const viewLoading = viewQuery.isLoading;
  // "N" opens "Nova issue", "/" the search (not while typing or in a dialog; the details dialog closes itself on Esc).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest("input, textarea, [contenteditable], [role=dialog], [role=menu], [role=listbox]")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.toLowerCase() === "n") {
        e.preventDefault();
        if (adds) setCreating({ columnId: null });
      } else if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [adds]);
  return (
    <IssueDeleteProvider onDeleted={() => setOpenParam(null)}>
      <div className="page issues">
        <div className="issues__main">
          <PageHeader
            className="issues-head"
            title={
              projectParam ? (
                // Inside the title, so the dot stays on the first line of a name that wraps.
                <>
                  <ColorDot color={project?.color} />
                  {project ? project.name : t("issues.projects.none")}
                </>
              ) : (
                t("issues.title")
              )
            }
            count={
              <>
                <span>
                  {t("issues.summary", {
                    open: open.length,
                    agents: open.filter((i) => i.assignees.some((a) => a.type === "agent")).length,
                  })}
                </span>
                {open.some((i) => i.assignees.length === 0) && (
                  <span>
                    {" "}
                    · {t("issues.unassigned", { count: open.filter((i) => i.assignees.length === 0).length })}
                  </span>
                )}
                {project?.archived && <span> · {t("issues.projects.archivedMark")}</span>}
              </>
            }
            actions={
              // The empty state takes over this button: one way in, in the middle of the page.
              !noIssues &&
              adds && (
                <Button variant="primary" icon="plus" kbd={["N"]} onClick={() => setCreating({ columnId: null })}>
                  {t("issues.new")}
                </Button>
              )
            }
          />
          <StalledNow issues={all} onOpen={toggle} />
          <Toolbar
            label={t("issues.filters")}
            search={
              <SearchField
                ref={searchRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onClear={() => setQ("")}
                clearLabel={copy.clearSearch}
                placeholder={t("issues.search")}
                aria-label={t("issues.search")}
                shortcut={<Kbd aria-hidden="true">/</Kbd>}
              />
            }
            actions={
              <span className="issues-tools">
                <DisplayButton view={view} onChange={changeView} />
                {(view.group === "stage" || (project && posts)) && (
                  <Menu
                    align="end"
                    label={t("issues.moreOptions")}
                    trigger={<Button size="sm" iconOnly icon="more" aria-label={t("issues.moreOptions")} />}
                  >
                    {view.group === "stage" && (
                      <MenuItem icon="layers" onSelect={() => setAddingColumn(true)} disabled={!columns}>
                        {t("issues.columns.add")}
                      </MenuItem>
                    )}
                    {project && posts && (
                      <>
                        {view.group === "stage" && <MenuSeparator />}
                        <MenuItem icon="edit" onSelect={() => setProjectDialog("edit")}>
                          {t("issues.projects.edit")}
                        </MenuItem>
                        <MenuItem
                          icon="archive"
                          disabled={projectAction.isPending}
                          onSelect={() =>
                            projectAction.mutate({ type: "update", projectId: project.id, archived: !project.archived })
                          }
                        >
                          {t(project.archived ? "issues.projects.unarchive" : "issues.projects.archive")}
                        </MenuItem>
                        <MenuItem icon="trash" danger onSelect={() => setProjectDialog("delete")}>
                          {t("issues.projects.delete")}
                        </MenuItem>
                      </>
                    )}
                  </Menu>
                )}
              </span>
            }
          >
            <ProjectChip
              data={projectsQuery.data}
              value={projectParam}
              onChange={setProjectParam}
              onNew={posts ? () => setProjectDialog("new") : undefined}
            />
            <IssueFilters view={view} issues={all} onChange={changeView} />
          </Toolbar>
          {(issues.isLoading || viewLoading || (!columns && columnsQuery.isLoading)) &&
            (view.layout === "board" ? (
              // In the board's own frame and sideways scroller, so it loads where it will stay.
              <div className="issues-boardframe page-split">
                <div className="issues-boardwrap">
                  <div className="issues-board">
                    {BOARD.map((status) => (
                      <section key={status} className="issues-col" aria-label={t(`issues.status.${status}`)}>
                        <div className="issues-col__head">
                          <h2>{t(`issues.status.${status}`)}</h2>
                        </div>
                        <LoadingCards count={2} className="loading-cards loading-cards--tight" />
                      </section>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <LoadingList count={5} avatar={false} trailing />
            ))}
          {issues.isError && !issues.data && <ErrorState error={issues.error} onRetry={() => void issues.refetch()} />}
          {noIssues && (
            <EmptyState
              size="page"
              agent={look}
              title={t(posts ? "issues.emptyTitle" : "issues.emptyViewerTitle")}
              actions={
                posts && (
                  <>
                    <Button variant="primary" icon="plus" onClick={() => setCreating({ columnId: null })}>
                      {t("issues.new")}
                    </Button>
                    <AskAgentButton draft={t("issues.askFirst")} />
                  </>
                )
              }
            >
              {t(posts ? "issues.empty" : "issues.emptyViewer")}
            </EmptyState>
          )}
          {emptyProject && (
            <EmptyState
              size="panel"
              actions={
                adds &&
                presetProject && (
                  <Button variant="primary" icon="plus" onClick={() => setCreating({ columnId: null })}>
                    {t("issues.new")}
                  </Button>
                )
              }
            >
              {t(projectParam === NO_PROJECT ? "issues.noResults" : "issues.projects.empty")}
            </EmptyState>
          )}
          {issues.isSuccess && filtered.length === 0 && (all.length > 0 || search) && (
            <EmptyState
              size="panel"
              actions={
                <Button
                  onClick={() => {
                    setQ("");
                    changeView({ assignees: [], priorities: [], labels: [], done: "all" });
                  }}
                >
                  {copy.clearAll}
                </Button>
              }
            >
              {t("issues.noResults")}
            </EmptyState>
          )}
          {columnsQuery.isError && !columns && (
            <ErrorState error={columnsQuery.error} onRetry={() => void columnsQuery.refetch()} />
          )}
          {!viewLoading && filtered.length > 0 && columns && (
            <IssuesBody
              // A project's own board doesn't say its name again on every card.
              view={projectParam ? { ...view, fields: { ...view.fields, project: false } } : view}
              columns={columns}
              issues={filtered}
              all={all}
              onChange={changeView}
              openNumber={openNumber}
              onOpen={toggle}
              onNew={adds ? (columnId) => setCreating({ columnId }) : undefined}
            />
          )}
        </div>
        {opened && (
          <IssueDialog issue={opened} focusMessageId={focusParam ?? undefined} onClose={() => setOpenParam(null)} />
        )}
        <NewIssueDialog
          open={creating !== false}
          columnId={creating ? creating.columnId : null}
          projectId={presetProject}
          columns={columns ?? []}
          onClose={() => setCreating(false)}
        />
        {projectDialog === "new" && (
          <ProjectDialog onClose={() => setProjectDialog(null)} onDone={(p) => setProjectParam(p.id)} />
        )}
        {projectDialog === "edit" && project && (
          <ProjectDialog project={project} onClose={() => setProjectDialog(null)} />
        )}
        {projectDialog === "delete" && project && (
          <DeleteProjectDialog
            project={project}
            onClose={() => setProjectDialog(null)}
            onDeleted={() => setProjectParam(undefined)}
          />
        )}
        {columns && (
          <AddColumnDialog
            open={addingColumn}
            afterId={null}
            columns={columns}
            onClose={() => setAddingColumn(false)}
          />
        )}
      </div>
    </IssueDeleteProvider>
  );
}

/**
 * The tasks in the view's groups, as a board or a list, and what a drop means in each grouping: by stage the card
 * goes to that column at that place (`useMoveIssue`); by assignee it changes hands, through the same update the
 * task's own assignee field makes; by priority it takes that priority. Each says what happened, with Desfazer.
 * By assignee a task shows under each of who has it, so a card dragged from one of them to another swaps that one for
 * the other and keeps the rest; to "No assignee" it takes the one it came from off, from there it adds.
 */
function IssuesBody({
  view,
  columns,
  issues,
  all,
  onChange,
  openNumber,
  onOpen,
  onNew,
}: {
  view: IssuesView;
  columns: IssueColumn[];
  /** The tasks on screen: filtered, canceled and finished ones as the view asks. */
  issues: Issue[];
  /** Folding a group, the order a column's head asks for, and a column's new width. */
  onChange: (change: IssuesViewChange) => void;
  /** Every task loaded: who has one gets a column when grouped by assignee. */
  all: Issue[];
  openNumber: number | null;
  onOpen: (n: number) => void;
  /** Who may create tasks: "+" in A fazer's columns. */
  onNew?: (columnId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const actors = useActors();
  const color = useAssigneeColor();
  const title = useColumnTitle();
  const toast = useToast();
  const move = useMoveIssue(columns);
  const patch = usePatchIssue();
  const helpId = useId();
  const stages = boardStages(columns, view.showCanceled);
  const byColumn = groupByColumn(issues, columns);
  // The board's own order, column by column: the order inside an assignee's or a priority's group.
  const reading = new Map<string, number>();
  for (const { columns: cols } of boardStages(columns, true))
    for (const c of cols) for (const i of byColumn.get(c.id) ?? []) reading.set(i.id, reading.size);
  const byReading = (a: Issue, b: Issue) => (reading.get(a.id) ?? 0) - (reading.get(b.id) ?? 0);
  const inOrder = (list: Issue[]) => sortIssues([...list].sort(byReading), view.sort);

  const groups: IssueGroup[] = [];
  if (view.group === "stage") {
    for (const { stage, columns: cols } of stages) {
      for (const c of cols) {
        groups.push({
          id: c.id,
          name: title(c),
          items: sortIssues(byColumn.get(c.id) ?? [], view.sort),
          lead: <Icon name={STATUS_ICON[stage]} size={16} />,
          dropText: t("issues.drop.stage", { name: title(c) }),
        });
      }
    }
  } else if (view.group === "assignee") {
    // Everyone with a task here (and anyone the filter names), by name; "Sem responsável" last.
    const keys = new Set([
      ...all.filter((i) => view.showCanceled || i.status !== "canceled").flatMap(issueAssigneeKeys),
      ...view.assignees,
    ]);
    keys.delete(NO_ACTOR);
    const people = [...keys]
      .map((k) => actorFromKey(k))
      .filter((a): a is Actor => a !== null)
      .map((a) => ({ actor: a, name: actors.name(a) }))
      .sort((a, b) => a.name.localeCompare(b.name, i18n.language));
    for (const { actor, name } of people) {
      groups.push({
        id: actorKey(actor),
        name,
        items: inOrder(issues.filter((i) => isAssignee(i, actor.type, actor.id))),
        lead: <ActorAvatar actor={actor} name={name} size="xs" />,
        dropText: t("issues.drop.assignee", { name }),
      });
    }
    groups.push({
      id: NO_ACTOR,
      name: t("issues.noAssignee"),
      items: inOrder(issues.filter((i) => i.assignees.length === 0)),
      lead: <Icon name="person" size={16} />,
      dropText: t("issues.drop.unassign"),
    });
  } else {
    for (const p of PRIORITY_ORDER) {
      groups.push({
        id: p,
        name: t(`issues.priority.${p}`),
        items: inOrder(issues.filter((i) => i.priority === p)),
        lead: <Icon name={PRIORITY_ICON[p]} size={16} />,
        dropText: t("issues.drop.priority", { priority: t(`issues.priorityLower.${p}`) }),
      });
    }
  }

  const undo = (run: () => void) => ({ label: t("issues.undo"), run });
  // An agent named in the toast shows its face before its name.
  const assignedText = (issue: Issue, from: Actor | null, to: Actor | null, left: number): ToastText => {
    if (!to) {
      // Others still have it: it only left the one it was dragged from.
      if (left > 0 && from) return t("issues.drag.removed", { number: issue.number, name: actors.name(from) });
      return t("issues.drag.unassigned", { number: issue.number });
    }
    const name = actors.name(to);
    const text = t("issues.drag.assigned", { number: issue.number, name });
    return to.type === "agent" ? { text, who: { name, appearance: lookOf(actors.dir.agentById.get(to.id)) } } : text;
  };
  const reassign = (issue: Issue, from: Actor | null, to: Actor | null) => {
    const was = issue.assignees;
    // The one it came from gives its place to the one it went to; who already had it is named once.
    const others = was.filter((a) => actorKey(a) !== actorKey(to));
    const at = from ? others.findIndex((a) => actorKey(a) === actorKey(from)) : -1;
    const assignees = !to
      ? others.filter((_, k) => k !== at)
      : at < 0
        ? [...others, to]
        : others.map((a, k) => (k === at ? to : a));
    const back = () => patch({ ...issue, assignees }, { assignees: was }, { assignees: was });
    patch(issue, { assignees }, { assignees }, () =>
      toast.show(assignedText(issue, from, to, assignees.length), "info", undo(back)),
    );
  };
  const prioritize = (issue: Issue, priority: IssuePriority) => {
    const was = issue.priority;
    const back = () => patch({ ...issue, priority }, { priority: was }, { priority: was });
    const text = t("issues.drag.prioritized", {
      number: issue.number,
      priority: t(`issues.priorityLower.${priority}`),
    });
    patch(issue, { priority }, { priority }, () => toast.show(text, "info", undo(back)));
  };
  const onDrop = ({ id, from, to, index }: CardMove): DropResult => {
    const issue = issues.find((i) => i.id === id);
    if (!issue) return { changed: false };
    if (view.group === "stage") {
      const column = columns.find((c) => c.id === to);
      // Sorted by priority or due date, a column's order isn't the person's to change.
      if (!column || (view.sort !== "manual" && from === to)) return { changed: false };
      const others = (byColumn.get(to) ?? []).filter((i) => i.id !== id);
      move(issue, column, view.sort === "manual" ? rankAt(others, index) : rankAt(others, 0));
      const done = column.stage === "done" && issue.status !== "done";
      return done ? { changed: true, burst: color(issue) } : { changed: true };
    }
    if (from === to) return { changed: false };
    if (view.group === "assignee") reassign(issue, actorFromKey(from), actorFromKey(to));
    else prioritize(issue, to as IssuePriority);
    return { changed: true };
  };
  const nameOf = (group: string) => groups.find((g) => g.id === group)?.name ?? "";
  const dnd = useIssueDrag<Issue>({
    groups,
    layout: view.layout,
    onDrop,
    repeats: view.group === "assignee",
    words: {
      picked: (i) => t("issues.drag.picked", { number: i.number }),
      moved: (i, group, position, total) =>
        t("issues.drag.moved", { number: i.number, group: nameOf(group), position, total }),
      dropped: (i, group) => t("issues.drag.dropped", { number: i.number, group: nameOf(group) }),
      canceled: (i) => t("issues.drag.canceled", { number: i.number }),
    },
  });
  const onFold = (group: string, folded: boolean) =>
    onChange({ collapsed: folded ? [...view.collapsed, group] : view.collapsed.filter((g) => g !== group) });
  const renderCard = (i: Issue, group: string, state: CardState) => (
    <IssueCard
      issue={i}
      selected={i.number === openNumber}
      onOpen={() => onOpen(i.number)}
      drag={{ ...dnd.card(i, group), help: helpId }}
      picked={state === "picked"}
      fields={view.fields}
    />
  );
  return (
    <div ref={dnd.root} className="issues-body">
      <p id={helpId} className="ac-visually-hidden">
        {t("issues.drag.help")}
      </p>
      <p className="ac-visually-hidden" aria-live="assertive">
        {dnd.live}
      </p>
      {view.layout === "board" ? (
        <Board
          groups={groups}
          stages={view.group === "stage" ? stages : null}
          columns={columns}
          dnd={dnd}
          renderCard={renderCard}
          onNew={onNew}
          hideEmpty={view.hideEmpty}
          collapsed={view.collapsed}
          onFold={onFold}
        />
      ) : (
        <IssueList
          groups={groups}
          stages={view.group === "stage" ? stages : null}
          columns={columns}
          dnd={dnd}
          openNumber={openNumber}
          onOpen={onOpen}
          fields={view.fields}
          helpId={helpId}
          sort={view.sort}
          onSort={(sort) => onChange({ sort })}
          widths={view.widths}
          onWidths={(widths) => onChange({ widths })}
          collapsed={view.collapsed}
          onFold={onFold}
        />
      )}
    </div>
  );
}

/**
 * Above the board, only the stalled tasks (in progress, no run alive), as one line: an agent at work already shows on
 * its own card on the board, so the strip says only what needs a person, a nudge. Nothing stalled, no strip.
 */
function StalledNow({ issues, onOpen }: { issues: Issue[]; onOpen: (n: number) => void }) {
  const { t } = useTranslation();
  const stalled = issues.filter((i) => isOpen(i) && isStalled(i) && i.work);
  if (stalled.length === 0) return null;
  return (
    <section className="issues-now" aria-label={t("issues.now.stalledTitle")}>
      <StalledLine issues={stalled} onOpen={onOpen} />
    </section>
  );
}

/**
 * A task's last step in the person's words, never an engine-only one (the silent `pass`), and without the task's own
 * number ("Updated a task · #86" on #86 says nothing the card doesn't).
 */
function useTaskStep() {
  const stepText = useStepText();
  return (i: Issue) => {
    const last = shownSteps(i.work?.steps ?? []).at(-1);
    if (!last) return "";
    return stepText(last.detail?.trim() === `#${i.number}` ? { ...last, detail: undefined } : last);
  };
}

/** Stalled tasks by agent, the agent with the most first. */
function stalledByAgent(issues: Issue[], name: (a: Actor) => string) {
  const groups = new Map<string, { agent: Actor; name: string; issues: Issue[] }>();
  for (const i of issues) {
    // Under the agent whose run stopped, whoever else has the task.
    if (!i.work) continue;
    const agent: Actor = { type: "agent", id: i.work.agentId };
    const g = groups.get(agent.id);
    if (g) g.issues.push(i);
    else groups.set(agent.id, { agent, name: name(agent), issues: [i] });
  }
  return [...groups.values()].sort((a, b) => b.issues.length - a.issues.length || a.name.localeCompare(b.name));
}

/**
 * Asking stalled tasks' agents to pick up where they stopped: the same call as the task's own "Ask to continue", one per
 * task, all at once. A task counts as asked while its stall is the one it was asked on (`work.since`): its agent
 * starting leaves the stalled list, and a later stall is a new one. A failed ask reaches the shared error toast.
 */
function useResumeStalled() {
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const [asked, setAsked] = useState<ReadonlyMap<string, string>>(new Map());
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const mark = (ids: string[], on: boolean) =>
    setBusy((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  const ask = useMutation({
    mutationFn: async (list: Issue[]) => {
      const ids = list.map((i) => i.id);
      mark(ids, true);
      // Asked at once; the ones the server refused go back to asking.
      setAsked((prev) => {
        const next = new Map(prev);
        for (const i of list) if (i.work) next.set(i.id, i.work.since);
        return next;
      });
      const results = await Promise.allSettled(
        list.map((i) => api.issues.askAgent(org.id, i.id, i.work?.agentId ?? "")),
      );
      mark(ids, false);
      setAsked((prev) => {
        const next = new Map(prev);
        for (const [k, r] of results.entries()) {
          const i = list[k];
          if (r.status === "rejected" && i?.work && next.get(i.id) === i.work.since) next.delete(i.id);
        }
        return next;
      });
      const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed) throw failed.reason;
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: keys.issues(org.id) });
      void qc.invalidateQueries({ queryKey: keys.calendar(org.id) });
    },
  });
  return {
    send: (list: Issue[]) => list.length > 0 && ask.mutate(list),
    isAsked: (i: Issue) => i.work !== undefined && i.work !== null && asked.get(i.id) === i.work.since,
    isBusy: (i: Issue) => busy.has(i.id),
  };
}

/**
 * The stalled tasks as one quiet line: how many, whose (faces and names), "See stalled" for the list and "Continue
 * all". Once all are asked it says so until their agents start.
 */
function StalledLine({ issues, onOpen }: { issues: Issue[]; onOpen: (n: number) => void }) {
  const { t } = useTranslation();
  const actors = useActors();
  const [open, setOpen] = useState(false);
  const resume = useResumeStalled();
  const left = issues.filter((i) => !resume.isAsked(i));
  const groups = stalledByAgent(left.length ? left : issues, actors.name);
  const names = namesText(
    t,
    groups.map((g) => g.name),
    4,
  );
  return (
    <>
      {left.length === 0 ? (
        <div className="issues-stalled is-sent" role="status">
          <Icon name="play" size={16} className="issues-stalled__icon" />
          <span className="issues-stalled__text">{t("issues.now.sent", { count: groups.length, names })}</span>
        </div>
      ) : (
        <div className="issues-stalled">
          <Icon name="pause" size={16} className="issues-stalled__icon" />
          <span className="issues-stalled__text">
            <b>{t("issues.now.stalledCount", { count: left.length })}</b>
            <span className="issues-stalled__who">
              <AvatarStack>
                {groups.slice(0, 4).map((g) => (
                  <AgentAvatar key={g.agent.id} agentId={g.agent.id} name={g.name} size="sm" expression="closed" />
                ))}
              </AvatarStack>
              {names}
            </span>
          </span>
          <span className="issues-stalled__acts">
            <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
              {t("issues.now.viewStalled")}
            </Button>
            <Button
              size="sm"
              icon="play"
              loading={left.length > 0 && left.every(resume.isBusy)}
              onClick={() => resume.send(left)}
            >
              {t("issues.now.continueAll")}
            </Button>
          </span>
        </div>
      )}
      <StalledDialog
        open={open}
        onOpenChange={setOpen}
        issues={issues}
        resume={resume}
        onOpen={(n) => {
          setOpen(false);
          onOpen(n);
        }}
      />
    </>
  );
}

/** Every stalled task by agent: what it did last and when it stopped, "Continue" on each and "Continue all". */
function StalledDialog({
  open,
  onOpenChange,
  issues,
  resume,
  onOpen,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  issues: Issue[];
  resume: ReturnType<typeof useResumeStalled>;
  onOpen: (n: number) => void;
}) {
  const { t, i18n } = useTranslation();
  const actors = useActors();
  const stepOf = useTaskStep();
  const groups = stalledByAgent(issues, actors.name);
  const left = issues.filter((i) => !resume.isAsked(i));
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("issues.now.stalledTitle")}
      subtitle={t("issues.now.stalledSub", {
        tasks: t("issues.now.tasks", { count: issues.length }),
        agents: t("issues.now.agents", { count: groups.length }),
      })}
      description={t("issues.now.stalledText")}
      closeLabel={t("common.close")}
      width={560}
    >
      <section className="ac-dialog__list issues-stalled__list" aria-label={t("issues.now.stalledTitle")}>
        {groups.map((g) => (
          <div key={g.agent.id} className="issues-stalled__group">
            <h3 className="issues-stalled__grouphead">
              <AgentAvatar agentId={g.agent.id} name={g.name} size="xs" />
              {g.name}
              <span>· {g.issues.length}</span>
            </h3>
            {g.issues.map((i) => {
              const asked = resume.isAsked(i);
              const step = stepOf(i);
              const when = i.work ? stoppedLine(t, i18n.language, i.work.since) : "";
              return (
                <div key={i.id} className={cx("issues-stalled__task", asked && "is-sent")}>
                  <span className="issues-stalled__tasktext">
                    <button type="button" className="issues-stalled__title" onClick={() => onOpen(i.number)}>
                      <span className="ac-mediarow__num">#{i.number}</span> {codeAndBold(i.title)}
                    </button>
                    {asked ? (
                      <span className="issues-stalled__meta">{t("issues.now.rowSent")}</span>
                    ) : (
                      <span className="issues-stalled__meta ac-iconline">
                        <Icon name="pause" size={14} />
                        <span>{step ? `${when} · ${step}` : when}</span>
                      </span>
                    )}
                  </span>
                  {!asked && (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="play"
                      loading={resume.isBusy(i)}
                      onClick={() => resume.send([i])}
                    >
                      {t("issues.now.continue")}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </section>
      <DialogFooter bar>
        {left.length > 0 ? (
          <Button
            size="sm"
            variant="primary"
            icon="play"
            loading={left.length > 0 && left.every(resume.isBusy)}
            onClick={() => resume.send(left)}
          >
            {t("issues.now.continueAllCount", { count: left.length })}
          </Button>
        ) : (
          <Button size="sm" onClick={() => onOpenChange(false)}>
            {t("common.close")}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}

/** A state's mark: an agent at work in its color; what calls on a person, or stopped, in the attention one. */
const STATE_ICON: Record<TaskState["kind"], IconName> = {
  approval: "shield",
  question: "question",
  running: "bolt",
  stalled: "pause",
  blocked: "waiting",
};

/** The one state a task's card and row say beside who has it ("Pergunta algo", "Parado há 2 dias"). */
function StateWords({ state }: { state: TaskState }) {
  const { t } = useTranslation();
  const failed = state.kind === "blocked" && state.blocked.reason === "failed";
  return (
    <span className="issue-card__state" data-tone={state.kind === "running" ? "agent" : "warn"}>
      <Icon name={failed ? "alert" : STATE_ICON[state.kind]} size={14} inline />
      {cardStateText(t, state)}
    </span>
  );
}

/**
 * Who has it and the one thing it needs or does now, as one block of words: the face (moving while its agent works),
 * the name, the state. A long name wraps under the face at the card's full width. Several have it: their faces alone,
 * overlapping (`AssigneeFaces`), the working agent's one moving. Nobody and nothing going on: none.
 * With "Assignee" off in the view's options, the state still shows: it is what the card asks of the person.
 */
function CardWho({ issue: i, state, assignee }: { issue: Issue; state: TaskState | null; assignee: boolean }) {
  const actors = useActors();
  const all = assignee ? i.assignees : [];
  const [who] = all;
  if (!who && !state) return null;
  const work = state?.kind === "running" ? "running" : state?.kind === "stalled" ? "stalled" : undefined;
  // The agent whose run it is: the only one whose face moves.
  const agentId = work ? taskAgentId(i) : null;
  return (
    <span className="issue-card__who">
      {all.length > 1 ? (
        <AssigneeFaces all={all} working={work && agentId ? { agentId, work } : undefined} />
      ) : (
        who && (
          <ActorWho
            actor={who}
            name={actors.name(who)}
            size="sm"
            work={who.type === "agent" && who.id === agentId ? work : undefined}
          />
        )
      )}
      {state && (
        <>
          {who && " "}
          <StateWords state={state} />
        </>
      )}
    </span>
  );
}

/**
 * A card's and a row's one line of facts, each under its view toggle: the number, the project (its color's dot and
 * its name), the label (the line's one pill),
 * the priority, the due date (in the attention tone today, tomorrow and once late), the criteria, GitHub, and the
 * conversation's count (bold while unread, with the red count of mentions of me).
 */
function CardFacts({
  issue: i,
  fields,
  handed = true,
}: {
  issue: Issue;
  fields: IssuesView["fields"];
  /** "handed by Lodi" among the facts (the list says it after the title instead). */
  handed?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const { unread, mentions } = useTaskUnread(org.id, i.id);
  const facts: LineFact[] = [{ key: "number", text: `#${i.number}` }];
  const handedBy = handed ? i.backgroundWork?.handedBy : null;
  if (fields.project && i.project)
    facts.push({
      key: "project",
      icon: <ColorDot color={i.project.color} />,
      text: i.project.name,
      title: t("issues.projects.label"),
    });
  const [label, ...labels] = i.labels;
  if (fields.label && label) {
    facts.push({ key: "label", text: label, tone: "label" });
    if (labels.length > 0) facts.push({ key: "labels", text: `+${labels.length}`, title: labels.join(", ") });
  }
  if (handedBy) facts.push({ key: "handed", text: <HandedBy agentId={handedBy.agentId} /> });
  if (fields.priority && i.priority !== "normal")
    facts.push({
      key: "priority",
      icon: i.priority === "high" ? "arrowUp" : "arrowDown",
      text: t(`issues.priority.${i.priority}`),
      tone: i.priority === "high" ? "warn-icon" : undefined,
    });
  if (fields.due && i.dueDate && isOpen(i)) {
    const tone = dueTone(i.dueDate);
    facts.push({
      key: "due",
      icon: tone === "late" ? "alert" : "calendar",
      text: dueLabel(t, i18n.language, i.dueDate),
      tone: tone ? "warn" : undefined,
      title: t("issues.due"),
    });
  }
  if (fields.criteria && i.criteria.length > 0) {
    const done = i.criteria.filter((c) => c.done).length;
    const total = i.criteria.length;
    facts.push({
      key: "criteria",
      icon: "approve",
      text: `${done}/${total}`,
      tone: done === total ? "ok" : undefined,
      title: t("issues.criteriaLabel", { done, total }),
    });
  }
  const pr = fields.pullRequest ? i.pullRequests.at(-1) : undefined;
  if (pr) facts.push({ key: "pr", icon: <GitHubMark />, text: t("issues.pr", { number: pr.number }) });
  if (fields.pullRequest && i.githubUrl)
    facts.push({ key: "github", icon: <GitHubMark />, text: githubLinkLabel(i.githubUrl), title: i.githubUrl });
  const talk = i.conversation?.count ?? 0;
  if (talk > 0 || mentions > 0)
    facts.push({
      key: "talk",
      icon: "thread",
      text: (
        <>
          {talk > 0 && talk}
          <TaskMentions issue={i} />
        </>
      ),
      tone: unread > 0 ? "bold" : undefined,
      title: talk > 0 ? t("issues.conversation.messages", { count: talk }) : undefined,
    });
  return <FactLine className="issue-card__facts" facts={facts} />;
}

/** "handed by [face] Lodi": the agent that handed a task's work over. */
function HandedBy({ agentId }: { agentId: string }) {
  const actors = useActors();
  const name = actors.name({ type: "agent", id: agentId });
  return (
    <Trans
      i18nKey="issues.handedBy"
      values={{ name }}
      components={[<AgentAvatar key="face" agentId={agentId} name={name} state="idle" size="xs" />]}
    />
  );
}

/** What came of a finished handed task: its report's first line. */
function CardResult({ issue: i }: { issue: Issue }) {
  const result = i.status === "done" ? i.backgroundWork?.result : null;
  if (!result) return null;
  return (
    <span className="issue-card__result">
      <Icon name="check" size={14} inline />
      <span>{result.text}</span>
    </span>
  );
}

/** The list's columns after the number and the title, in the row's order (issues.css names a grid line for each). */
const LIST_COLUMNS: readonly IssueCardField[] = [
  "project",
  "label",
  "priority",
  "due",
  "criteria",
  "pullRequest",
  "assignee",
];

/**
 * The columns the list stands as a table: every one turned on in "Display", whether or not a task shown has it, so
 * the table keeps its shape while tasks come and go.
 */
const listColumns = (fields: IssuesView["fields"]) => LIST_COLUMNS.filter((c) => fields[c]);

/** The grid line a column ends at: the next column's, shown or not (one turned off is 0 wide), or the room left over. */
const columnEnd = (column: IssueListColumn) =>
  column === "title" ? LIST_COLUMNS[0] : (LIST_COLUMNS[LIST_COLUMNS.indexOf(column) + 1] ?? "fill");

/**
 * The table's columns as issues.css reads them (`--col-<name>`): a column at the width the person gave it, or at its
 * own; one turned off takes no room. The title takes the room left over until it is given a width; from then on that
 * room stays empty after the last column.
 */
function columnTracks(shown: readonly IssueCardField[], widths: IssuesView["widths"]): Record<string, string> {
  const tracks: Record<string, string> = {
    "--col-title": widths.title ? `${widths.title}px` : `minmax(${ISSUE_COLUMN_WIDTHS.title.base}px, 1fr)`,
    "--col-fill": widths.title ? "minmax(0, 1fr)" : "0px",
  };
  for (const c of LIST_COLUMNS)
    tracks[`--col-${c}`] = shown.includes(c) ? `${widths[c] ?? ISSUE_COLUMN_WIDTHS[c].base}px` : "0px";
  return tracks;
}

/** The columns a click on their name orders the list by, and that order. */
const COLUMN_SORT: Partial<Record<IssueCardField, IssuesView["sort"]>> = { priority: "priority", due: "due" };

/** How far an arrow key moves a column's edge. */
const WIDTH_STEP = 16;

/**
 * A column's width while its edge moves: `show` draws it on the table without saving (`null` puts the saved one back),
 * `save` keeps it in the view (`null`: the column's own width again).
 */
interface ColumnSizing {
  show: (column: IssueListColumn, width: number | null) => void;
  save: (column: IssueListColumn, width: number | null) => void;
}

/**
 * The handle at the end of a column's name: dragged (mouse, pen or finger), it changes that column's width, the table
 * following as it moves and the view keeping the width once it is let go; a double click gives the column its own
 * width back. With the keyboard: the arrows move it a step, Home and End take it to its least and most, Enter gives
 * the column its own width back.
 */
function ColumnGrip({
  column,
  name,
  width,
  measure,
  sizing,
}: {
  column: IssueListColumn;
  name: string;
  /** The column's width now. */
  width: number;
  /** Its width read off the screen, where the window decides it (the title, while it takes the room left over). */
  measure?: () => number;
  sizing: ColumnSizing;
}) {
  const { t } = useTranslation();
  const { min, max } = ISSUE_COLUMN_WIDTHS[column];
  const drag = useRef<{ pointer: number; x: number; from: number; to: number; rtl: boolean } | null>(null);
  const now = () => clampColumnWidth(column, measure?.() ?? width);
  const rtl = (el: Element) => getComputedStyle(el).direction === "rtl";
  const onPointerDown = (e: ReactPointerEvent<HTMLSpanElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // The press is the handle's alone: it selects no text and starts nothing under it.
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const from = now();
    drag.current = { pointer: e.pointerId, x: e.clientX, from, to: from, rtl: rtl(e.currentTarget) };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLSpanElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    const to = clampColumnWidth(column, d.from + (e.clientX - d.x) * (d.rtl ? -1 : 1));
    if (to === d.to) return;
    d.to = to;
    e.currentTarget.setAttribute("aria-valuenow", String(to));
    sizing.show(column, to);
  };
  const end = (e: ReactPointerEvent<HTMLSpanElement>, keep: boolean) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    sizing.show(column, null);
    if (keep && d.to !== d.from) sizing.save(column, d.to);
    else e.currentTarget.setAttribute("aria-valuenow", String(d.from));
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLSpanElement>) => {
    const grow = rtl(e.currentTarget) ? "ArrowLeft" : "ArrowRight";
    const next =
      e.key === "ArrowLeft" || e.key === "ArrowRight"
        ? now() + (e.key === grow ? WIDTH_STEP : -WIDTH_STEP)
        : e.key === "Home"
          ? min
          : e.key === "End"
            ? max
            : e.key === "Enter"
              ? null
              : undefined;
    if (next === undefined) return;
    e.preventDefault();
    sizing.save(column, next);
  };
  const label = t("issues.table.resize", { column: name });
  return (
    // biome-ignore lint/a11y/useSemanticElements: a separator that moves is a control with a value, which `hr` is not.
    <span
      className="issue-table__grip"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={clampColumnWidth(column, width)}
      aria-valuemin={min}
      aria-valuemax={max}
      title={label}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => end(e, true)}
      onPointerCancel={(e) => end(e, false)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={() => sizing.save(column, null)}
      onKeyDown={onKeyDown}
    />
  );
}

/**
 * The table's line of column names, over every group, each with the handle that sizes its column. "Priority" and
 * "Due date" order the list: a click takes that order, another gives the board's own back (the same choice as
 * "Sort by" in "Display").
 */
function ListHead({
  columns,
  sort,
  onSort,
  widths,
  sizing,
}: {
  columns: readonly IssueCardField[];
  sort: IssuesView["sort"];
  onSort: (sort: IssuesView["sort"]) => void;
  widths: IssuesView["widths"];
  sizing: ColumnSizing;
}) {
  const { t } = useTranslation();
  const titleCell = useRef<HTMLSpanElement>(null);
  // The title's width while it takes the room left over is whatever the window gives it: measured, for the handle's
  // value and for where a drag starts.
  const [titleNow, setTitleNow] = useState<number>(ISSUE_COLUMN_WIDTHS.title.base);
  const measureTitle = () =>
    Math.round(titleCell.current?.getBoundingClientRect().width ?? 0) || ISSUE_COLUMN_WIDTHS.title.base;
  useLayoutEffect(() => {
    const cell = titleCell.current;
    if (!cell || widths.title) return;
    const read = () => setTitleNow(Math.round(cell.getBoundingClientRect().width) || ISSUE_COLUMN_WIDTHS.title.base);
    read();
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(read);
    watch.observe(cell);
    return () => watch.disconnect();
  }, [widths.title]);
  const name = (c: IssueCardField) => (c === "pullRequest" ? t("issues.table.github") : t(`issues.display.field.${c}`));
  return (
    <div className="issue-table__head">
      <span ref={titleCell} data-column="title">
        <span className="issue-table__name">{t("issues.table.task")}</span>
        <ColumnGrip
          column="title"
          name={t("issues.table.task")}
          width={widths.title ?? titleNow}
          measure={widths.title ? undefined : measureTitle}
          sizing={sizing}
        />
      </span>
      {columns.map((c) => {
        const by = COLUMN_SORT[c];
        return (
          <span key={c} data-column={c}>
            {by ? (
              <button
                type="button"
                className="issue-table__sort"
                aria-pressed={sort === by}
                title={t("issues.table.sortBy", { column: name(c) })}
                onClick={() => onSort(sort === by ? "manual" : by)}
              >
                <span className="issue-table__name">{name(c)}</span>
                <Icon name="arrowDown" size={14} />
              </button>
            ) : (
              <span className="issue-table__name">{name(c)}</span>
            )}
            <ColumnGrip column={c} name={name(c)} width={widths[c] ?? ISSUE_COLUMN_WIDTHS[c].base} sizing={sizing} />
          </span>
        );
      })}
    </div>
  );
}

/**
 * What a card and a row say of a task: its one state (from its agent's work or a live turn), their link's name, and
 * who has it as the link's description (`who`, rendered inside it; `describedBy` adds the drag help).
 */
function useTaskCard(i: Issue) {
  const { t } = useTranslation();
  const actors = useActors();
  const whoId = useId();
  const state = cardState(i, useTaskLive(i));
  const name = t("issues.open", { number: i.number, title: i.title });
  const who = i.assignees.length > 0 && (
    <span id={whoId} hidden>
      {`${t("issues.form.assignee")}: ${joinNames(i.assignees.map(actors.name), t)}`}
    </span>
  );
  return {
    state,
    label: state ? `${name}, ${cardStateText(t, state)}` : name,
    who,
    describedBy: (help: string) => (who ? `${whoId} ${help}` : help),
  };
}

/** An issue's right click (board card, list row): open beside the list, open its page, copy its link, delete it. */
function useIssueMenu() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const toast = useToast();
  const { ask, mayDelete } = useIssueDeleting();
  return (i: Issue, onOpen: () => void) =>
    entityMenu(() => [
      { kind: "header", label: `#${i.number} ${i.title}` },
      { kind: "item", id: "open", label: t("contextMenu.open"), icon: "arrowRight", run: onOpen },
      {
        kind: "item",
        id: "open-page",
        label: t("contextMenu.openPage"),
        icon: "expand",
        run: () =>
          void navigate({ to: "/org/$orgId/issues/$number", params: { orgId: org.id, number: String(i.number) } }),
      },
      { kind: "separator" },
      {
        kind: "item",
        id: "copy-link",
        label: t("contextMenu.copyLink"),
        icon: "link",
        run: () =>
          void copyText(`${window.location.origin}/org/${org.id}/issues/${i.number}`, () =>
            toast.show(t("contextMenu.linkCopied")),
          ),
      },
      ...(mayDelete(i)
        ? ([
            { kind: "separator" },
            {
              kind: "item",
              id: "delete",
              label: t("issues.delete.action"),
              icon: "trash",
              danger: true,
              run: () => ask(i),
            },
          ] as const)
        : []),
    ]);
}

/** What a card takes to move: the pointer and keyboard handlers, and the line that says how. */
type CardDrag = ReturnType<IssueDrag<Issue>["card"]> & { help: string };

/** A card's or a row's own keys first (the menu key), then Space picks it up. */
function withMenuKeys(menu: ReturnType<ReturnType<typeof useIssueMenu>>, drag: CardDrag) {
  return (e: Parameters<CardDrag["onKeyDown"]>[0]) => {
    menu.onKeyDown(e);
    drag.onKeyDown(e);
  };
}

/**
 * A task on the board, in three parts on the card's left edge: the title, whole; one line of facts; who has it and
 * the one thing it needs or does now. An agent waiting on a person gives the card its sky; while it works, its sweep.
 */
function IssueCard({
  issue: i,
  selected,
  onOpen,
  drag,
  picked,
  fields,
}: {
  issue: Issue;
  selected: boolean;
  onOpen: () => void;
  drag: CardDrag;
  picked: boolean;
  fields: IssuesView["fields"];
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const color = useAssigneeColor();
  const { state, label, who, describedBy } = useTaskCard(i);
  const menu = useIssueMenu()(i, () => !selected && onOpen());
  return (
    <Link
      to="/org/$orgId/issues/$number"
      params={{ orgId: org.id, number: String(i.number) }}
      className={cx("issue-card", selected && "is-on", picked && "is-picked")}
      aria-label={label}
      aria-current={selected || undefined}
      aria-roledescription={t("issues.drag.role")}
      aria-describedby={describedBy(drag.help)}
      draggable={drag.draggable}
      onDragStart={drag.onDragStart}
      onPointerDown={drag.onPointerDown}
      onClick={(e) => inPlaceClick(e, onOpen)}
      onContextMenu={menu.onContextMenu}
      onKeyDown={withMenuKeys(menu, drag)}
      data-status={i.status}
      data-card={i.number}
    >
      {cardWaits(state) && <CardSky color={color(i) ?? "sky"} />}
      <span className="issue-card__title">{codeAndBold(i.title)}</span>
      <CardFacts issue={i} fields={fields} />
      <CardResult issue={i} />
      <CardWho issue={i} state={state} assignee={fields.assignee} />
      {state?.kind === "running" && <WorkSweep color={color(i) ?? "sky"} />}
      {who}
    </Link>
  );
}

/**
 * The list, a table: one line of column names, then the groups as bands across it, every row's facts in the same
 * columns, whose widths the person sets by dragging a column name's end. Grouped by stage: each stage, then its
 * columns when the board is customized. Otherwise one group per assignee or priority. A group with nothing in it
 * shows only while a card moves, so there is somewhere to drop it; a folded one shows its name and count.
 */
function IssueList({
  groups,
  stages,
  columns,
  dnd,
  openNumber,
  onOpen,
  fields,
  helpId,
  sort,
  onSort,
  widths,
  onWidths,
  collapsed,
  onFold,
}: {
  groups: IssueGroup[];
  stages: { stage: IssueStatus; columns: IssueColumn[] }[] | null;
  columns: IssueColumn[];
  dnd: IssueDrag<Issue>;
  openNumber: number | null;
  onOpen: (n: number) => void;
  fields: IssuesView["fields"];
  helpId: string;
  sort: IssuesView["sort"];
  onSort: (sort: IssuesView["sort"]) => void;
  /** The widths the person gave the columns, and a change to them. */
  widths: IssuesView["widths"];
  onWidths: (widths: IssuesView["widths"]) => void;
  collapsed: string[];
  onFold: (group: string, folded: boolean) => void;
}) {
  const { t } = useTranslation();
  const stageName = useStageName();
  const title = useColumnTitle();
  const custom = isCustomBoard(columns);
  const byId = new Map(groups.map((g) => [g.id, g]));
  const shown = listColumns(fields);
  const table = useRef<HTMLDivElement>(null);
  const guide = useRef<HTMLSpanElement>(null);
  const tracks = columnTracks(shown, widths);
  const sizing: ColumnSizing = {
    // Straight on the table, so a drag redraws no row; the saved widths go back before a change is saved, so what
    // the table shows is always what was last rendered.
    show: (column, width) => {
      const next = width === null ? tracks : columnTracks(shown, { ...widths, [column]: width });
      for (const [track, value] of Object.entries(next)) table.current?.style.setProperty(track, value);
      if (!guide.current) return;
      guide.current.hidden = width === null;
      guide.current.style.gridColumn = `${column} / ${columnEnd(column)}`;
    },
    save: (column, width) => {
      const next = withColumnWidth(widths, column, width);
      const same = Object.keys(next).length === Object.keys(widths).length && widths[column] === next[column];
      if (!same) onWidths(next);
    },
  };
  /** The table: its column names, the hairline between two columns down its whole height, then the groups. */
  const frame = (body: ReactNode) => (
    <div className="issue-tableframe page-split">
      <div className="issue-tablewrap" data-scroll-restoration-id="issues-list">
        <div ref={table} className="ac-groups issue-table" style={tracks as CSSProperties}>
          <ListHead columns={shown} sort={sort} onSort={onSort} widths={widths} sizing={sizing} />
          {shown.map((c) => (
            <span key={c} className="issue-table__rule" data-column={c} style={{ gridColumn: c }} aria-hidden="true" />
          ))}
          {widths.title !== undefined && (
            <span className="issue-table__rule" data-column="fill" style={{ gridColumn: "fill" }} aria-hidden="true" />
          )}
          <span ref={guide} className="issue-table__guide" aria-hidden="true" hidden />
          {body}
        </div>
      </div>
    </div>
  );
  /** A group's name as the button that folds and opens it. */
  const fold = (id: string, name: string, lead: ReactNode) => {
    const folded = collapsed.includes(id);
    const words = t(folded ? "issues.fold.open" : "issues.fold.close", { name });
    return (
      <button
        type="button"
        aria-expanded={!folded}
        aria-label={words}
        title={words}
        onClick={() => onFold(id, !folded)}
      >
        <Icon name={folded ? "chevronRight" : "chevronDown"} size={14} />
        {lead}
        {name}
      </button>
    );
  };
  const zone = (g: IssueGroup, heading?: ReactNode) => (
    <div key={g.id} className={cx("issues-group__col", dnd.over === g.id && "is-over")} data-col>
      {heading}
      <IssueRows
        group={g}
        folded={collapsed.includes(g.id)}
        dnd={dnd}
        openNumber={openNumber}
        onOpen={onOpen}
        fields={fields}
        helpId={helpId}
      />
    </div>
  );
  if (stages)
    return frame(
      stages.map(({ stage, columns: cols }) => {
        const count = cols.reduce((n, c) => n + dnd.count(c.id), 0);
        if (count === 0 && !dnd.active) return null;
        const only = custom ? undefined : cols[0];
        const lead = <Icon name={STATUS_ICON[stage]} size={16} />;
        return (
          <section key={stage} className="issues-group" aria-label={stageName(stage)}>
            <GroupHeading
              title={
                only ? (
                  fold(only.id, stageName(stage), lead)
                ) : (
                  <>
                    {lead}
                    {stageName(stage)}
                  </>
                )
              }
              count={
                <span className="tabular" data-count={only?.id}>
                  {count}
                </span>
              }
            />
            {cols.map((c) => {
              const g = byId.get(c.id);
              if (!g || (dnd.count(c.id) === 0 && !dnd.active)) return null;
              return zone(
                g,
                custom && stage !== "canceled" && (
                  <GroupHeading
                    level={3}
                    title={fold(c.id, title(c), null)}
                    count={
                      <span className="tabular" data-count={c.id}>
                        {dnd.count(c.id)}
                      </span>
                    }
                  />
                ),
              );
            })}
          </section>
        );
      }),
    );
  return frame(
    groups.map((g) => {
      const count = dnd.count(g.id);
      if (count === 0 && !dnd.active) return null;
      return (
        <section key={g.id} className="issues-group" aria-label={g.name}>
          <GroupHeading
            title={fold(g.id, g.name, g.lead)}
            count={
              <span className="tabular" data-count={g.id}>
                {count}
              </span>
            }
          />
          {zone(g)}
        </section>
      );
    }),
  );
}

function IssueRows({
  group: g,
  folded,
  dnd,
  openNumber,
  onOpen,
  fields,
  helpId,
}: {
  group: IssueGroup;
  /** Folded: no row but one picked with the keyboard and moved here, so the focus has where to stay. */
  folded: boolean;
  dnd: IssueDrag<Issue>;
  openNumber: number | null;
  onOpen: (n: number) => void;
  fields: IssuesView["fields"];
  helpId: string;
}) {
  const menuOf = useIssueMenu();
  const entries = dnd.entries(g.id).filter((e) => !folded || (e.kind === "card" && e.state === "picked"));
  if (folded && entries.length === 0) return <ul className="issue-list issue-list--folded" data-drop={g.id} />;
  const shown = entries.some((e) => e.kind === "spot" || e.state !== "hidden");
  return (
    <ul className="issue-list" data-drop={g.id}>
      {entries.map((e) => {
        if (e.kind === "spot")
          return <li key={e.key} className="issue-spot issue-spot--row" data-spot style={e.style} aria-hidden="true" />;
        const i = e.item;
        return (
          <li
            key={i.id}
            data-slot={dnd.slot(i, g.id)}
            hidden={e.state === "hidden" || undefined}
            data-landing={e.state === "landing" || undefined}
          >
            <IssueRow
              issue={i}
              selected={i.number === openNumber}
              picked={e.state === "picked"}
              menu={menuOf(i, () => i.number !== openNumber && onOpen(i.number))}
              drag={{ ...dnd.card(i, g.id), help: helpId }}
              onOpen={() => onOpen(i.number)}
              fields={fields}
            />
          </li>
        );
      })}
      {!shown && dnd.active && (
        <li className="issue-list__drop" aria-hidden="true">
          {g.dropText}
        </li>
      )}
    </ul>
  );
}

/**
 * A task in the list, from the card's parts: wide, a table's row (its number, its title on one line, each fact in its
 * column, who has it); narrow, stacked as a card, the number among the facts.
 */
function IssueRow({
  issue: i,
  selected,
  picked,
  menu,
  drag,
  onOpen,
  fields,
}: {
  issue: Issue;
  selected: boolean;
  picked: boolean;
  menu: ReturnType<ReturnType<typeof useIssueMenu>>;
  drag: CardDrag;
  onOpen: () => void;
  fields: IssuesView["fields"];
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const color = useAssigneeColor();
  const { state, label, who, describedBy } = useTaskCard(i);
  return (
    <Link
      to="/org/$orgId/issues/$number"
      params={{ orgId: org.id, number: String(i.number) }}
      className={cx("issue-list__row", selected && "is-on", picked && "is-picked")}
      aria-label={label}
      aria-roledescription={t("issues.drag.role")}
      aria-describedby={describedBy(drag.help)}
      draggable={drag.draggable}
      onDragStart={drag.onDragStart}
      onPointerDown={drag.onPointerDown}
      onClick={(ev) => inPlaceClick(ev, onOpen)}
      onContextMenu={menu.onContextMenu}
      onKeyDown={withMenuKeys(menu, drag)}
      data-card={i.number}
    >
      <span className="issue-list__num tabular" aria-hidden="true">
        #{i.number}
      </span>
      <span className="issue-list__title" title={i.title}>
        {codeAndBold(i.title)}
        {i.backgroundWork?.handedBy && (
          <span className="issue-list__from">
            <HandedBy agentId={i.backgroundWork.handedBy.agentId} />
          </span>
        )}
      </span>
      <CardFacts issue={i} fields={fields} handed={false} />
      <CardWho issue={i} state={state} assignee={fields.assignee} />
      <span className="issue-sr">{t(`issues.status.${i.status}`)}</span>
      {state?.kind === "running" && <WorkSweep color={color(i) ?? "sky"} />}
      {who}
    </Link>
  );
}
