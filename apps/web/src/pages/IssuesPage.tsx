import type { Actor, Issue, IssueColumn, IssuePriority, IssueStatus, IssuesView } from "@agenteschat/client";
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
import { dueLabel, dueTone, namesText, stoppedLine } from "@agenteschat/client/lib/format";
import { githubLinkLabel } from "@agenteschat/client/lib/github-link";
import { NO_PROJECT, projectOfFilter } from "@agenteschat/client/lib/issue-projects";
import { ISSUES_VIEW_DEFAULT, PRIORITY_ORDER, sortIssues } from "@agenteschat/client/lib/issues-view";
import { can } from "@agenteschat/client/lib/permissions";
import { shownSteps } from "@agenteschat/client/lib/work";
import {
  AvatarStack,
  Button,
  Chip,
  ColorDot,
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
import { type CSSProperties, type ReactNode, useDeferredValue, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
  isCustomBoard,
  isOpen,
  isStalled,
  rankAt,
  STATUS_ICON,
  type CardState as TaskState,
  useAssigneeColor,
  useColumnTitle,
  useStageName,
  useStepText,
} from "@/lib/issues";
import { lookOf } from "@/lib/look";
import { codeAndBold } from "@/lib/markdown";
import { inPlaceClick } from "@/lib/navigate";
import { useOpenParam } from "@/lib/open-param";
import { type ToastText, useToast } from "@/lib/toast";
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
  const filtered = all.filter(
    (i) =>
      (view.assignees.length === 0 || view.assignees.includes(actorKey(i.assignee))) &&
      (view.priorities.length === 0 || view.priorities.includes(i.priority)),
  );
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
                    agents: open.filter((i) => i.assignee?.type === "agent").length,
                  })}
                </span>
                {open.some((i) => !i.assignee) && (
                  <span> · {t("issues.unassigned", { count: open.filter((i) => !i.assignee).length })}</span>
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
                    changeView({ assignees: [], priorities: [] });
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
              issues={filtered.filter((i) => view.showCanceled || i.status !== "canceled")}
              all={all}
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
 */
function IssuesBody({
  view,
  columns,
  issues,
  all,
  openNumber,
  onOpen,
  onNew,
}: {
  view: IssuesView;
  columns: IssueColumn[];
  /** The tasks on screen: filtered, canceled ones only when asked. */
  issues: Issue[];
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
      ...all.filter((i) => view.showCanceled || i.status !== "canceled").map((i) => actorKey(i.assignee)),
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
        items: inOrder(issues.filter((i) => actorKey(i.assignee) === actorKey(actor))),
        lead: <ActorAvatar actor={actor} name={name} size="xs" />,
        dropText: t("issues.drop.assignee", { name }),
      });
    }
    groups.push({
      id: NO_ACTOR,
      name: t("issues.noAssignee"),
      items: inOrder(issues.filter((i) => !i.assignee)),
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
  const assignedText = (issue: Issue, to: Actor | null): ToastText => {
    if (!to) return t("issues.drag.unassigned", { number: issue.number });
    const name = actors.name(to);
    const text = t("issues.drag.assigned", { number: issue.number, name });
    return to.type === "agent" ? { text, who: { name, appearance: lookOf(actors.dir.agentById.get(to.id)) } } : text;
  };
  const reassign = (issue: Issue, to: Actor | null) => {
    const was = issue.assignee;
    const back = () => patch({ ...issue, assignee: to }, { assignee: was }, { assignee: was });
    patch(issue, { assignee: to }, { assignee: to }, () => toast.show(assignedText(issue, to), "info", undo(back)));
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
    if (view.group === "assignee") reassign(issue, actorFromKey(to));
    else prioritize(issue, to as IssuePriority);
    return { changed: true };
  };
  const nameOf = (group: string) => groups.find((g) => g.id === group)?.name ?? "";
  const dnd = useIssueDrag<Issue>({
    groups,
    layout: view.layout,
    onDrop,
    words: {
      picked: (i) => t("issues.drag.picked", { number: i.number }),
      moved: (i, group, position, total) =>
        t("issues.drag.moved", { number: i.number, group: nameOf(group), position, total }),
      dropped: (i, group) => t("issues.drag.dropped", { number: i.number, group: nameOf(group) }),
      canceled: (i) => t("issues.drag.canceled", { number: i.number }),
    },
  });
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
  const stalled = issues.filter((i) => isOpen(i) && isStalled(i) && i.work && i.assignee?.type === "agent");
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
    if (!i.assignee) continue;
    const g = groups.get(i.assignee.id);
    if (g) g.issues.push(i);
    else groups.set(i.assignee.id, { agent: i.assignee, name: name(i.assignee), issues: [i] });
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
      const results = await Promise.allSettled(
        list.map((i) => api.issues.askAgent(org.id, i.id, i.assignee?.id ?? "")),
      );
      mark(ids, false);
      setAsked((prev) => {
        const next = new Map(prev);
        for (const [k, r] of results.entries()) {
          const i = list[k];
          if (r.status === "fulfilled" && i?.work) next.set(i.id, i.work.since);
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
 * the name, the state. A long name wraps under the face at the card's full width. Nobody and nothing going on: none.
 * With Responsável off in Exibição, the state still shows: it is what the card asks of the person.
 */
function CardWho({ issue: i, state, assignee }: { issue: Issue; state: TaskState | null; assignee: boolean }) {
  const actors = useActors();
  const who = assignee ? i.assignee : null;
  if (!who && !state) return null;
  const work = state?.kind === "running" ? "running" : state?.kind === "stalled" ? "stalled" : undefined;
  return (
    <span className="issue-card__who">
      {who && <ActorWho actor={who} name={actors.name(who)} size="sm" work={work} />}
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
function CardFacts({ issue: i, fields }: { issue: Issue; fields: IssuesView["fields"] }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const { unread, mentions } = useTaskUnread(org.id, i.id);
  const facts: LineFact[] = [{ key: "number", text: `#${i.number}` }];
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

/** The gap between two facts on a line (`.ac-factline`'s). */
const FACT_GAP = 12;
/** The widest set of columns the list lays out, and the step their room is counted in (issues.css has one rule each). */
const FACT_COLUMNS_MAX = 640;
const FACT_COLUMNS_STEP = 80;

/**
 * The list's columns of facts, one for each fact some task shown has (and its view toggle allows), in the facts'
 * order: every row stands its facts in the same columns, so labels, priorities, dates and criteria line up down the
 * list instead of each row packing what it has against its end. Each column is as wide as its fact reads at most;
 * a name longer than its column (a project, a label, a repository) ends in "…". `room`: what the columns take, in
 * steps, which the list needs beside a title before it stands them (issues.css). With more columns than a list ever
 * has room for (every fact at once), none: the rows keep packing their facts.
 */
function listFactColumns(issues: Issue[], fields: IssuesView["fields"]) {
  const any = (has: (i: Issue) => unknown) => issues.some((i) => Boolean(has(i)));
  const columns = (
    [
      ["project", 128, fields.project && any((i) => i.project)],
      ["label", 104, fields.label && any((i) => i.labels.length > 0)],
      ["labels", 24, fields.label && any((i) => i.labels.length > 1)],
      ["priority", 72, fields.priority && any((i) => i.priority !== "normal")],
      ["due", 80, fields.due && any((i) => i.dueDate && isOpen(i))],
      ["criteria", 60, fields.criteria && any((i) => i.criteria.length > 0)],
      ["pr", 88, fields.pullRequest && any((i) => i.pullRequests.length > 0)],
      ["github", 112, fields.pullRequest && any((i) => i.githubUrl)],
      // Always: a mention of me shows there with no message counted yet, and a fact with no column of its own would
      // widen its row alone and push its other facts out of line.
      ["talk", 56, true],
    ] as const
  ).filter(([, , shown]) => shown);
  const width = columns.reduce((sum, [, px]) => sum + px, 0) + FACT_GAP * Math.max(0, columns.length - 1);
  if (columns.length === 0 || width > FACT_COLUMNS_MAX) return null;
  return {
    template: columns.map(([name, px]) => `[${name}] ${px}px`).join(" "),
    room: Math.ceil(width / FACT_COLUMNS_STEP) * FACT_COLUMNS_STEP,
  };
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
  const who = i.assignee && (
    <span id={whoId} hidden>
      {`${t("issues.form.assignee")}: ${actors.name(i.assignee)}`}
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
      <CardWho issue={i} state={state} assignee={fields.assignee} />
      {state?.kind === "running" && <WorkSweep color={color(i) ?? "sky"} />}
      {who}
    </Link>
  );
}

/**
 * The list. Grouped by stage: each stage, then its columns when the board is customized. Otherwise one group per
 * assignee or priority. A group with nothing in it shows only while a card moves, so there is somewhere to drop it.
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
}: {
  groups: IssueGroup[];
  stages: { stage: IssueStatus; columns: IssueColumn[] }[] | null;
  columns: IssueColumn[];
  dnd: IssueDrag<Issue>;
  openNumber: number | null;
  onOpen: (n: number) => void;
  fields: IssuesView["fields"];
  helpId: string;
}) {
  const stageName = useStageName();
  const title = useColumnTitle();
  const custom = isCustomBoard(columns);
  const byId = new Map(groups.map((g) => [g.id, g]));
  // One set of fact columns for the whole list, whatever its groups: read by every row (issues.css).
  const facts = listFactColumns(
    groups.flatMap((g) => g.items),
    fields,
  );
  const factColumns = {
    "data-fact-columns": facts?.room,
    style: facts ? ({ "--issue-facts": facts.template } as CSSProperties) : undefined,
  };
  const zone = (g: IssueGroup, heading?: ReactNode) => (
    <div key={g.id} className={cx("issues-group__col", dnd.over === g.id && "is-over")} data-col>
      {heading}
      <IssueRows group={g} dnd={dnd} openNumber={openNumber} onOpen={onOpen} fields={fields} helpId={helpId} />
    </div>
  );
  if (stages)
    return (
      <div className="ac-groups" {...factColumns}>
        {stages.map(({ stage, columns: cols }) => {
          const count = cols.reduce((n, c) => n + dnd.count(c.id), 0);
          if (count === 0 && !dnd.active) return null;
          return (
            <section key={stage} className="issues-group" aria-label={stageName(stage)}>
              <GroupHeading
                title={
                  <>
                    <Icon name={STATUS_ICON[stage]} size={16} />
                    {stageName(stage)}
                  </>
                }
                count={
                  <span className="tabular" data-count={custom ? undefined : cols[0]?.id}>
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
                      title={title(c)}
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
        })}
      </div>
    );
  return (
    <div className="ac-groups" {...factColumns}>
      {groups.map((g) => {
        const count = dnd.count(g.id);
        if (count === 0 && !dnd.active) return null;
        return (
          <section key={g.id} className="issues-group" aria-label={g.name}>
            <GroupHeading
              title={
                <>
                  {g.lead}
                  {g.name}
                </>
              }
              count={
                <span className="tabular" data-count={g.id}>
                  {count}
                </span>
              }
            />
            {zone(g)}
          </section>
        );
      })}
    </div>
  );
}

function IssueRows({
  group: g,
  dnd,
  openNumber,
  onOpen,
  fields,
  helpId,
}: {
  group: IssueGroup;
  dnd: IssueDrag<Issue>;
  openNumber: number | null;
  onOpen: (n: number) => void;
  fields: IssuesView["fields"];
  helpId: string;
}) {
  const menuOf = useIssueMenu();
  const entries = dnd.entries(g.id);
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
            data-slot={i.id}
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
 * A task in the list, from the card's parts: wide, its number, its title whole, its facts at its end (up to 40% of the
 * row, ending on one right edge) and who has it; narrow, stacked as a card, the number among the facts.
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
      <span className="issue-list__title">{codeAndBold(i.title)}</span>
      <CardFacts issue={i} fields={fields} />
      <CardWho issue={i} state={state} assignee={fields.assignee} />
      <span className="issue-sr">{t(`issues.status.${i.status}`)}</span>
      {state?.kind === "running" && <WorkSweep color={color(i) ?? "sky"} />}
      {who}
    </Link>
  );
}
