import type { ActivityEntry } from "@agenteschat/adapters/runner-control";
import { Avatar, Button, Icon, PixelSpinner, Refreshing, Segmented } from "@agenteschat/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useHost, useSnapshot, useStore } from "../../app";
import {
  type ActivityCursor,
  groupByDay,
  type HomeEntry,
  type HomePage,
  hasMore,
  homesToFetch,
  mergePages,
  saidText,
  startCursor,
} from "../../control/activity";
import { orgName, pairedHomes } from "../../control/store";
import { agentOf, useAppInfo } from "../../hooks";
import { desktopStrings, systemLocale } from "../../i18n";
import { mountReportPanel } from "../../report/panel";
import { computerReport } from "../../report/report";
import { AgentFace, OrgTile } from "../../ui/bits";
import { PrefHead } from "../../ui/settings";
import { useToast } from "../../ui/Toast";
import { clock, dayLabel } from "../../ui/time";

const PAGE = 40;

export function Activity() {
  const { t, i18n } = useTranslation();
  const store = useStore();
  const snap = useSnapshot();
  const toast = useToast();
  const homes = pairedHomes(snap);
  const homeKey = homes.map((h) => h.homeId).join(",");
  const [filter, setFilter] = useState<string>("all");
  const [entries, setEntries] = useState<HomeEntry[]>([]);
  const [cursor, setCursor] = useState<ActivityCursor>({});
  const [loading, setLoading] = useState(false);
  // Another organization's first page: the lines shown stay, dimmed, until it comes.
  const [replacing, setReplacing] = useState(false);
  const generation = useRef(0);

  const scope = filter === "all" ? homes.map((h) => h.homeId) : homes.some((h) => h.homeId === filter) ? [filter] : [];
  const scopeKey = scope.join(",");

  const loadPage = useCallback(
    async (from: ActivityCursor, append: boolean) => {
      const gen = ++generation.current;
      setLoading(true);
      setReplacing(!append);
      const ids = homesToFetch(from);
      const pages: HomePage[] = await Promise.all(
        ids.map(async (homeId) => {
          try {
            const res = await store.request(homeId, { type: "activity", before: from[homeId]?.before, limit: PAGE });
            return { homeId, entries: res.entries, more: res.more };
          } catch {
            return { homeId, entries: [], more: false };
          }
        }),
      );
      if (gen !== generation.current) return;
      const merged = mergePages(pages, from, PAGE);
      setEntries((prev) => (append ? [...prev, ...merged.entries] : merged.entries));
      setCursor(merged.cursor);
      setLoading(false);
      setReplacing(false);
    },
    [store],
  );

  // First page whenever the filter or the organizations change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the scope's ids
  useEffect(() => {
    void loadPage(startCursor(scope), false);
  }, [scopeKey, homeKey, loadPage]);

  // New lines arrive live.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the scope's ids
  useEffect(
    () =>
      store.onEvent((homeId, event) => {
        if (event.kind !== "activity") return;
        if (!scope.includes(homeId)) return;
        setEntries((prev) => [{ ...event.entry, homeId }, ...prev]);
      }),
    [store, scopeKey],
  );

  const copyDiagnostics = async () => {
    const texts = await Promise.all(
      scope.map(async (homeId) => {
        const home = store.home(homeId);
        const name = home ? orgName(home) : homeId;
        try {
          const res = await store.request(homeId, { type: "diagnostics" });
          return `# ${name}\n${res.text}`;
        } catch {
          return `# ${name}\n(unavailable)`;
        }
      }),
    );
    try {
      await navigator.clipboard.writeText(texts.join("\n\n"));
      toast(t("desktop.prefs.activity.diagCopied"), "copy");
    } catch {
      toast(t("desktop.common.error"), "alert");
    }
  };

  const [reporting, setReporting] = useState(false);

  const options = [
    { value: "all", label: t("desktop.prefs.activity.all") },
    ...homes.map((h) => ({
      value: h.homeId,
      label: orgName(h),
      mark: <OrgTile logo={h.logo} size="sm" />,
    })),
  ];
  const groups = groupByDay(entries);
  const kept = replacing && entries.length > 0;

  return (
    <>
      <PrefHead
        title={t("desktop.prefs.activity.title")}
        lead={t("desktop.prefs.activity.lead")}
        action={
          <span className="ac-acts">
            <Button size="sm" icon="copy" onClick={() => void copyDiagnostics()} disabled={scope.length === 0}>
              {t("desktop.prefs.activity.copyDiag")}
            </Button>
            <Button size="sm" variant="link" onClick={() => setReporting(true)} disabled={scope.length === 0}>
              {t("desktop.report.button")}
            </Button>
          </span>
        }
      />
      {homes.length > 1 && (
        <div className="dk-orgpick">
          <Segmented
            size="sm"
            label={t("desktop.prefs.activity.org")}
            value={filter}
            onValueChange={setFilter}
            options={options}
          />
        </div>
      )}
      <div className="dk-card" data-padded>
        {entries.length === 0 && !loading && <p className="dk-help">{t("desktop.prefs.activity.empty")}</p>}
        <Refreshing busy={kept} label={t("common.loading")}>
          <div className="dk-act">
            {groups.map((g) => (
              <div key={g.key}>
                <div className="dk-act__day">
                  {g.kind === "today"
                    ? t("desktop.prefs.activity.today")
                    : g.kind === "yesterday"
                      ? t("desktop.prefs.activity.yesterday")
                      : dayLabel(g.day, i18n.language)}
                </div>
                {g.entries.map((e) => (
                  <EntryRow
                    key={`${e.homeId}-${e.at}-${e.summary}`}
                    entry={e}
                    showOrg={filter === "all" && homes.length > 1}
                  />
                ))}
              </div>
            ))}
          </div>
        </Refreshing>
        {((loading && !kept) || hasMore(cursor)) && (
          <div className="dk-act__more">
            {loading && !kept ? (
              <PixelSpinner size={16} />
            ) : (
              // The cursor is the kept organization's: another page of it would land under the new one's lines.
              <Button size="sm" variant="ghost" disabled={kept} onClick={() => void loadPage(cursor, true)}>
                {t("desktop.prefs.activity.showMore")}
              </Button>
            )}
          </div>
        )}
      </div>
      {reporting && scope[0] && <ComputerReport homeId={scope[0]} onClose={() => setReporting(false)} />}
    </>
  );
}

/**
 * Send a report for one computer, from here: the only way when it can't reach its server. The runner gives its facts
 * and its log, scrubbed; an app too old for that says so.
 */
function ComputerReport({ homeId, onClose }: { homeId: string; onClose: () => void }) {
  const store = useStore();
  const app = useHost();
  const info = useAppInfo();
  const { i18n } = useTranslation();
  const host = useRef<HTMLDivElement>(null);
  // Live activity redraws the page: the panel stays as it is (with what was typed) until it closes.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const el = host.current;
    if (!el || !info) return;
    const words = desktopStrings(systemLocale()).report;
    let unmount = () => {};
    let live = true;
    // This computer's system and size come too; an app whose Rust is older than its page goes without them.
    Promise.all([store.request(homeId, { type: "report" }), app.reportFacts().catch(() => null)]).then(
      ([parts, about]) => {
        if (!live) return;
        unmount = mountReportPanel(el, {
          words,
          lead: words.computerLead,
          report: computerReport(parts, info, about, [], i18n.language),
          onClose: () => close.current(),
        });
      },
      () => {
        if (live)
          unmount = mountReportPanel(el, {
            words,
            lead: words.computerLead,
            report: null,
            notes: [words.oldApp],
            onClose: () => close.current(),
          });
      },
    );
    return () => {
      live = false;
      unmount();
    };
  }, [store, app, homeId, info, i18n.language]);
  return <div className="dk-report-scrim" ref={host} />;
}

function EntryRow({ entry, showOrg }: { entry: HomeEntry; showOrg: boolean }) {
  const { t, i18n } = useTranslation();
  const store = useStore();
  const home = store.home(entry.homeId);
  const agent = entry.agent ? agentOf(home, entry.agent) : null;
  const said = saidText(t, entry, (iso) => clock(iso, i18n.language, new Date()));
  return (
    <div className="dk-ev">
      <span className="dk-ev__tm">{clock(entry.at, i18n.language, new Date(entry.at))}</span>
      <span className="dk-ev__av">
        {agent ? <AgentFace agent={agent} size="xs" /> : <Avatar name={t("desktop.prefs.activity.you")} size="xs" />}
      </span>
      <span className="dk-ev__tx">
        {agent && <b>{agent.name} </b>}
        {said}
        {entry.where && <span className="dk-faint"> · {entry.where}</span>}
        {showOrg && home && <small>{orgName(home)}</small>}
        {entry.command && entry.command !== entry.summary && entry.command !== said && (
          <small>
            <code className="dk-code-inline">{entry.command}</code>
          </small>
        )}
      </span>
      <span className="dk-ev__st">
        <ResultMark result={entry.result} />
      </span>
    </div>
  );
}

function ResultMark({ result }: { result: ActivityEntry["result"] }) {
  const { t } = useTranslation();
  if (result === "running") return <PixelSpinner size={14} label={t("desktop.prefs.activity.resultRunning")} />;
  if (result === "ok") return <Icon name="check" size={14} label={t("desktop.prefs.activity.resultOk")} />;
  if (result === "failed")
    return <Icon name="close" size={14} className="dk-danger-text" label={t("desktop.prefs.activity.resultFailed")} />;
  if (result === "refused")
    return <Icon name="block" size={14} className="dk-faint" label={t("desktop.prefs.activity.resultRefused")} />;
  return null;
}
