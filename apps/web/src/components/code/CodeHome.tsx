import { useCodeSessions, useCodeStart, useCreateCodeSession } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { Button, cx, Icon, Popover, SearchField, Select } from "@agenteschat/ui";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { CodeHomeAgent } from "./CodeHomeAgent";
import { CodeHomeSky } from "./CodeSky";
import { takeCodeKey, useCodeKey } from "./shortcuts";

const LAST_PICK = "code:lastPick";

function readLastPick(orgId: string): { agentId?: string; repo?: string } {
  try {
    return JSON.parse(localStorage.getItem(`${LAST_PICK}:${orgId}`) ?? "{}") as { agentId?: string; repo?: string };
  } catch {
    return {};
  }
}

function saveLastPick(orgId: string, pick: { agentId: string; repo: string }) {
  try {
    localStorage.setItem(`${LAST_PICK}:${orgId}`, JSON.stringify(pick));
  } catch {}
}

/**
 * The Code page's home (ADR 0215): the field in the middle of the agents' sky, the picked agent in cubes over its title
 * (`CodeHomeAgent`). Writing and Enter opens a session with the picked agent in the picked
 * repository (the last ones used come back); the computer is the agent's own, so there is nothing else to choose.
 */
export function CodeHome() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const navigate = useNavigate();
  const start = useCodeStart(org.id);
  const sessions = useCodeSessions(org.id).data ?? [];
  const create = useCreateCodeSession(org.id);
  const agents = start.data?.agents ?? [];
  const [agentId, setAgentId] = useState<string | null>(null);
  const [repo, setRepo] = useState("");
  const [text, setText] = useState("");
  // The last pick, else the first agent and its first repository.
  useEffect(() => {
    if (agentId || agents.length === 0) return;
    const last = readLastPick(org.id);
    const agent = agents.find((a) => a.agentId === last.agentId) ?? agents[0];
    if (!agent) return;
    setAgentId(agent.agentId);
    setRepo(last.repo ?? agent.repos[0] ?? "");
  }, [agents, agentId, org.id]);
  const picked = agents.find((a) => a.agentId === agentId) ?? null;
  // The projects only on this agent's computer that my sessions used: offered beside its repositories.
  const locals = useMemo(
    () => [...new Set(sessions.filter((s) => s.local && s.agentId === agentId).map((s) => s.repo))],
    [sessions, agentId],
  );
  const home = useRef<HTMLDivElement>(null);
  // ⌥⌘N: the caret in the field, here already or brought here by the key.
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (takeCodeKey("newSession")) field.current?.focus();
  }, []);
  useCodeKey("newSession", () => {
    takeCodeKey("newSession");
    field.current?.focus();
  });
  const pickedAgent = agentId ? dir.agentById.get(agentId) : undefined;
  const pickAgent = (id: string) => {
    setAgentId(id);
    const agent = agents.find((a) => a.agentId === id);
    if (agent && !repo.trim()) setRepo(agent.repos[0] ?? "");
  };
  const ready = Boolean(picked && repo.trim() && text.trim()) && !create.isPending;
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!ready || !picked) return;
    const input = { agentId: picked.agentId, repo: repo.trim(), text: text.trim() };
    create.mutate(input, {
      onSuccess: (session) => {
        saveLastPick(org.id, { agentId: input.agentId, repo: input.repo });
        setText("");
        void navigate({ to: "/org/$orgId/code/$sessionId", params: { orgId: org.id, sessionId: session.id } });
      },
    });
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };
  // Its words come in once the home knows where they stand: with an agent over them, or with none to pick.
  const placed = start.isError || (start.isSuccess && (agents.length === 0 || Boolean(pickedAgent)));
  return (
    <div className="code-home" ref={home}>
      <div className="code-stage" aria-hidden="true">
        <CodeHomeSky />
      </div>
      <form className={cx("code-mid", pickedAgent && "code-mid--agent", placed && "is-in")} onSubmit={submit}>
        {pickedAgent && <CodeHomeAgent agent={pickedAgent} name={pickedAgent.name} area={home} />}
        <div className="code-mid__head">
          <span className="code-title">
            <span className="code-block code-block--add">
              <span className="code-block__sig" aria-hidden="true">
                +
              </span>
              <h2 className="code-mid__t code-mid__t--brand">{t("codeSessions.home.mode")}</h2>
            </span>
            {/* What the page was before: knocked off by the title as the home opens. Decoration only. */}
            <span className="code-block code-block--del" aria-hidden="true">
              <span className="code-block__sig">−</span>
              <span className="code-mid__t code-mid__t--brand">{t("codeSessions.home.was")}</span>
            </span>
          </span>
          <span className="code-mid__beta">{t("codeSessions.home.beta")}</span>
        </div>
        {agents.length === 0 && start.isSuccess ? (
          <p className="code-mid__none">{t("codeSessions.home.noAgents")}</p>
        ) : (
          <div className="ac-composer code-start">
            <textarea
              ref={field}
              className="code-start__text"
              rows={2}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKey}
              placeholder={t("codeSessions.home.placeholder")}
              aria-label={t("codeSessions.home.label")}
            />
            <div className="code-start__opts">
              <Select
                size="sm"
                className="code-select"
                aria-label={t("codeSessions.home.agent")}
                value={agentId ?? undefined}
                onValueChange={pickAgent}
                options={agents.map((a) => ({
                  value: a.agentId,
                  label: dir.agentById.get(a.agentId)?.name ?? a.agentId,
                  leading: (
                    <AgentAvatar agentId={a.agentId} name={dir.agentById.get(a.agentId)?.name ?? ""} size="sm" />
                  ),
                }))}
              />
              <RepoPicker
                repo={repo}
                onRepo={setRepo}
                repos={picked?.repos ?? []}
                locals={locals}
                any={picked?.any ?? false}
              />
              <span className="code-start__hint">{t("codeSessions.home.hint")}</span>
              <Button type="submit" size="sm" variant="primary" disabled={!ready} loading={create.isPending}>
                {t("codeSessions.home.start")}
              </Button>
            </div>
          </div>
        )}
        {create.error && (
          <p className="code-mid__error" role="alert">
            {errorText(t, create.error)}
          </p>
        )}
      </form>
    </div>
  );
}

/** The shapes the server takes (ADR 0215 §1): a GitHub repository, or a local project's name (no owner). */
const GITHUB_REPO = /^[\w.-]+\/[\w.-]+$/;
const LOCAL_NAME = /^(?!\.)[A-Za-z0-9._-]{1,64}$/;

/**
 * Where the session works, drawn as a select: one of the agent's GitHub repositories, or a project only on its
 * computer (a name with no owner; a new name makes one). The wiki's folder picker's shape: a search over the choices,
 * Enter takes the first, and a name typed that isn't listed is offered as a new one.
 */
function RepoPicker({
  repo,
  onRepo,
  repos,
  locals,
  any,
}: {
  repo: string;
  onRepo: (repo: string) => void;
  /** The agent's repositories; `any`: its list allows more than it names. */
  repos: string[];
  locals: string[];
  any: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const query = q.trim().replace(/\/+$/, "");
  const all = [
    ...repos.map((value) => ({ value, local: false })),
    ...locals.filter((l) => !repos.includes(l)).map((value) => ({ value, local: true })),
  ];
  const shown = all.filter((r) => !query || r.value.toLowerCase().includes(query.toLowerCase()));
  const listed = all.some((r) => r.value.toLowerCase() === query.toLowerCase());
  const creates =
    !query || listed ? null : LOCAL_NAME.test(query) ? "local" : any && GITHUB_REPO.test(query) ? "repo" : null;
  const pick = (value: string) => {
    onRepo(value);
    setOpen(false);
    setQ("");
  };
  const local = Boolean(repo) && !repo.includes("/");
  const shownValue = repo || t("codeSessions.home.repoPlaceholder");
  return (
    <div className="ac-select ac-select--sm code-select">
      <Popover
        label={t("codeSessions.home.repo")}
        side="bottom"
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) setQ("");
        }}
        className="code-repopop"
        trigger={
          <button
            type="button"
            className="ac-select__trigger"
            aria-label={`${t("codeSessions.home.repo")}: ${shownValue}`}
            data-placeholder={repo ? undefined : ""}
          >
            <span className="ac-select__value">
              <span>
                <span className="ac-select__lead" aria-hidden="true">
                  <Icon name={local ? "computer" : "repo"} size={16} />
                </span>
                <span className="ac-select__text">{shownValue}</span>
              </span>
            </span>
            <svg className="ac-select__chev" viewBox="0 0 20 20" aria-hidden="true">
              <path d="m6 8 4 4 4-4" />
            </svg>
          </button>
        }
      >
        <SearchField
          size="sm"
          aria-label={t("codeSessions.home.repoSearch")}
          placeholder={t("codeSessions.home.repoSearch")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onClear={() => setQ("")}
          clearLabel={t("filters.clearSearch")}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
            e.preventDefault();
            const first = shown[0]?.value ?? (creates ? query : null);
            if (first) pick(first);
          }}
        />
        {(shown.length > 0 || creates) && (
          <div className="code-repopop__list" role="listbox" aria-label={t("codeSessions.home.repo")}>
            {shown.map((r) => (
              <button
                key={r.value}
                type="button"
                role="option"
                aria-selected={r.value === repo}
                className="code-repopop__row"
                onClick={() => pick(r.value)}
              >
                <Icon name={r.local ? "computer" : "repo"} size={16} />
                <span className="code-repopop__name">{r.value}</span>
                {r.local && <span className="code-repopop__where">{t("codeSessions.list.local")}</span>}
              </button>
            ))}
            {creates && (
              <button
                type="button"
                role="option"
                aria-selected={false}
                className="code-repopop__row"
                onClick={() => pick(query)}
              >
                <Icon name="plus" size={16} />
                <span className="code-repopop__name">
                  {creates === "local"
                    ? t("codeSessions.home.newLocal", { name: query })
                    : t("codeSessions.home.useRepo", { repo: query })}
                </span>
              </button>
            )}
          </div>
        )}
        <p className="code-repopop__note">{t("codeSessions.home.repoNote")}</p>
      </Popover>
    </div>
  );
}
