import {
  type CodeSession,
  type CodeSessionOrigin,
  keys,
  useApi,
  useChannelMembers,
  useCloseCodeSession,
  useCodeSession,
  useRetryCodeSession,
  useThreadInfo,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { messagePath } from "@agenteschat/client/lib/message-links";
import { can } from "@agenteschat/client/lib/permissions";
import { planMeterText, usageShown } from "@agenteschat/client/lib/plan-usage";
import {
  AvatarStack,
  Button,
  EventPill,
  EventPillMore,
  Icon,
  Menu,
  MenuItem,
  Popover,
  planLevel,
  planLine,
} from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type CSSProperties, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useActors } from "@/components/actors";
import { ModelPickerButton } from "@/components/ai/ModelPicker";
import { ScreenPanelContext } from "@/components/browser/screen-panel";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import { ChannelPage, ChannelSkeleton } from "@/pages/ChannelPage";
import { CodeFileTab } from "./CodeFileTab";
import { GitDiff, type GitOpened } from "./CodeGit";
import { CodeGutter, useStoredSize } from "./CodeGutter";
import { CodePanel, useCodeTab } from "./CodePanel";
import { CodeDockSky } from "./CodeSky";
import { useCodeKey } from "./shortcuts";
import { endKeptTerminal, TerminalPane } from "./TerminalPane";

/**
 * One code session (ADR 0215): the conversation with its agent under the session's header (its name), the chat's own
 * thread screen (tool rows, steering, stop, approvals), and the side panel. Under the header, tabs: the conversation,
 * each file opened from the Files tab (an editor), each diff opened from the Git tab and each terminal opened there; the ones off screen stay as they
 * are (what was typed, a shell's output). The gutter between them drags (double
 * click puts it back). The screen is the panel's: the conversation's browser cards are a line that opens it, and it
 * turns to the screen as the agent starts using it.
 */
export function CodeSessionView({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const session = useCodeSession(org.id, sessionId);
  const talk = useStoredSize("code:talkWidth", 360, 1100, 620);
  const [tab, setTab] = useCodeTab();
  const screen = useMemo(() => ({ show: () => setTab("screen") }), [setTab]);
  const tabs = useSessionTabs(sessionId);
  // ⌘P: the Files tab, whose search opens with it (`CodeFiles`).
  useCodeKey("files", () => setTab("files"));
  if (session.isPending) return <ChannelSkeleton thread panel />;
  if (!session.data)
    return (
      <div className="code-session code-session--missing">
        <p className="code-empty">{session.error ? errorText(t, session.error) : t("codeSessions.view.gone")}</p>
      </div>
    );
  const s = session.data;
  return (
    <div className="code-session" style={{ "--code-talk": `${talk.size}px` } as CSSProperties}>
      <div className="code-panes">
        <section className="code-pane code-pane--talk">
          <CodeHeader session={s} />
          <SessionTabs session={s} tabs={tabs} />
          {s.worktree.state === "failed" && <FailedBar session={s} />}
          <div className="code-tabview" hidden={tabs.active !== TALK}>
            <ScreenPanelContext.Provider value={screen}>
              <CodeConversation session={s} />
            </ScreenPanelContext.Provider>
          </div>
          {tabs.open.map((key) => (
            <div key={key} className="code-tabview" hidden={tabs.active !== key}>
              {tabs.diffs.get(key) ? (
                <GitDiff session={s} opened={tabs.diffs.get(key) as GitOpened} onOpenFile={tabs.openFile} />
              ) : isTerminal(key) ? (
                <>
                  <TerminalPane
                    orgId={org.id}
                    agentId={s.agentId}
                    machineId={s.machineId}
                    sessionId={s.id}
                    focused={tabs.active === key}
                    keep={terminalKeep(key)}
                  />
                  {/* As under the conversation's composer: what the agent thinks with and its plan's limits, which
                      are the ones its CLI typed here uses. */}
                  <div className="code-termfoot">
                    <AgentStatus session={s} />
                  </div>
                </>
              ) : (
                <CodeFileTab
                  session={s}
                  path={key}
                  active={tabs.active === key}
                  asking={tabs.asking === key}
                  onDirty={(dirty) => tabs.setDirty(key, dirty)}
                  onClose={() => tabs.close(key, true)}
                  onStay={() => tabs.stay()}
                />
              )}
            </div>
          ))}
        </section>
        <CodeGutter label={t("codeSessions.view.resize")} size={talk} />
        <CodePanel
          session={s}
          tab={tab}
          onTab={setTab}
          openFile={tabs.openFile}
          openDiff={tabs.openDiff}
          shownFile={tabs.active}
        />
      </div>
    </div>
  );
}

/** The conversation's tab. No file is named so: a path never starts with a colon. */
const TALK = ":talk";
/** A terminal's tab, by the name its shell is kept under on the computer (":term:<name>"). */
const isTerminal = (key: string) => key.startsWith(":term:");
const terminalKeep = (key: string) => key.slice(":term:".length);
/** A name nobody else's terminal has. */
const newTerminalKey = () => `:term:${crypto.randomUUID()}`;

interface Tabs {
  /** The tabs after the conversation's: a file's path, or a terminal's key. */
  open: string[];
  active: string;
  /** The file whose close waits for an answer (something unsaved in it). */
  asking: string | null;
  dirty: Set<string>;
  show: (key: string) => void;
  openFile: (path: string) => void;
  /** What each diff's tab shows, by its key. */
  diffs: Map<string, GitOpened>;
  openDiff: (opened: GitOpened) => void;
  openTerminal: () => void;
  /** Closes a tab; one with something unsaved asks first, unless `sure`. */
  close: (key: string, sure?: boolean) => void;
  stay: () => void;
  setDirty: (key: string, dirty: boolean) => void;
}

/** A diff's tab: one per change, commit, or the whole branch. */
const diffKey = (o: GitOpened) =>
  o.kind === "change" ? `:diff:${o.change.path}` : o.kind === "commit" ? `:commit:${o.commit.sha}` : ":all";

const tabsKey = (sessionId: string) => `code:tabs:${sessionId}`;

/**
 * The files and terminals a session had open on this browser: a terminal's shell stays on the computer for a while
 * with nobody watching, so its tab comes back to it (a diff is read again from the Git tab).
 */
function keptFiles(sessionId: string): string[] {
  try {
    const kept: unknown = JSON.parse(localStorage.getItem(tabsKey(sessionId)) ?? "[]");
    return Array.isArray(kept)
      ? kept.filter(
          (p): p is string => typeof p === "string" && (!p.startsWith(":") || /^:term:[A-Za-z0-9-]{8,64}$/.test(p)),
        )
      : [];
  } catch {
    return [];
  }
}

/** A session's tabs: which are open and which is on screen; its open files come back with the session. */
function useSessionTabs(sessionId: string): Tabs {
  const [state, setState] = useState(() => ({ sessionId, open: keptFiles(sessionId), active: TALK }));
  const [asking, setAsking] = useState<string | null>(null);
  const [dirty, setDirtySet] = useState<Set<string>>(() => new Set());
  const [diffs, setDiffs] = useState<Map<string, GitOpened>>(() => new Map());
  // Another session on the same screen: its own tabs.
  if (state.sessionId !== sessionId) {
    setState({ sessionId, open: keptFiles(sessionId), active: TALK });
    setAsking(null);
    setDirtySet(new Set());
    setDiffs(new Map());
  }
  useEffect(() => {
    try {
      localStorage.setItem(
        tabsKey(state.sessionId),
        JSON.stringify(state.open.filter((k) => !k.startsWith(":") || isTerminal(k))),
      );
    } catch {}
  }, [state.sessionId, state.open]);
  const show = useCallback((key: string) => setState((s) => ({ ...s, active: key })), []);
  const openFile = useCallback(
    (path: string) =>
      setState((s) => ({ ...s, open: s.open.includes(path) ? s.open : [...s.open, path], active: path })),
    [],
  );
  const openDiff = useCallback((opened: GitOpened) => {
    const key = diffKey(opened);
    // The row as it is now: a change's letter and a commit's words are the tab's.
    setDiffs((was) => new Map(was).set(key, opened));
    setState((s) => ({ ...s, open: s.open.includes(key) ? s.open : [...s.open, key], active: key }));
  }, []);
  const openTerminal = useCallback(
    () =>
      setState((s) => {
        const key = newTerminalKey();
        return { ...s, open: [...s.open, key], active: key };
      }),
    [],
  );
  const setDirty = useCallback(
    (key: string, now: boolean) =>
      setDirtySet((was) => {
        if (was.has(key) === now) return was;
        const next = new Set(was);
        if (now) next.add(key);
        else next.delete(key);
        return next;
      }),
    [],
  );
  const close = useCallback(
    (key: string, sure = false) => {
      if (!sure && dirty.has(key)) {
        setState((s) => ({ ...s, active: key }));
        setAsking(key);
        return;
      }
      setAsking(null);
      setDirty(key, false);
      // Its shell ends with its tab.
      if (isTerminal(key)) endKeptTerminal(terminalKeep(key));
      setState((s) => {
        const at = s.open.indexOf(key);
        const open = s.open.filter((k) => k !== key);
        // The tab on screen closed: the one that takes its place, else the one before it.
        const active = s.active !== key ? s.active : (open[at] ?? open[at - 1] ?? TALK);
        return { ...s, open, active };
      });
    },
    [dirty, setDirty],
  );
  const stay = useCallback(() => setAsking(null), []);
  return {
    open: state.open,
    active: state.active,
    asking,
    dirty,
    diffs,
    show,
    openFile,
    openDiff,
    openTerminal,
    close,
    stay,
    setDirty,
  };
}

/** The session's tabs, under its header: the conversation, the open files and terminals, and "+" for a new one (a terminal). */
function SessionTabs({ session, tabs }: { session: CodeSession; tabs: Tabs }) {
  const { t } = useTranslation();
  let terminals = 0;
  return (
    <div className="code-tabs" role="tablist" aria-label={t("codeSessions.tabs.label")}>
      <button
        type="button"
        role="tab"
        className="code-tabs__tab"
        aria-selected={tabs.active === TALK}
        onClick={() => tabs.show(TALK)}
      >
        <Icon name="message" size={14} />
        <span className="code-tabs__name">{t("codeSessions.tabs.talk")}</span>
      </button>
      {tabs.open.map((key) => {
        const term = isTerminal(key);
        if (term) terminals += 1;
        const diff = tabs.diffs.get(key);
        const name = diff
          ? diff.kind === "change"
            ? diff.change.path.slice(diff.change.path.lastIndexOf("/") + 1)
            : diff.kind === "commit"
              ? diff.commit.short
              : t("codeSessions.gitTab.all", { base: session.baseBranch ?? "main" })
          : term
            ? terminals > 1
              ? t("codeSessions.tabs.terminalN", { n: terminals })
              : t("codeTerminal.label")
            : key.slice(key.lastIndexOf("/") + 1);
        return (
          <span key={key} className="code-tabs__tab" data-selected={tabs.active === key || undefined}>
            <button
              type="button"
              role="tab"
              className="code-tabs__open"
              aria-selected={tabs.active === key}
              title={
                diff?.kind === "change"
                  ? diff.change.path
                  : diff?.kind === "commit"
                    ? diff.commit.subject
                    : term
                      ? undefined
                      : key
              }
              onClick={() => tabs.show(key)}
            >
              <Icon name={diff ? "gitPull" : term ? "codeBlock" : "file"} size={14} />
              <span className="code-tabs__name">{name}</span>
              {tabs.dirty.has(key) && (
                <span className="code-tabs__dot" role="img" aria-label={t("codeSessions.files.unsaved")} />
              )}
            </button>
            <button
              type="button"
              className="code-tabs__x"
              aria-label={t("codeSessions.tabs.close", { name })}
              title={t("codeSessions.tabs.close", { name })}
              onClick={() => tabs.close(key)}
            >
              <Icon name="close" size={14} />
            </button>
          </span>
        );
      })}
      <Menu
        align="start"
        label={t("codeSessions.tabs.add")}
        trigger={
          <Button
            size="sm"
            variant="ghost"
            icon="plus"
            iconOnly
            className="code-tabs__new"
            aria-label={t("codeSessions.tabs.add")}
            title={t("codeSessions.tabs.add")}
          />
        }
      >
        <MenuItem icon="codeBlock" disabled={session.worktree.state !== "ready"} onSelect={tabs.openTerminal}>
          {t("codeTerminal.label")}
        </MenuItem>
      </Menu>
    </div>
  );
}

/** The conversation: the thread at the session's root, as the chat draws a task's conversation (no header of its own). */
function CodeConversation({ session }: { session: CodeSession }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const info = useThreadInfo(org.id, session.rootId);
  const thread = info.data;
  if (!thread) return <ChannelSkeleton thread panel />;
  return (
    <ChannelPage
      channelId={thread.channelId}
      thread={thread}
      fallback={{
        id: thread.channelId,
        name: thread.channelName,
        topic: "",
        visibility: "private",
        isMember: true,
        createdAt: thread.createdAt,
      }}
      chrome={{
        // The page's header is the session's own, above the conversation.
        header: () => null,
        composerLabel: t("codeSessions.view.composer"),
        composerNote: <AgentStatus session={session} />,
        composerSky: <CodeDockSky />,
        ...(session.from ? { top: <CodeOrigin from={session.from} /> } : {}),
        panel: true,
        openThread: false,
        task: true,
      }}
    />
  );
}

/**
 * Where the session came from (a suggestion in a conversation, ADR 0215 §11): one line at its top, with the way back
 * to that message. Only for whoever can open that conversation (the server leaves it out for anyone else).
 */
function CodeOrigin({ from }: { from: CodeSessionOrigin }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  return (
    <EventPill
      className="cn-pill"
      mark={<Icon name="message" size={14} />}
      actions={
        <EventPillMore
          open={false}
          onClick={() =>
            void navigate({
              href: messagePath(org.id, { id: from.messageId, channelId: from.channelId, threadId: from.threadId }),
            })
          }
        >
          {t("codeSessions.from.see")}
        </EventPillMore>
      }
    >
      {from.kind === "dm"
        ? t("codeSessions.from.dm", agentGrammar(from.name))
        : t("codeSessions.from.channel", { name: from.name })}
    </EventPill>
  );
}

/**
 * Under the session's composer, as a coding CLI's status line: what its agent thinks with (changed in place, with the
 * DM's own picker) and how much of its plan's limits it has used.
 */
function AgentStatus({ session }: { session: CodeSession }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const agent = dir.agentById.get(session.agentId);
  if (!agent) return null;
  const plan = usageShown(agent.brain, 0).plan;
  const meter = plan ? planLine(plan.usage, planMeterText(t, i18n.language)) : null;
  return (
    <span className="code-status">
      <ModelPickerButton
        agent={agent}
        size="status"
        after={
          meter?.line ? (
            <span
              className="code-status__limit"
              data-level={planLevel(meter.top?.used ?? 0, meter.state === "limited")}
              title={[meter.title, meter.alert].filter(Boolean).join(" · ")}
            >
              {meter.line}
            </span>
          ) : null
        }
      />
    </span>
  );
}

/**
 * Who is in the session, as faces beside the git button (its agent first, then who opened it): a list where whoever
 * opened it, or an admin, takes someone out, and anyone else leaves. Bringing someone in is an @ in the conversation.
 */
function SessionPeople({ session }: { session: CodeSession }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const actors = useActors();
  const members = useChannelMembers(org.id, session.channelId);
  const [open, setOpen] = useState(false);
  // Whoever an @ brought in joins as the conversation moves: read again when it does, and when the list opens.
  const refetch = members.refetch;
  useEffect(() => {
    if (session.lastAt) void refetch();
  }, [session.lastAt, refetch]);
  const rank = (m: { type: string; id: string }) =>
    m.type === "agent" && m.id === session.agentId ? 0 : m.id === session.createdBy ? 1 : 2;
  const people = [...(members.data ?? [])]
    .filter((m) => m.type === "agent" || m.type === "person")
    .map((m) => ({ type: m.type as "agent" | "person", id: m.id }))
    .sort((a, b) => rank(a) - rank(b));
  const manages = session.createdBy === me.user.id || can(org, "manage_channels");
  const remove = useMutation({
    mutationFn: (m: { type: "agent" | "person"; id: string }) =>
      api.chat.removeMember(org.id, session.channelId, m.type === "agent" ? { agentId: m.id } : { userId: m.id }),
    onSuccess: (_, m) => {
      void qc.invalidateQueries({ queryKey: keys.channelMembers(org.id, session.channelId) });
      void qc.invalidateQueries({ queryKey: keys.roster(org.id, session.channelId) });
      // Out of it myself: the session isn't mine to see any more.
      if (m.type === "person" && m.id === me.user.id) {
        setOpen(false);
        void navigate({ to: "/org/$orgId/code", params: { orgId: org.id } });
      }
    },
    onError: (error) => toast.show(errorText(t, error), "error"),
  });
  if (people.length === 0) return null;
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) void refetch();
      }}
      side="bottom"
      align="end"
      label={t("codeSessions.who.label")}
      className="code-whopop"
      trigger={
        <button type="button" className="code-who" aria-label={t("codeSessions.who.open", { count: people.length })}>
          <AvatarStack>{people.slice(0, 3).map((p) => actors.avatar(p, "sm"))}</AvatarStack>
          {people.length > 3 && <span className="code-who__n tabular">+{people.length - 3}</span>}
        </button>
      }
    >
      <p className="ac-popover__title">{t("codeSessions.who.label")}</p>
      {people.map((p) => {
        const core = rank(p) < 2;
        const self = p.type === "person" && p.id === me.user.id;
        const name = actors.name(p);
        return (
          <div key={`${p.type}:${p.id}`} className="ac-popover__row code-whopop__row">
            {actors.avatar(p, "sm")}
            <span className="code-whopop__name">{name}</span>
            {core ? (
              <span className="ac-popover__row-status">
                {rank(p) === 0 ? t("codeSessions.who.agent") : t("codeSessions.who.opener")}
              </span>
            ) : self ? (
              <Button
                size="sm"
                variant="ghost"
                className="code-whopop__act"
                loading={remove.isPending && remove.variables?.id === p.id}
                onClick={() => remove.mutate(p)}
              >
                {t("codeSessions.who.leave")}
              </Button>
            ) : (
              manages && (
                <Button
                  size="sm"
                  variant="ghost"
                  icon="close"
                  iconOnly
                  className="code-whopop__act"
                  aria-label={t("codeSessions.who.remove", { name })}
                  title={t("codeSessions.who.remove", { name })}
                  loading={remove.isPending && remove.variables?.id === p.id}
                  onClick={() => remove.mutate(p)}
                />
              )
            )}
          </div>
        );
      })}
      <p className="code-whopop__note">{t("codeSessions.who.invite")}</p>
    </Popover>
  );
}

/**
 * The session's header: its name, who is in it and its menu. Its state is the list's and the line over the composer's,
 * its branch the Git tab's: said once each, not here again.
 */
function CodeHeader({ session }: { session: CodeSession }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const toast = useToast();
  const close = useCloseCodeSession(org.id);
  return (
    <header className="code-head">
      <h1 className="code-head__t" title={session.title}>
        {session.title}
      </h1>
      <div className="code-head__r">
        <SessionPeople session={session} />
        <Menu
          align="end"
          label={t("codeSessions.view.more")}
          trigger={
            <Button
              size="sm"
              variant="ghost"
              icon="more"
              iconOnly
              aria-label={t("codeSessions.view.more")}
              title={t("codeSessions.view.more")}
            />
          }
        >
          {session.pr?.url && (
            <MenuItem icon="external" onSelect={() => window.open(session.pr?.url ?? "", "_blank", "noopener")}>
              {t("codeSessions.view.openPr", { number: session.pr.number })}
            </MenuItem>
          )}
          <MenuItem
            icon="archive"
            danger
            description={t("codeSessions.view.closeHint")}
            onSelect={() =>
              close.mutate(session.id, {
                onSuccess: () => void navigate({ to: "/org/$orgId/code", params: { orgId: org.id } }),
                onError: (error) => toast.show(errorText(t, error), "error"),
              })
            }
          >
            {t("codeSessions.view.close")}
          </MenuItem>
        </Menu>
      </div>
    </header>
  );
}

/** The worktree couldn't be made: why, and "Try again". */
function FailedBar({ session }: { session: CodeSession }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const retry = useRetryCodeSession(org.id, session.id);
  return (
    <div className="code-failed" role="alert">
      <Icon name="alert" size={16} />
      <span className="code-failed__t">
        <b>{t("codeSessions.view.failed")}</b>{" "}
        {session.worktree.errorCode === "github_access" ? t("codeSessions.view.githubAccess") : session.worktree.error}
      </span>
      <Button size="sm" loading={retry.isPending} onClick={() => retry.mutate()}>
        {t("codeSessions.view.retry")}
      </Button>
    </div>
  );
}
