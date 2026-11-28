import type {
  BundleTodo,
  ImportItemKind,
  ImportItemResult,
  ImportSkipReason,
  MigrationBundle,
} from "@agenteschat/client";
import { keys, useAgents, useMe } from "@agenteschat/client";
import { formatBytes, MAX_UPLOAD_MB } from "@agenteschat/client/lib/files";
import { joinNames } from "@agenteschat/client/lib/format";
import { frontmatter, PASTED } from "@agenteschat/client/lib/import/shared";
import { can, makesAgents } from "@agenteschat/client/lib/permissions";
import {
  Alert,
  Button,
  Card,
  CardHeader,
  Checkbox,
  Chip,
  type ChipTone,
  CountChip,
  driveFolder,
  HintLine,
  Icon,
  type IconName,
  isIdHandle,
  normalizeAppearance,
  OptionCard,
  Switch,
} from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { type ComponentProps, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { failedOffline } from "@/chat/offline";
import { AgentAvatar } from "@/components/AgentAvatar";
import { HelpLink } from "@/components/HelpLink";
import { type ImportFocus, ImportSheet, type ImportSheetKind, useFocusOn } from "@/components/ImportSheet";
import { arrivals } from "@/components/lodi-cursor/arrivals";
import { useOrg } from "@/components/org-context";
import { holdReload } from "@/lib/app-version";
import {
  type AgentFile,
  type ImportFile,
  type ImportWorkflow,
  type PickedFile,
  parsePackage,
  readImportFiles,
  type SayKey,
  type SayValues,
} from "@/lib/import";
import {
  agentsArrived,
  agentsSince,
  applyInChunks,
  blockedItems,
  bundleOrigin,
  CARD_MARK,
  cardName,
  choosable,
  copyAgentFiles,
  droppedFiles,
  type FileLeft,
  type FilesCopy,
  filesNotes,
  githubRoot,
  IMPORT_CARDS,
  IMPORT_KINDS,
  type ImportCard,
  type ImportFailure,
  type ImportMethod,
  importApplyErrorText,
  isGithubLink,
  itemId,
  kindsLine,
  MANY_FILES,
  madeByImport,
  NOT_GITHUB,
  picksOf,
  todoLine,
} from "@/lib/import-flow";
import { hasFiles } from "@/lib/obsidian";
import { useTheme } from "@/lib/theme";
import { useToast } from "@/lib/toast";
import { saveExport } from "@/lib/workspace-export";
import "./import-flow.css";

const KIND_ICON: Record<ImportItemKind, IconName> = {
  agent: "agent",
  skill: "bulb",
  channel: "channel",
  routine: "routines",
  note: "book",
};
const TODO_ICON: Record<BundleTodo["kind"], IconName> = {
  connection: "plug",
  app: "plug",
  secret: "key",
  model: "settings",
  file: "file",
  path: "file",
  webhook: "link",
};
/** Why the agents' files stay behind, in the order they're listed. */
const FILE_LEFT: Record<FileLeft, IconName> = {
  secret: "lock",
  junk: "settings",
  too_large: "block",
  unreadable: "alert",
  exists: "check",
  storage_full: "database",
  daily_full: "clock",
  failed: "alert",
};
/** Names a reason shows before "e mais N". */
const NAMES_SHOWN = 4;
/** The fields the server may cut (`trimmed`), in the person's words. */
const FIELDS = ["name", "role", "instructions", "handle", "topic", "prompt", "title", "content", "appearance"] as const;
/** Rows a group shows before "Mostrar mais". */
const SHOWN = 6;
/** How often the MCP step reads the agents again while it waits. */
export const WATCH_POLL_MS = 5_000;

type ReadInput = { files: PickedFile[] | Promise<PickedFile[]> } | { url: string } | { text: string };

/**
 * Bringing a workspace from another app (ADR 0055), the same in onboarding
 * and in Configurações → Importar e exportar: read what was dropped, picked,
 * linked or pasted into a bundle; plan it on the server (dry run); the person
 * picks; apply. Nothing is written before `apply`.
 */
export function useImportFlow(orgId: string | null) {
  const api = useApi();
  const qc = useQueryClient();
  const { t } = useTranslation();
  const toast = useToast();
  const [card, pickCard] = useState<ImportCard | null>(null);
  const [busy, setBusy] = useState<"reading" | "planning" | null>(null);
  const [failure, setFailure] = useState<ImportFailure | null>(null);
  const [planned, setPlanned] = useState<{
    bundle: MigrationBundle;
    items: ImportItemResult[];
    /** Files a GitHub link has past the reader's limits: not read. */
    skipped: string[];
    /** The agents' own files, for their folders in the Drive. */
    files: AgentFile[];
    /** System files the reader dropped (dependencies, caches, `.git`). */
    junk: number;
    /** What each workflow became, with its steps. */
    workflows: ImportWorkflow[];
    /** The agents a routine hands its answer to, by the routine's key. */
    passes: Record<string, string[]>;
  } | null>(null);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [report, setReport] = useState<ImportItemResult[] | null>(null);
  // "Copiar os arquivos para o Drive", on until turned off; then the copy, which runs after the import.
  const [copyFiles, setCopyFiles] = useState(true);
  const [copy, setCopy] = useState<{
    done: number;
    total: number;
    running: boolean;
    result: FilesCopy | null;
  } | null>(null);
  // Something read, or the flow cleared, since it opened: what it shows is this page's doing.
  const [touched, setTouched] = useState(false);
  const done = useRef(new Map<string, ImportItemResult>());
  const run = useRef(0);
  const last = useRef<ReadInput | null>(null);
  const focus = useRef<ImportFocus>(null);
  const agentIds = useRef(new Map<string, string>());
  // Closing the page stops the copy (the browser sends each file): ask first.
  const copying = !!copy?.running;
  useEffect(() => {
    if (!copying) return;
    const ask = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", ask);
    const release = holdReload();
    return () => {
      window.removeEventListener("beforeunload", ask);
      release();
    };
  }, [copying]);
  // Agents whose files were sent to the Drive, so a later apply (a retry) sends only those it brought.
  const sent = useRef(new Set<string>());
  // Connect with MCP or Prompt only, per source, once the person picks one (until then, the source's default).
  const [methods, setMethods] = useState<Partial<Record<ImportCard, ImportMethod>>>({});
  // The workspace's agents as read after a source's MCP steps first showed: only the ones made since then arrived.
  // Per source, and the flow's own imports join it, so they never count.
  const [watching, setWatching] = useState(false);
  const [seen, setSeen] = useState<ReadonlySet<string> | null>(null);
  const since = useRef(0);
  const me = useMe().data?.user.id;
  // Kept fresh by `agents.changed` and by coming back to the tab, as from the AI app's.
  const agents = useAgents(orgId ?? "", orgId !== null && watching);
  // From a read that ended after watching started: the cache may miss an agent made while the socket was down.
  const fresh = watching && !agents.isFetching && agents.dataUpdatedAt >= since.current ? agents.data : undefined;
  useEffect(() => {
    if (!seen && fresh) setSeen(new Set(fresh.map((a) => a.id)));
  }, [seen, fresh]);
  const list = agents.data;
  const arrived = useMemo(() => (seen && list && me ? agentsSince(list, seen, me) : []), [seen, list, me]);
  const { refetch } = agents;
  // The first read failed: the step says so, and its Tentar de novo reads again, not the poll under it.
  const stalled = useRef(false);
  stalled.current = !seen && agents.isError;
  /** Watches for the agents an AI app creates through MCP (`arrived`) until the returned stop. */
  const watch = useCallback(() => {
    since.current = Date.now();
    setWatching(true);
    void refetch();
    // The onboarding has no workspace socket, so no `agents.changed`, and an AI app beside the window never hides the
    // tab: the list is read again meanwhile.
    const poll = setInterval(() => {
      if (!stalled.current) void refetch();
    }, WATCH_POLL_MS);
    return () => {
      clearInterval(poll);
      setWatching(false);
    };
  }, [refetch]);
  const setCard = (next: ImportCard | null) => {
    if (next !== card) {
      setSeen(null);
      // What went wrong with one source's file isn't the next one's.
      if (busy === null) setFailure(null);
    }
    pickCard(next);
  };

  const read = async (input: ReadInput) => {
    if (!orgId) return;
    setTouched(true);
    const mine = ++run.current;
    const current = () => mine === run.current;
    const from: ImportFailure["from"] = "url" in input ? "link" : "text" in input ? "paste" : "files";
    let step: ImportFailure["step"] = "read";
    last.current = input;
    setFailure(null);
    setBusy("reading");
    try {
      let files: ImportFile[];
      let root: string | null = null;
      let junk: string[] = [];
      let skipped: string[] = [];
      if ("url" in input) {
        if (!isGithubLink(input.url)) throw NOT_GITHUB;
        const res = await api.agents.importFromGithub(orgId, input.url);
        files = res.files.map((f) => ({ name: f.path, text: f.text }));
        skipped = res.skipped ?? [];
        root = githubRoot(input.url);
      } else if ("text" in input) {
        files = [{ name: PASTED, text: input.text }];
      } else {
        ({ files, root, junk } = await readImportFiles(await input.files));
      }
      if (!current()) return;
      step = "plan";
      const list = await qc.fetchQuery({ queryKey: keys.models, queryFn: () => api.agents.models() });
      step = "parse";
      // What the import writes for the person to read (a workflow's request) is in their language. Each key takes some
      // of these values, which i18next's types can't check for a key picked at run time.
      const say = (key: SayKey, values: SayValues) => String(t(`onboarding.import.say.${key}`, values as never));
      const parsed = parsePackage(files, { models: list.models.map((m) => m.id), root, junk, say });
      const { bundle } = parsed;
      if (!current()) return;
      step = "plan";
      setBusy("planning");
      const plan = await api.imports.apply(orgId, { bundle, dryRun: true });
      if (!current()) return;
      done.current = new Map();
      agentIds.current = new Map();
      sent.current = new Set();
      focus.current = "preview";
      setPlanned({
        bundle,
        items: plan.items,
        skipped,
        files: parsed.files,
        junk: junk.length,
        workflows: parsed.workflows,
        passes: parsed.passes,
      });
      setPick(new Set(plan.items.filter(choosable).map(itemId)));
      setReport(null);
      setCopyFiles(parsed.files.filter((f) => !f.skip).length <= MANY_FILES);
      setCopy(null);
      setCard(bundleOrigin(bundle).card);
    } catch (cause) {
      if (current()) setFailure({ from, step, cause });
    } finally {
      if (current()) setBusy(null);
    }
  };

  /**
   * Copies the agents' files into their Drive folders, without holding the import up: progress and what stayed
   * behind show in the report, a toast says when it's done. Each agent then keeps a line in its memory about where
   * its files are. `before`: an earlier copy whose failed files these are.
   */
  const copyToDrive = async (files: AgentFile[], bundle: MigrationBundle, before: FilesCopy | null = null) => {
    if (!orgId) return;
    const mine = run.current;
    const app = bundleOrigin(bundle).app ?? bundle.source.name;
    const total = files.filter((f) => !f.skip && agentIds.current.has(f.agent)).length;
    setCopy({ done: 0, total, running: true, result: before });
    const now = await copyAgentFiles(
      api,
      orgId,
      { files, agentIds: agentIds.current, note: t("onboarding.import.files.note", { app }) },
      (n, of) => {
        if (mine === run.current) setCopy((c) => c && { ...c, done: n, total: of });
      },
    );
    if (mine !== run.current) return;
    const result: FilesCopy = before
      ? {
          copied: before.copied + now.copied,
          folders: new Map([...before.folders, ...now.folders]),
          left: [...before.left, ...now.left],
        }
      : now;
    setCopy({ done: total, total, running: false, result });
    if (now.copied > 0) toast.show(t("onboarding.import.files.done", { count: now.copied }));
    const notes = filesNotes(now.folders, (folder) => t("onboarding.import.files.pointer", { app, folder }));
    if (notes.length === 0) return;
    await api.imports
      .apply(orgId, {
        bundle: { ...bundle, skills: [], channels: [], routines: [], notes, todo: [], leftOut: [] },
        dryRun: false,
        pick: notes.map((n) => itemId({ kind: "note", key: n.key })),
      })
      .catch(() => {});
  };

  /**
   * Applies what is picked (in chunks) and keeps the report. `prepare` changes
   * the bundle first (onboarding sets the models the chosen key can run). The
   * agents' files go to the Drive after the first apply, when chosen.
   */
  const apply = async (prepare?: (bundle: MigrationBundle) => MigrationBundle) => {
    if (!orgId || !planned) return [];
    const ids = picksOf(planned.items, pick, blockedItems(planned.bundle, planned.items, pick));
    if (ids.length === 0) return [];
    setProgress({ done: 0, total: ids.length });
    try {
      const items = await applyInChunks(
        api,
        orgId,
        { bundle: prepare ? prepare(planned.bundle) : planned.bundle, pick: ids },
        done.current,
        (n) => setProgress({ done: n, total: ids.length }),
      );
      focus.current = "report";
      setReport(items);
      arrivals.add(madeByImport(items));
      const arrived = agentsArrived(planned.items, items, pick, sent.current);
      for (const [key, id] of arrived) agentIds.current.set(key, id);
      setSeen((s) => s && new Set([...s, ...arrived.values()]));
      const theirs = planned.files.filter((f) => arrived.has(f.agent));
      if (copyFiles && theirs.length > 0) {
        for (const key of arrived.keys()) sent.current.add(key);
        void copyToDrive(theirs, planned.bundle, copy?.result ?? null);
      }
      return items;
    } finally {
      setProgress(null);
      void qc.invalidateQueries({ queryKey: keys.org(orgId) });
    }
  };

  const toggle = (ids: string[], on: boolean, set = setPick) =>
    set((p) => {
      const next = new Set(p);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  return {
    card,
    setCard,
    methods,
    /** Picks a way for a source; null goes back to choosing one (an app on the computer's list of ways). */
    setMethod: (c: ImportCard, method: ImportMethod | null) => {
      setFailure(null);
      setMethods((m) => {
        const next = { ...m };
        if (method) next[c] = method;
        else delete next[c];
        return next;
      });
    },
    watch,
    /** The person's agents made since the source's MCP steps first showed: an embedder's way on, as `report` is. */
    arrived,
    /** The read the MCP step counts from failed: nothing can show as arrived until `refetch` works. */
    watchError: watching && !seen && agents.isError && !agents.isFetching ? agents.error : null,
    rewatch: () => void refetch(),
    busy,
    failure,
    planned,
    pick,
    progress,
    report,
    touched,
    focus,
    read,
    /** Reads the last input again (after a failure that wasn't about the input itself). */
    retry: () => (last.current ? read(last.current) : Promise.resolve()),
    /** Stops waiting for a read: what it finds is dropped. */
    cancel: () => {
      run.current++;
      focus.current = "drop";
      setBusy(null);
    },
    apply,
    toggle: (ids: string[], on: boolean) => toggle(ids, on),
    copyFiles,
    setCopyFiles,
    copy,
    /** The agents here after the import, by key (for links to their files). */
    agentIds: agentIds.current,
    /** Sends again the files that failed (the network, the server). */
    retryFiles: () => {
      const before = copy?.result;
      if (!planned || !before || copy?.running) return;
      const failed = before.left.filter((l) => l.why === "failed").map((l) => l.file);
      const rest = { ...before, left: before.left.filter((l) => l.why !== "failed") };
      if (failed.length) void copyToDrive(failed, planned.bundle, rest);
    },
    reset: () => {
      setTouched(true);
      run.current++;
      done.current = new Map();
      agentIds.current = new Map();
      sent.current = new Set();
      focus.current = "drop";
      setBusy(null);
      setFailure(null);
      setPlanned(null);
      setReport(null);
      setCopy(null);
      setSeen(null);
    },
  };
}

export type ImportFlowState = ReturnType<typeof useImportFlow>;

const applyErrorText = (t: TFunction, error: unknown) => importApplyErrorText(t, error, failedOffline);

/** Why an item doesn't come, in plain words (an existing skill or channel says which). */
function whyText(t: TFunction, kind: ImportItemKind, reason: ImportSkipReason) {
  if (reason === "exists" && kind === "skill") return t("onboarding.import.whyExists.skill");
  if (reason === "exists" && kind === "channel") return t("onboarding.import.whyExists.channel");
  return t(`onboarding.import.why.${reason}`);
}

/**
 * The whole flow: the source cards and the drop zone, the plan to pick from,
 * then the report. `standalone` (Configurações) has its own Importar button and
 * links to the workspace's pages; onboarding applies when its agents step
 * continues, and links nowhere (until it's finished, every page of the workspace
 * leads back to it). `level` is the flow's top heading level.
 */
export function ImportFlow({
  flow,
  orgId,
  standalone = false,
  level = 2,
}: {
  flow: ImportFlowState;
  orgId: string;
  standalone?: boolean;
  level?: 2 | 3;
}) {
  // Every source has its sheet, over whichever step shows (ADR 0055, addendum 2026-11-16). Picked before this showed
  // (the onboarding's own cards): its sheet is open from the start.
  const [sheet, setSheet] = useState<ImportSheetKind | null>(() => (!flow.planned && flow.card ? flow.card : null));
  const open = (kind: ImportSheetKind) => {
    flow.setCard(kind === "file" ? null : kind);
    setSheet(kind);
  };
  const close = () => {
    // Back on the page, what it shows now takes the focus: the sheet's own opener may be gone.
    if (flow.planned) flow.focus.current = flow.report ? "report" : "preview";
    setSheet(null);
  };
  const index = useBundleIndex(flow);
  const todo = flow.planned?.bundle.todo ?? [];
  return (
    <>
      {flow.planned && flow.report ? (
        <ImportReport flow={flow} orgId={orgId} level={level} onAnother={flow.reset} linked={standalone} />
      ) : flow.planned ? (
        <Preview flow={flow} orgId={orgId} standalone={standalone} level={level} />
      ) : (
        <Picker flow={flow} open={sheet} onOpen={open} />
      )}
      <ImportSheet
        flow={flow}
        sheet={sheet}
        orgId={orgId}
        onClose={close}
        standalone={standalone}
        todos={
          todo.length > 0 ? (
            <Todos todo={todo} nameOf={index.nameOf} orgId={orgId} linked={standalone && flow.report !== null} />
          ) : null
        }
      />
    </>
  );
}

function Heading({ level, ...rest }: { level: 2 | 3 | 4 } & ComponentProps<"h2">) {
  const Tag = `h${level}` as const;
  return <Tag {...rest} />;
}

export function SourceMark({ card }: { card: ImportCard }) {
  // The app's own theme, which can differ from the system's: so not a `<picture>` with a media query.
  const dark = useTheme().resolved === "dark";
  if (card === "other") {
    return (
      <span className="imp-mark" aria-hidden="true">
        <Icon name="message" />
      </span>
    );
  }
  const mark = CARD_MARK[card];
  return (
    <span className="imp-mark" aria-hidden="true">
      <img src={dark && mark.dark ? mark.dark : mark.icon} alt="" className="imp-mark__img" />
    </span>
  );
}

/**
 * The apps a team can come from, each opening its sheet, and one button for a file or link from any of them. A file
 * dropped anywhere here opens that sheet already reading it.
 */
function Picker({
  flow,
  open,
  onOpen,
}: {
  flow: ImportFlowState;
  /** The sheet that is open, whose card shows pressed. */
  open: ImportSheetKind | null;
  onOpen: (kind: ImportSheetKind) => void;
}) {
  const { t } = useTranslation();
  // Back to the start with no sheet open: the file button. With one open, its drop zone takes it.
  const file = useFocusOn<HTMLButtonElement>(flow, "drop", undefined, open === null);
  const [over, setOver] = useState(false);
  const busy = flow.busy !== null;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a bigger drop target; the file button is the keyboard way
    <div
      className="imp-pick"
      data-over={over || undefined}
      // A file dropped here is always caught (the browser would open it in place of the flow); while a
      // read runs it is refused.
      onDragOver={(e) => {
        if (!hasFiles(e.dataTransfer)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = busy ? "none" : "copy";
        if (!busy) setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        if (!hasFiles(e.dataTransfer)) return;
        e.preventDefault();
        setOver(false);
        if (busy) return;
        onOpen("file");
        void flow.read({ files: droppedFiles(e.dataTransfer) });
      }}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: pressable cards, not a native fieldset */}
      <div className="imp-sources" role="group" aria-label={t("onboarding.import.sourcesLabel")}>
        {IMPORT_CARDS.map((c) => (
          <OptionCard key={c} stacked pressed={open === c} onClick={() => onOpen(c)} className="imp-source">
            <SourceMark card={c} />
            <span className="ac-option__title">{cardName(t, c)}</span>
          </OptionCard>
        ))}
      </div>
      {over ? (
        <div className="imp-drop">
          <div className="imp-drop__area">
            <Icon name="upload" />
            <b>{t("onboarding.import.dropping")}</b>
          </div>
        </div>
      ) : (
        <div className="imp-pick__file">
          <Button ref={file} icon="upload" onClick={() => onOpen("file")}>
            {t("onboarding.import.haveFileButton")}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Lookups by key in the bundle, and who comes (picked, or already here). */
function useBundleIndex(flow: ImportFlowState) {
  const planned = flow.planned;
  const index = useMemo(() => {
    const b = planned?.bundle;
    return {
      agents: new Map((b?.agents ?? []).map((a) => [a.key, a])),
      skills: new Map((b?.skills ?? []).map((s) => [s.key, s])),
      channels: new Map((b?.channels ?? []).map((c) => [c.key, c])),
      routines: new Map((b?.routines ?? []).map((r) => [r.key, r])),
      notes: new Map((b?.notes ?? []).map((n) => [n.key, n])),
      items: new Map((planned?.items ?? []).map((i) => [itemId(i), i])),
    };
  }, [planned]);
  /** Created or changed by this import (checked). */
  const picked = (kind: ImportItemKind, key: string) => {
    const item = index.items.get(`${kind}:${key}`);
    return !!item && choosable(item) && flow.pick.has(itemId(item));
  };
  const coming = (kind: ImportItemKind, key: string) =>
    index.items.get(`${kind}:${key}`)?.action === "unchanged" || picked(kind, key);
  const nameOf = (key: string) => index.agents.get(key)?.name ?? key;
  return { ...index, picked, coming, nameOf };
}

/** Skipped last, already-here before them; the plan's order otherwise. */
const RANK: Record<ImportItemResult["action"], number> = { create: 0, update: 0, unchanged: 1, skip: 2 };

/** The dry run, to pick from: groups with a status per row, then what to do after and what stays behind. */
export function Preview({
  flow,
  orgId,
  standalone,
  level,
}: {
  flow: ImportFlowState;
  orgId: string;
  standalone: boolean;
  level: 2 | 3;
}) {
  const { t } = useTranslation();
  const heading = useFocusOn<HTMLHeadingElement>(flow, "preview");
  const index = useBundleIndex(flow);
  const planned = flow.planned;
  const blocked = useMemo(
    () => (planned ? blockedItems(planned.bundle, planned.items, flow.pick) : new Map<string, ImportSkipReason>()),
    [planned, flow.pick],
  );
  if (!planned) return null;
  const { bundle, items, skipped, junk } = planned;
  const origin = bundleOrigin(bundle);
  const applying = flow.progress !== null;
  const picks = picksOf(items, flow.pick, blocked);
  const summary = kindsLine(t, (kind) => items.filter((i) => i.kind === kind && i.action !== "skip").length);
  const sub = (level + 1) as 3 | 4;

  return (
    <section className="imp-preview" aria-labelledby="imp-preview-title">
      <header className="imp-head ac-mediarow">
        <span className="ac-mediarow__face">
          <SourceMark card={origin.card} />
        </span>
        <div className="ac-mediarow__head">
          <Heading level={level} id="imp-preview-title" ref={heading} tabIndex={-1} className="imp-head__title">
            {bundle.source.name}
          </Heading>
        </div>
        <span className="ac-mediarow__end">
          <Button variant="ghost" size="sm" onClick={flow.reset} disabled={applying}>
            {t("onboarding.import.change")}
          </Button>
        </span>
        <div className="ac-mediarow__body">
          <p className="imp-head__sub">
            {[origin.app ? t("onboarding.import.from", { app: origin.app }) : t("onboarding.import.fromOther"), summary]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
      </header>
      {bundle.source.ref === `agenteschat:${orgId}` && (
        <Alert tone="neutral">{t("onboarding.import.sameWorkspace")}</Alert>
      )}

      <fieldset className="imp-groups" disabled={applying}>
        <legend className="ac-visually-hidden">{t("onboarding.import.pickLegend")}</legend>
        {IMPORT_KINDS.map((kind) => {
          const rows = items.filter((i) => i.kind === kind).sort((a, b) => RANK[a.action] - RANK[b.action]);
          return rows.length > 0 ? (
            <Group key={kind} kind={kind} rows={rows} flow={flow} blocked={blocked} index={index} level={sub} />
          ) : null;
        })}
        <FilesGroup flow={flow} index={index} level={sub} />
      </fieldset>

      {skipped.length > 0 && (
        <p className="imp-note ac-iconline">
          <Icon name="file" size={16} />
          <span>
            {t("onboarding.import.linkSkipped", { count: skipped.length })}: {skipped.join(", ")} ·{" "}
            {t("onboarding.import.linkSkippedHelp")}
          </span>
        </p>
      )}
      {junk > 0 && (
        <p className="imp-note ac-iconline">
          <Icon name="info" size={16} />
          <HintLine
            name={t("common.about", { label: t("onboarding.import.systemFiles", { count: junk }) })}
            hint={t("onboarding.import.systemFilesHelp")}
          >
            {t("onboarding.import.systemFiles", { count: junk })}
          </HintLine>
        </p>
      )}
      <p className="imp-note ac-iconline">
        <Icon name="lock" size={16} />
        <span>{t("onboarding.import.never")}</span>
      </p>

      {standalone ? (
        <ApplyBar flow={flow} count={picks.length} />
      ) : (
        <p className="imp-note ac-iconline">
          <Icon name="info" size={16} />
          <span>{t("onboarding.import.withTeam")}</span>
        </p>
      )}
    </section>
  );
}

/** Importar (Configurações): the count, the progress while it runs, and what to do when it fails. */
function ApplyBar({ flow, count }: { flow: ImportFlowState; count: number }) {
  const { t } = useTranslation();
  const apply = useMutation({ mutationFn: () => flow.apply(), meta: { silent: true } });
  const items = flow.planned?.items ?? [];
  const here = items.every((i) => i.action === "unchanged");
  return (
    <div className="imp-apply">
      {apply.isError && <Alert>{applyErrorText(t, apply.error)}</Alert>}
      {flow.progress && (
        <p className="imp-apply__progress" role="status">
          {t("onboarding.import.applying", flow.progress)}
        </p>
      )}
      {items.some(choosable) ? (
        <Button
          variant="primary"
          onClick={() => apply.mutate()}
          disabled={count === 0 || apply.isPending}
          loading={apply.isPending}
        >
          {t("onboarding.import.go", { count })}
        </Button>
      ) : (
        <p className="imp-apply__none ac-iconline">
          <Icon name={here ? "check" : "info"} size={16} />
          {here ? t("onboarding.import.nothingNew") : t("onboarding.import.nothingToBring")}
        </p>
      )}
    </div>
  );
}

type Index = ReturnType<typeof useBundleIndex>;

/** A group (Agentes, Skills…): pick all, its rows, the first few until "Mostrar mais". */
function Group({
  kind,
  rows,
  flow,
  blocked,
  index,
  level,
}: {
  kind: ImportItemKind;
  rows: ImportItemResult[];
  flow: ImportFlowState;
  blocked: Map<string, ImportSkipReason>;
  index: Index;
  level: 3 | 4;
}) {
  const { t } = useTranslation();
  const long = rows.length > SHOWN + 2;
  const [open, setOpen] = useState(!long);
  const free = rows.filter((i) => choosable(i) && !blocked.has(itemId(i))).map(itemId);
  const on = free.filter((id) => flow.pick.has(id)).length;
  const title = t(`onboarding.import.groups.${kind}`);
  return (
    <section className="imp-group" aria-labelledby={`imp-group-${kind}`}>
      <div className="imp-group__head">
        {free.length > 0 ? (
          <Checkbox
            checked={on === 0 ? false : on === free.length ? true : "indeterminate"}
            onCheckedChange={(v) => flow.toggle(free, v)}
            aria-label={t("onboarding.import.bringAll", { group: title })}
          />
        ) : (
          <span className="imp-row__mark" aria-hidden="true" />
        )}
        <Heading level={level} id={`imp-group-${kind}`} className="imp-group__title">
          {title}
        </Heading>
        <CountChip size="sm">{rows.length}</CountChip>
      </div>
      <ul className="imp-rows">
        {(open ? rows : rows.slice(0, SHOWN)).map((item, i) => (
          <Row
            key={itemId(item)}
            rowId={`imp-${kind}-${i}`}
            item={item}
            flow={flow}
            reason={item.action === "skip" ? item.reason : blocked.get(itemId(item))}
            index={index}
          />
        ))}
      </ul>
      {long && (
        <Button
          variant="ghost"
          size="sm"
          className="imp-group__more"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? t("onboarding.import.less") : t("onboarding.import.more", { count: rows.length - SHOWN })}
        </Button>
      )}
    </section>
  );
}

/**
 * The agents' own files (OpenBot.run's `files/`, an OpenClaw workspace): the choice to copy them to the Drive, on
 * unless turned off; where each agent's go, how many and how big; what stays behind and why (keys and sign-ins never
 * come, as the preview's lock line says).
 */
function FilesGroup({ flow, index, level }: { flow: ImportFlowState; index: Index; level: 3 | 4 }) {
  const { t, i18n } = useTranslation();
  const files = (flow.planned?.files ?? []).filter((f) => index.coming("agent", f.agent));
  const going = files.filter((f) => !f.skip);
  if (going.length === 0) return null;
  const agents = [...new Set(going.map((f) => f.agent))];
  const left = files.flatMap((file) => (file.skip && file.skip !== "secret" ? [{ file, why: file.skip }] : []));
  return (
    <section className="imp-group" aria-labelledby="imp-group-files">
      <div className="imp-group__head">
        <Switch id="imp-files-copy" checked={flow.copyFiles} onCheckedChange={flow.setCopyFiles} />
        <Heading level={level} id="imp-group-files" className="imp-group__title">
          <label htmlFor="imp-files-copy">{t("onboarding.import.files.copy")}</label>
        </Heading>
        <CountChip size="sm">{going.length}</CountChip>
        <span className="imp-group__help">
          {t(going.length > MANY_FILES ? "onboarding.import.files.many" : "onboarding.import.files.help", {
            count: going.length,
          })}
        </span>
      </div>
      <ul className="imp-rows">
        {agents.map((key) => {
          const a = index.agents.get(key);
          const theirs = going.filter((f) => f.agent === key);
          const size = formatBytes(
            i18n.language,
            theirs.reduce((n, f) => n + f.size, 0),
          );
          return (
            <li key={key} className="imp-row ac-actrow" data-off={!flow.copyFiles || undefined}>
              <span className="imp-row__mark" aria-hidden="true">
                <Icon name="drive" size={14} />
              </span>
              <span className="imp-row__lead" aria-hidden="true">
                {a && <AgentAvatar name={a.name} appearance={normalizeAppearance(a.appearance)} size="sm" />}
              </span>
              <span className="imp-row__text ac-actrow__text">
                <span className="imp-row__title">
                  {t("onboarding.import.files.folder", { folder: driveFolder(a?.name ?? key) })}
                </span>
                <span className="imp-row__line">
                  {t("onboarding.import.files.count", { count: theirs.length, size })}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
      {left.length > 0 && (
        <div className="imp-group__foot">
          <FilesLeft left={left} />
        </div>
      )}
    </section>
  );
}

/** The agents' files that stay behind, by reason: a few names, then how many more. */
function FilesLeft({ left }: { left: FilesCopy["left"] }) {
  const { t } = useTranslation();
  const reasons = (Object.keys(FILE_LEFT) as FileLeft[]).flatMap((why) => {
    const paths = left.filter((l) => l.why === why).map((l) => l.file.path);
    return paths.length ? [{ why, paths }] : [];
  });
  return (
    <ul className="imp-left">
      {reasons.map(({ why, paths }) => (
        <li key={why}>
          <Chip icon={FILE_LEFT[why]}>{t(`onboarding.import.files.left.${why}`, { max: MAX_UPLOAD_MB })}</Chip>
          <span className="small">
            {paths.length > NAMES_SHOWN + 1
              ? `${paths.slice(0, NAMES_SHOWN).join(", ")} ${t("onboarding.import.files.more", { count: paths.length - NAMES_SHOWN })}`
              : paths.join(", ")}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The chip of a row: what the import does with it, when that's worth saying. */
function statusOf(
  item: ImportItemResult,
  reason: ImportSkipReason | undefined,
): {
  icon: IconName;
  tone?: ChipTone;
  key: "update" | "unchanged" | "skip" | "join";
} | null {
  if (item.action === "skip" || reason) return { icon: "block", key: "skip" };
  if (item.action === "update" && item.reason === "exists") return { icon: "link", key: "join" };
  if (item.action === "update") return { icon: "refresh", key: "update" };
  if (item.action === "unchanged") return { icon: "check", tone: "done", key: "unchanged" };
  // A new item says nothing: it's what every row would say.
  return null;
}

function Row({
  rowId,
  item,
  flow,
  reason,
  index,
}: {
  rowId: string;
  item: ImportItemResult;
  flow: ImportFlowState;
  /** Why it won't come: the plan's skip, or something it needs that was unchecked. */
  reason: ImportSkipReason | undefined;
  index: Index;
}) {
  const { t } = useTranslation();
  const id = itemId(item);
  const pickable = choosable(item) && !reason;
  const checked = pickable && flow.pick.has(id);
  const status = statusOf(item, reason);
  const names = (list: string[]) => joinNames(list, t);

  let title = item.label;
  let lead: ReactNode = <Icon name={KIND_ICON[item.kind]} size={16} />;
  const lines: string[] = [];
  if (item.kind === "agent") {
    const a = index.agents.get(item.key);
    if (a) {
      title = a.role ? `${item.label} · ${a.role}` : item.label;
      lead = <AgentAvatar name={a.name} appearance={normalizeAppearance(a.appearance)} size="sm" />;
      // An id another app gave the agent is no handle: only the one it gets shows, and that is no rename.
      if (isIdHandle(a.handle)) {
        if (item.renamedTo) lines.push(`@${item.renamedTo}`);
      } else if (!item.renamedTo) lines.push(`@${a.handle}`);
    }
  } else if (item.kind === "skill") {
    const s = index.skills.get(item.key);
    const about = s ? frontmatter(s.markdown)?.data.description : undefined;
    if (typeof about === "string" && about.trim()) lines.push(about.trim());
  } else if (item.kind === "channel") {
    const c = index.channels.get(item.key);
    title = `#${item.label}`;
    if (c?.topic) lines.push(c.topic);
    const members = (c?.agents ?? []).filter((m) => index.coming("agent", m.key)).map((m) => index.nameOf(m.key));
    if (members.length) lines.push(t("onboarding.import.with", { names: names(members) }));
  } else if (item.kind === "routine") {
    const r = index.routines.get(item.key);
    if (r) {
      const agent = index.nameOf(r.agent);
      const channel = r.channel ? index.channels.get(r.channel)?.name : undefined;
      lines.push(
        channel ? t("onboarding.import.inChannel", { agent, channel }) : t("onboarding.import.inDm", { agent }),
      );
    }
  } else {
    const n = index.notes.get(item.key);
    // The label is the note's first line: a Markdown heading or list mark is noise in a row.
    title = item.label.replace(/^(#+|[-*+]|\d+[.)])\s+/, "");
    lines.push(
      n?.agent
        ? t("onboarding.import.memoryOf", { name: index.nameOf(n.agent) })
        : t("onboarding.import.memoryWorkspace"),
    );
  }

  const notes: string[] = [];
  if (reason) notes.push(whyText(t, item.kind, reason));
  // A channel's update only brings agents in: its name and topic stay as people here left them.
  else if (item.action === "update" && (item.reason === "exists" || item.kind === "channel"))
    notes.push(t("onboarding.import.joins", { name: item.label }));
  else {
    if (item.reason === "model_not_in_catalog") notes.push(t("onboarding.import.why.model_not_in_catalog"));
    if (item.action === "update") notes.push(t("onboarding.import.updates"));
  }
  if (item.renamedTo && !reason) {
    const wanted = index.agents.get(item.key)?.handle ?? item.key;
    if (!isIdHandle(wanted)) notes.push(t("onboarding.import.renamed", { handle: item.renamedTo, wanted }));
  }
  if (item.trimmed?.length && !reason) {
    const fields = item.trimmed.map((f) =>
      FIELDS.some((k) => k === f) ? t(`onboarding.import.fields.${f as (typeof FIELDS)[number]}`) : f,
    );
    notes.push(t("onboarding.import.trimmed", { fields: fields.join(", ") }));
  }

  const text = (
    <>
      <span className="imp-row__title">{title}</span>
      {lines.map((l) => (
        <span key={l} className="imp-row__line">
          {l}
        </span>
      ))}
      {notes.map((n) => (
        <span key={n} className="imp-row__note">
          {n}
        </span>
      ))}
    </>
  );
  return (
    <li className="imp-row ac-actrow ac-tailrow" data-off={(!checked && item.action !== "unchanged") || undefined}>
      {pickable ? (
        <Checkbox
          id={rowId}
          checked={checked}
          onCheckedChange={(on) => flow.toggle([id], on)}
          aria-label={t("onboarding.import.bring", { name: item.label })}
          aria-describedby={status ? `${rowId}-about ${rowId}-status` : `${rowId}-about`}
        />
      ) : (
        <span className="imp-row__mark" aria-hidden="true">
          <Icon name={item.action === "unchanged" ? "check" : "dash"} size={14} />
        </span>
      )}
      <span className="imp-row__lead" aria-hidden="true">
        {lead}
      </span>
      {pickable ? (
        <label htmlFor={rowId} id={`${rowId}-about`} className="imp-row__text ac-actrow__text">
          {text}
        </label>
      ) : (
        <span className="imp-row__text ac-actrow__text">{text}</span>
      )}
      {status && (
        <Chip id={`${rowId}-status`} icon={status.icon} tone={status.tone} className="imp-row__chip ac-tail">
          {t(`onboarding.import.status.${status.key}`)}
        </Chip>
      )}
    </li>
  );
}

/** Where a to-do is done: Conectores, the team or the Drive. A secret has no page: the agent asks for it in the chat. */
function TodoLink({ kind, orgId }: { kind: BundleTodo["kind"]; orgId: string }) {
  const { t } = useTranslation();
  if (kind === "secret") return null;
  const label = t(`onboarding.import.needDo.${kind}`);
  if (kind === "model") {
    return (
      <Link to="/org/$orgId/team" params={{ orgId }} className="ac-link imp-todo__link">
        {label}
      </Link>
    );
  }
  if (kind === "file" || kind === "path") {
    return (
      <Link to="/org/$orgId/drive" params={{ orgId }} className="ac-link imp-todo__link">
        {label}
      </Link>
    );
  }
  if (kind === "webhook") {
    return (
      <Link to="/org/$orgId/routines" params={{ orgId }} className="ac-link imp-todo__link">
        {label}
      </Link>
    );
  }
  return (
    <Link
      to="/org/$orgId/settings/$section"
      params={{ orgId, section: "connectors" }}
      className="ac-link imp-todo__link"
    >
      {label}
    </Link>
  );
}

/** What the person sets up by hand, one line each: "Ada usa o HubSpot. Conectar". */
function Todos({
  todo,
  nameOf,
  orgId,
  linked,
}: {
  todo: BundleTodo[];
  nameOf: (key: string) => string;
  orgId: string;
  /** Where each one is done, as a link. */
  linked: boolean;
}) {
  const { t } = useTranslation();
  return (
    <ul className="imp-todo" aria-label={t("onboarding.import.needLabel")}>
      {todo.map((x) => (
        <li key={`${x.kind}:${x.label}`} className="ac-iconline">
          <Icon name={TODO_ICON[x.kind]} size={16} />
          <span className="imp-todo__text">{todoLine(t, x, nameOf)}</span>
          {linked && <TodoLink kind={x.kind} orgId={orgId} />}
        </li>
      ))}
    </ul>
  );
}

/**
 * After the apply: what came (with links to it), what didn't and why (with
 * Tentar de novo: applying again is safe), and what to set up next.
 */
export function ImportReport({
  flow,
  orgId,
  level = 2,
  linked = true,
  onRetry,
  onAnother,
}: {
  flow: ImportFlowState;
  orgId: string;
  level?: 2 | 3;
  /** Links to what came, and to where each to-do is done. */
  linked?: boolean;
  /** Default: apply again. */
  onRetry?: () => Promise<unknown>;
  onAnother?: () => void;
}) {
  const { t } = useTranslation();
  const heading = useFocusOn<HTMLHeadingElement>(flow, "report");
  const index = useBundleIndex(flow);
  const retry = useMutation({ mutationFn: () => (onRetry ? onRetry() : flow.apply()), meta: { silent: true } });
  const report = flow.report;
  const bundle = flow.planned?.bundle;
  if (!report || !bundle) return null;
  const made = report.filter((i) => i.action === "create" || i.action === "update");
  const missed = report.filter((i) => i.action === "skip");
  const copy = flow.copy;
  // Already here: what the plan said so (never sent) and what came back unchanged.
  const sent = new Set(report.map(itemId));
  const kept = [...(flow.planned?.items ?? []).filter((i) => !sent.has(itemId(i))), ...report].filter(
    (i) => i.action === "unchanged",
  ).length;
  const capped = made.filter((i) => i.reason === "too_many_routines").length;
  const agentId = new Map(report.filter((i) => i.kind === "agent" && i.targetId).map((i) => [i.key, i.targetId]));
  const sub = (level + 1) as 3 | 4;

  const links = (kind: ImportItemKind, list: ImportItemResult[]): ReactNode => {
    if (!linked) return null;
    if (kind === "agent") {
      return list.map((i) => {
        const a = index.agents.get(i.key);
        return i.targetId ? (
          <Link
            key={i.key}
            to="/org/$orgId/agents/$agentId"
            params={{ orgId, agentId: i.targetId }}
            className="imp-link"
          >
            {a && <AgentAvatar name={a.name} appearance={normalizeAppearance(a.appearance)} size="sm" />}
            {i.label}
          </Link>
        ) : null;
      });
    }
    if (kind === "channel") {
      return list.map((i) =>
        i.targetId ? (
          <Link
            key={i.key}
            to="/org/$orgId/c/$channelId"
            params={{ orgId, channelId: i.targetId }}
            className="imp-link"
          >
            #{i.label}
          </Link>
        ) : null,
      );
    }
    if (kind === "skill") {
      return (
        <Link to="/org/$orgId/settings/$section" params={{ orgId, section: "skills" }} className="imp-link">
          {t("onboarding.import.report.openSkills")}
        </Link>
      );
    }
    if (kind === "routine") {
      return (
        <Link to="/org/$orgId/routines" params={{ orgId }} className="imp-link">
          {t("onboarding.import.report.openRoutines")}
        </Link>
      );
    }
    const owners = [
      ...new Set(
        list.flatMap((i) => {
          const key = index.notes.get(i.key)?.agent;
          return key ? [key] : [];
        }),
      ),
    ];
    return owners.map((key) => {
      const id = agentId.get(key);
      return id ? (
        <Link key={key} to="/org/$orgId/agents/$agentId/memory" params={{ orgId, agentId: id }} className="imp-link">
          {t("onboarding.import.memoryOf", { name: index.nameOf(key) })}
        </Link>
      ) : null;
    });
  };

  return (
    <section className="imp-report" aria-labelledby="imp-report-title">
      <header className="imp-head ac-mediarow">
        <span className="ac-mediarow__face">
          <span className="imp-mark imp-mark--done" aria-hidden="true">
            <Icon name={missed.length ? "alert" : "check"} />
          </span>
        </span>
        <div className="ac-mediarow__head">
          <Heading level={level} id="imp-report-title" ref={heading} tabIndex={-1} className="imp-head__title">
            {missed.length
              ? t("onboarding.import.report.partial", { done: report.length - missed.length, total: report.length })
              : t("onboarding.import.report.title")}
          </Heading>
        </div>
        <div className="ac-mediarow__body">
          <p className="imp-head__sub">{bundle.source.name}</p>
        </div>
      </header>

      <ul className="imp-made">
        {IMPORT_KINDS.map((kind) => {
          const list = made.filter((i) => i.kind === kind);
          if (list.length === 0) return null;
          return (
            <li key={kind} className="ac-mediarow ac-mediarow--row">
              <span className="ac-mediarow__face">
                <span className="imp-made__icon" aria-hidden="true">
                  <Icon name={KIND_ICON[kind]} size={16} />
                </span>
              </span>
              <span className="ac-mediarow__head">
                <b>{t(`onboarding.import.report.kinds.${kind}`, { count: list.length })}</b>
              </span>
              <span className="ac-mediarow__body imp-made__links">{links(kind, list)}</span>
            </li>
          );
        })}
        {copy && (
          <li className="ac-mediarow ac-mediarow--row">
            <span className="ac-mediarow__face">
              <span className="imp-made__icon" aria-hidden="true">
                <Icon name="drive" size={16} />
              </span>
            </span>
            <span className="ac-mediarow__head">
              {copy.running ? (
                <b role="status">{t("onboarding.import.files.copying", { done: copy.done, total: copy.total })}</b>
              ) : (
                <b role="status">
                  {copy.result?.copied
                    ? t("onboarding.import.files.copied", { count: copy.result.copied })
                    : t("onboarding.import.files.none")}
                </b>
              )}
            </span>
            <span className="ac-mediarow__body">
              {copy.running && <span>{t("onboarding.import.files.keepOpen")}</span>}
              <span className="imp-made__links">
                {[...(copy.result?.folders ?? [])].map(([key, folder]) => {
                  const id = flow.agentIds.get(key);
                  const label = t("onboarding.import.files.folder", { folder });
                  return linked && id ? (
                    <Link
                      key={key}
                      to="/org/$orgId/agents/$agentId"
                      params={{ orgId, agentId: id }}
                      search={{ tab: "files" }}
                      className="imp-link"
                    >
                      {label}
                    </Link>
                  ) : (
                    <span key={key} className="muted">
                      {label}
                    </span>
                  );
                })}
              </span>
            </span>
          </li>
        )}
      </ul>
      {kept > 0 && <p className="small muted">{t("onboarding.import.report.kept", { count: kept })}</p>}
      {capped > 0 && <p className="small muted">{t("onboarding.import.report.capped", { count: capped })}</p>}

      {copy?.result && copy.result.left.length > 0 && (
        <section className="imp-block" aria-labelledby="imp-files-left-title">
          <Heading level={sub} id="imp-files-left-title" className="imp-block__title">
            {t("onboarding.import.files.leftTitle")}
          </Heading>
          <FilesLeft left={copy.result.left} />
          {copy.result.left.some((l) => l.why === "failed") && (
            <div>
              <Button icon="refresh" onClick={flow.retryFiles} loading={copy.running} disabled={copy.running}>
                {t("common.retry")}
              </Button>
            </div>
          )}
        </section>
      )}

      {missed.length > 0 && (
        <section className="imp-block" aria-labelledby="imp-missed-title">
          <Heading level={sub} id="imp-missed-title" className="imp-block__title">
            {t("onboarding.import.report.notCame")}
          </Heading>
          <ul className="imp-missed">
            {missed.map((i) => (
              <li key={itemId(i)} className="ac-iconline">
                <Icon name={KIND_ICON[i.kind]} size={16} />
                <span>
                  {i.label}
                  {i.reason && <span className="muted"> · {whyText(t, i.kind, i.reason)}</span>}
                </span>
              </li>
            ))}
          </ul>
          {retry.isError && <Alert>{applyErrorText(t, retry.error)}</Alert>}
          <div>
            <Button icon="refresh" onClick={() => retry.mutate()} loading={retry.isPending} disabled={retry.isPending}>
              {t("common.retry")}
            </Button>
          </div>
        </section>
      )}

      {bundle.todo.length > 0 && <Todos todo={bundle.todo} nameOf={index.nameOf} orgId={orgId} linked={linked} />}

      {onAnother && (
        <div>
          <Button variant="ghost" icon="upload" onClick={onAnother}>
            {t("onboarding.import.report.another")}
          </Button>
        </div>
      )}
    </section>
  );
}

/**
 * Configurações → Importar e exportar (admins): the import flow, and this workspace as a file, with what it never
 * carries (whoever shares the file needs that); the full list is on the help page. A workspace being deleted takes no
 * agent, so only its export shows.
 */
export function ImportExportSection() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const flow = useImportFlow(org.id);
  if (!can(org, "create_agents")) return null;
  const download = () => saveExport(api, org.id);
  return (
    <>
      {makesAgents(org) && (
        <Card aria-labelledby="imp-import-title">
          <CardHeader icon="upload" id="imp-import-title" title={t("settings.import.title")} />
          <ImportFlow flow={flow} orgId={org.id} standalone level={3} />
        </Card>
      )}
      <Card aria-labelledby="imp-export-title">
        <CardHeader
          icon="download"
          id="imp-export-title"
          title={t("settings.import.exportTitle")}
          action={
            <Button icon="download" onClick={download}>
              {t("settings.import.download")}
            </Button>
          }
        />
        <p className="imp-note ac-iconline">
          <Icon name="lock" size={16} />
          <span>{t("settings.import.neverLine")}</span>
        </p>
        <p className="imp-help">
          <HelpLink slug="import" section="export">
            {t("settings.import.whatsIn")}
          </HelpLink>
        </p>
      </Card>
    </>
  );
}
