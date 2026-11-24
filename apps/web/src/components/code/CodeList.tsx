import { type CodeSession, useCodeSessions } from "@agenteschat/client";
import { subagentsNow } from "@agenteschat/client/lib/cli-tools";
import { subagentsTail } from "@agenteschat/client/lib/work";
import { cx, Icon } from "@agenteschat/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar, AgentSpinner } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useStreams } from "@/realtime/context";
import { useCodeKey, withKey } from "./shortcuts";

/** The quiet mark of a session that waits on me (the requests' own mark). */
export const WaitMark = () => (
  <span className="rq-wait" aria-hidden="true">
    <span />
  </span>
);

/** One session's state in words, in its color: what the list, the header and the home say. */
/**
 * Its subagents and workflows at work now, from its conversation's live runs (ADR 0215): "3 subagentes", "workflow 2
 * de 3". Read as one string, so the list redraws only when the words change.
 */
function useSubagentsLine(channelId: string): string | null {
  const { t } = useTranslation();
  return useStreams((s) => {
    for (const run of Object.values(s.runs)) {
      if (run.channelId !== channelId) continue;
      const busy = subagentsNow(run.work);
      if (busy) return subagentsTail(t, busy);
    }
    return null;
  });
}

export function SessionState({ session }: { session: CodeSession }) {
  const { t } = useTranslation();
  const work = session.work;
  const subagents = useSubagentsLine(session.channelId);
  if (work === "waiting")
    return (
      <span className="code-st code-st--wait">
        <WaitMark />
        <span>{t("codeSessions.state.waiting")}</span>
      </span>
    );
  if (work === "working" || work === "preparing")
    return (
      <span className="code-st code-st--work">
        <AgentSpinner agentId={session.agentId} size={14} />
        <span>
          {t(work === "working" ? "codeSessions.state.working" : "codeSessions.state.preparing")}
          {work === "working" && subagents ? ` · ${subagents}` : ""}
        </span>
      </span>
    );
  if (work === "failed")
    return (
      <span className="code-st code-st--fail">
        <Icon name="alert" size={14} />
        <span>{t("codeSessions.state.failed")}</span>
      </span>
    );
  return (
    <span className="code-st code-st--ok">
      <Icon name="check" size={14} />
      <span>
        {session.pr ? t("codeSessions.state.pr", { number: session.pr.number }) : t("codeSessions.state.idle")}
      </span>
    </span>
  );
}

/** The change's size against the base, as git counts it ("+52 −10"); nothing until it was read once. */
export function StatCount({ session }: { session: CodeSession }) {
  if (!session.stat.at || session.stat.added + session.stat.removed === 0) return null;
  return (
    <span className="code-n tabular">
      <span className="code-add">+{session.stat.added}</span> <span className="code-del">−{session.stat.removed}</span>
    </span>
  );
}

/**
 * The page's list (ADR 0215): the sessions I take part in, grouped by repository, each with its agent, name, state in
 * words and the change's size. Who waits on me reads in the waiting color; the open one is marked.
 */
export function CodeList({ activeId }: { activeId: string | null }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const list = useCodeSessions(org.id);
  const groups = useMemo(() => {
    const by = new Map<string, CodeSession[]>();
    for (const s of list.data ?? []) by.set(s.repo, [...(by.get(s.repo) ?? []), s]);
    return [...by.entries()];
  }, [list.data]);
  // ⌥⌘↑ and ⌥⌘↓: the session above or below the open one, as the list shows them (the home is above the first).
  const navigate = useNavigate();
  const go = (step: -1 | 1) => {
    const order = groups.flatMap(([, sessions]) => sessions.map((s) => s.id));
    const at = activeId === null ? -1 : order.indexOf(activeId);
    const next = order[at + step];
    if (step === -1 && at === 0) void navigate({ to: "/org/$orgId/code", params: { orgId: org.id } });
    else if (next) void navigate({ to: "/org/$orgId/code/$sessionId", params: { orgId: org.id, sessionId: next } });
  };
  useCodeKey("prevSession", () => go(-1));
  useCodeKey("nextSession", () => go(1));
  return (
    <aside className="code-list" aria-label={t("codeSessions.list.label")}>
      <div className="code-list__h">
        <span className="code-list__t">{t("codeSessions.title")}</span>
        <Link
          to="/org/$orgId/code"
          params={{ orgId: org.id }}
          className="ac-btn ac-btn--ghost ac-btn--sm ac-btn--icon code-list__new"
          aria-label={t("codeSessions.list.new")}
          title={withKey(t("codeSessions.list.new"), "newSession")}
        >
          <Icon name="plus" size={16} />
        </Link>
      </div>
      <div className="code-list__scroll">
        <Link
          to="/org/$orgId/code"
          params={{ orgId: org.id }}
          className={cx("code-row code-row--new", activeId === null && "is-on")}
        >
          <span className="code-row__face code-row__plus">
            <Icon name="plus" size={14} />
          </span>
          <span className="code-row__main">
            <span className="code-row__title">{t("codeSessions.list.newRow")}</span>
          </span>
        </Link>
        {groups.map(([repo, sessions]) => (
          <div key={repo} className="code-group">
            <div className="code-group__h">
              {repo}
              {sessions[0]?.local && <span className="code-group__where"> · {t("codeSessions.list.local")}</span>}
            </div>
            {sessions.map((s) => {
              const agent = dir.agentById.get(s.agentId);
              return (
                <Link
                  key={s.id}
                  to="/org/$orgId/code/$sessionId"
                  params={{ orgId: org.id, sessionId: s.id }}
                  className={cx("code-row", s.id === activeId && "is-on", s.work === "waiting" && "is-waiting")}
                >
                  <span className="code-row__face">
                    <AgentAvatar
                      agentId={s.agentId}
                      name={agent?.name ?? ""}
                      size="xs"
                      state={s.work === "working" ? "writing" : undefined}
                    />
                  </span>
                  <span className="code-row__main">
                    <span className="code-row__title">{s.title}</span>
                    <SessionState session={s} />
                  </span>
                  <StatCount session={s} />
                </Link>
              );
            })}
          </div>
        ))}
        {list.data && list.data.length === 0 && <p className="code-list__empty">{t("codeSessions.list.empty")}</p>}
      </div>
    </aside>
  );
}
