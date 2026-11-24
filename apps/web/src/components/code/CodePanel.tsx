import type { CodeSession } from "@agenteschat/client";
import { Button, TabPanel, Tabs } from "@agenteschat/ui";
import { type CSSProperties, useCallback, useLayoutEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { FilesPane } from "./CodeFiles";
import { type GitOpened, GitPane } from "./CodeGit";
import { CodeGutter, useStoredSize } from "./CodeGutter";
import { CodeScreen } from "./CodeScreen";
import { CodeHorizon } from "./CodeSky";
import { useCodeKey, withKey } from "./shortcuts";
import { TerminalPane } from "./TerminalPane";

export type CodeTab = "git" | "files" | "screen";
const TAB_KEY = "code:tab";
const TERMINAL_KEY = "code:terminal";

function readTab(): CodeTab {
  try {
    const kept = localStorage.getItem(TAB_KEY);
    return kept === "screen" || kept === "files" ? kept : "git";
  } catch {
    return "git";
  }
}

/** The panel's tab, kept on this device: what the person looked at last, or the screen the agent turned it to. */
export function useCodeTab() {
  const [tab, setTabState] = useState<CodeTab>(readTab);
  const setTab = useCallback((next: CodeTab) => {
    setTabState(next);
    try {
      localStorage.setItem(TAB_KEY, next);
    } catch {}
  }, []);
  return [tab, setTab] as const;
}

/** The panel's width, read as it changes (a drag of its gutter, the window): its tab row gives way under it. */
function useWidth(el: HTMLElement | null) {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setWidth(el.getBoundingClientRect().width);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [el]);
  return width;
}

/** Under these widths the tab row keeps its three tabs whole: the terminal's switch drops its word, then the size. */
const ROW_NARROW = 440;
const ROW_TIGHT = 350;

function readTerminal() {
  try {
    return localStorage.getItem(TERMINAL_KEY) === "open";
  } catch {
    return false;
  }
}

/**
 * The session's side panel (ADR 0215): its git (what changed, the commits, each diff), its files, or the agent's
 * computer or a phone (Screen), and under any of them, when opened, a shell in the worktree (Terminal) whose height
 * drags. The agents' sky rises behind the git tab from its foot, with the session's agent standing on it, and fills
 * the screen's stage.
 */
export function CodePanel({
  session,
  tab,
  onTab,
  openFile,
  openDiff,
  shownFile,
}: {
  session: CodeSession;
  tab: CodeTab;
  onTab: (tab: CodeTab) => void;
  /** Opens a file in a tab beside the conversation. */
  openFile: (path: string) => void;
  /** Opens a diff (a change, a commit, the whole branch) in a tab beside the conversation. */
  openDiff: (opened: GitOpened) => void;
  /** The tab on screen there: a file's path marks its row in the tree. */
  shownFile: string;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const agent = dir.agentById.get(session.agentId) ?? null;
  const [terminal, setTerminalState] = useState(readTerminal);
  // The shell lives on while the drawer is closed: once opened, it stays mounted, only hidden.
  const [shellOpened, setShellOpened] = useState(terminal);
  const height = useStoredSize("code:terminalHeight", 120, 900, 280);
  const setTerminal = (open: boolean) => {
    setTerminalState(open);
    if (open) setShellOpened(true);
    try {
      localStorage.setItem(TERMINAL_KEY, open ? "open" : "closed");
    } catch {}
  };
  useCodeKey("terminal", () => setTerminal(!terminal));
  const [panel, setPanel] = useState<HTMLElement | null>(null);
  const width = useWidth(panel);
  const narrow = width > 0 && width < ROW_NARROW;
  const stat =
    session.stat.at && !(width > 0 && width < ROW_TIGHT) ? `+${session.stat.added} −${session.stat.removed}` : null;
  return (
    <section
      ref={setPanel}
      className="code-pane code-pane--side"
      style={{ "--code-term": `${height.size}px` } as CSSProperties}
    >
      <Tabs
        value={tab}
        onValueChange={onTab}
        label={t("codeSessions.panel.label")}
        variant="segmented"
        items={[
          {
            value: "git",
            label: (
              <>
                {t("codeSessions.gitTab.label")}
                {stat && <span className="code-ptab__n tabular">{stat}</span>}
              </>
            ),
          },
          { value: "files", label: t("codeSessions.files.label") },
          { value: "screen", label: t("codeSessions.panel.screen") },
        ]}
      >
        <TabPanel value="git">
          <GitPane session={session} onOpen={openDiff} />
          {/* The sky rises from the panel's foot; with the terminal open, the foot is the terminal's. */}
          {agent && !terminal && (
            <div className="code-hz" aria-hidden="true">
              <CodeHorizon />
            </div>
          )}
          {agent && !terminal && (
            <div className="code-hz__row">
              <AgentAvatar
                agentId={agent.id}
                name={agent.name}
                size="lg"
                framed={false}
                state={session.work === "working" ? "writing" : undefined}
              />
              <span className="code-hz__w">
                <b>{agent.name}</b> {t(`codeSessions.panel.agent_${session.work}`)}
              </span>
            </div>
          )}
        </TabPanel>
        <TabPanel value="files">
          <FilesPane session={session} onOpen={openFile} shown={shownFile} />
        </TabPanel>
        <TabPanel value="screen">{agent && <CodeScreen agent={agent} />}</TabPanel>
      </Tabs>
      <Button
        size="sm"
        variant="ghost"
        icon="codeBlock"
        iconOnly={narrow}
        className="code-ptoggle"
        aria-pressed={terminal}
        aria-label={narrow ? t("codeSessions.panel.terminal") : undefined}
        title={withKey(t("codeSessions.panel.terminal"), "terminal")}
        onClick={() => setTerminal(!terminal)}
      >
        {t("codeSessions.panel.terminal")}
      </Button>
      {terminal && <CodeGutter axis="y" label={t("codeSessions.panel.terminalHeight")} size={height} />}
      {shellOpened && (
        <div className="code-drawer" hidden={!terminal}>
          {session.worktree.state === "ready" ? (
            <TerminalPane
              orgId={org.id}
              agentId={session.agentId}
              machineId={session.machineId}
              sessionId={session.id}
              keep={`drawer-${session.id}`}
            />
          ) : (
            <p className="code-empty">{t("codeSessions.panel.notReady")}</p>
          )}
        </div>
      )}
    </section>
  );
}
