import { useApps, useMe } from "@agenteschat/client";
import { aiAppImport } from "@agenteschat/client/lib/apps";
import { errorText } from "@agenteschat/client/lib/errors";
import {
  type ComputerCard,
  type ComputerOs,
  computerApp,
  computerOs,
  isComputerCard,
  migrateCommand,
  migrateFile,
  migratePrompt,
} from "@agenteschat/client/lib/import/computer";
import { can } from "@agenteschat/client/lib/permissions";
import {
  AffixInput,
  Alert,
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  Field,
  Icon,
  type IconName,
  InfoHint,
  JourneyScene,
  normalizeAppearance,
  OptionLinks,
  Segmented,
  Spinner,
  SwapLabel,
  Textarea,
} from "@agenteschat/ui";
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { GuideExtras, GuideInstalls, GuideNotes, GuideWords } from "@/components/AiApps";
import { HelpLink } from "@/components/HelpLink";
import { useChoiceSheet } from "@/components/ImportChoice";
import { ImportFailureNote } from "@/components/ImportFailure";
import type { ImportFlowState } from "@/components/ImportFlow";
import { EXPORT_PROMPT, IMPORT_ACCEPT } from "@/lib/import";
import {
  cardName,
  computerPaths,
  defaultMethod,
  droppedFiles,
  type ImportCard,
  type ImportMethod,
  isRequestCard,
  mcpClient,
  type RequestCard,
} from "@/lib/import-flow";
import { hasFiles } from "@/lib/obsidian";
import "./hosting.css";
import "./import-sheet.css";

/** What a sheet opens for: an app's card, or a file or link from any app. */
export type ImportSheetKind = ImportCard | "file";

/** Where the flow sends the focus next, once what had it is replaced. */
export type ImportFocus = "preview" | "report" | "drop" | null;

/**
 * Moves focus to `el` once, when the flow asked for it (a step that replaced what had focus), or to `instead` where
 * `el` isn't shown. `when`: whether this one takes it now (another may, while it's hidden).
 */
export function useFocusOn<T extends HTMLElement>(
  flow: ImportFlowState,
  target: Exclude<ImportFocus, null>,
  instead?: RefObject<HTMLElement | null>,
  when = true,
) {
  const el = useRef<T>(null);
  useEffect(() => {
    if (!when || flow.focus.current !== target) return;
    flow.focus.current = null;
    (el.current ?? instead?.current)?.focus();
  });
  return el;
}

/** How long the MCP steps wait before they say what to check when nothing came. */
const STUCK_MS = 2 * 60_000;

/**
 * This server's MCP way in and the way on screen for a source (the flow's own by default), which an embedder reads to
 * say what the step asks. Prompt only for an app that takes no MCP, where MCP can't work now (`aiAppImport`), or when
 * this server's address couldn't be read. An app on the person's computer lists its ways (`paths`: the command, its own
 * agent through MCP, its agent writing the export) and has none until the person picks one, unless the command is its
 * only one (ADR 0055, addenda 2026-11-16). Null while it loads, so the default never changes under the person.
 */
export function useImportMethod(flow: ImportFlowState, orgId: string, of: ImportCard | null = flow.card) {
  const { t } = useTranslation();
  const apps = useApps(orgId);
  const standing = useMe().data?.organizations.find((o) => o.id === orgId)?.standing;
  const mcp = aiAppImport(t, apps.data, standing);
  // Whether apps on the internet reach this server: unknown while it loads, no when that read failed.
  const reachable = mcp ? mcp.available : apps.isError ? false : null;
  if (isComputerCard(of)) {
    const paths = reachable === null && mcpClient(of) ? null : computerPaths(of, reachable === true);
    const picked = flow.methods[of];
    const method: ImportMethod | null = !paths
      ? null
      : picked && paths.includes(picked)
        ? picked
        : paths.length === 1
          ? "command"
          : null;
    return { mcp, method, paths };
  }
  const method: ImportMethod | null =
    !of || !mcpClient(of)
      ? "prompt"
      : reachable === null
        ? null
        : ((reachable ? flow.methods[of] : undefined) ?? defaultMethod(of, reachable));
  return { mcp, method, paths: null };
}

/**
 * Bringing a team in, as one sheet over the import whatever the source (ADR 0055, addendum 2026-11-16). Before
 * anything is read, the source's own way: the MCP steps where the app makes the agents itself, the request and its
 * answer where it doesn't, the ways of an app on the person's computer (the command, its own agent through MCP, or
 * the request) as a list that opens each one's steps,
 * where to download the file for another workspace, and a drop zone and a paste field for a file or link from any
 * app. Then who is coming and the arrival, the same for all. The crossing on top follows along: the team waits in the
 * desert, walks while the person looks at what comes, and is here once it's made. The reading, the plan and the apply
 * are the flow's own, so closing the sheet at any point leaves the same import on the page.
 */
export function ImportSheet({
  flow,
  sheet,
  orgId,
  onClose,
  standalone,
  todos,
}: {
  flow: ImportFlowState;
  /** What the sheet is open for; null keeps it closed. */
  sheet: ImportSheetKind | null;
  orgId: string;
  onClose: () => void;
  /** On the workspace's own pages: the sheet applies, and links to what came. */
  standalone: boolean;
  /** What to set up afterwards, as the preview lists it. */
  todos: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  // What was last open stays on the sheet while it closes.
  const last = useRef<ImportSheetKind>("file");
  if (sheet) last.current = sheet;
  const shown = sheet ?? last.current;
  const apply = useMutation({ mutationFn: () => flow.apply(), meta: { silent: true } });
  // Choosing what comes, a step at a time, once there is a plan.
  const choice = useChoiceSheet({ flow, standalone, todos, apply, onClose });
  const card = shown === "file" ? null : shown;
  const { mcp, method, paths } = useImportMethod(flow, orgId, card);
  const client = card ? mcpClient(card) : undefined;

  const planned = flow.planned;
  // The MCP steps of an app that makes the agents here itself: what it made since they showed.
  const viaMcp = !planned && method === "mcp" && mcp?.available === true && client !== undefined;
  const arrived = viaMcp ? flow.arrived : [];
  const stage = planned ? (flow.report ? "here" : "go") : arrived.length > 0 ? "here" : "wait";
  const names = new Intl.ListFormat(i18n.language, { style: "long", type: "conjunction" });
  const app = card === null ? "" : isComputerCard(card) ? computerApp(card) : cardName(t, card);

  let title =
    shown === "file"
      ? t("onboarding.import.sheet.fileTitle")
      : shown === "agenteschat"
        ? t("onboarding.import.sheet.workspaceTitle")
        : shown === "other"
          ? t("onboarding.import.sheet.otherTitle")
          : t("onboarding.import.sheet.title", { app });
  let body: ReactNode = null;
  let foot: ReactNode = null;
  // A way an app on the computer offers among others: Back goes to the list of them.
  const back =
    isComputerCard(card) && (paths?.length ?? 0) > 1 ? (
      <DialogFooter>
        <Button size="lg" block icon="chevronLeft" onClick={() => flow.setMethod(card, null)}>
          {t("common.back")}
        </Button>
      </DialogFooter>
    ) : null;
  const loading = (
    <p className="imp-sheet__wait" role="status">
      <Spinner />
    </p>
  );

  if (!planned) {
    if (viaMcp && mcp && client && card && arrived.length > 0) {
      title = t("onboarding.import.aiApp.arrived", { count: arrived.length });
      body = (
        <>
          <McpWatch flow={flow} />
          <p className="imp-sheet__text">
            {card === "other"
              ? t("onboarding.import.sheet.arrivedMoreAny")
              : t("onboarding.import.sheet.arrivedMore", { app })}
          </p>
          <ul className="imp-team">
            {arrived.map((a) => (
              <li key={a.id} className="ac-mediarow ac-mediarow--row">
                <span className="ac-mediarow__face">
                  <AgentAvatar name={a.name} appearance={normalizeAppearance(a.appearance)} size="sm" />
                </span>
                <span className="ac-mediarow__head">
                  <b>
                    {standalone ? (
                      <Link
                        to="/org/$orgId/agents/$agentId"
                        params={{ orgId, agentId: a.id }}
                        className="imp-team__link"
                      >
                        {a.name}
                      </Link>
                    ) : (
                      a.name
                    )}
                  </b>
                  {a.role && <span className="ac-mediarow__meta">{a.role}</span>}
                </span>
              </li>
            ))}
          </ul>
          <Waiting flow={flow} more />
        </>
      );
      foot = (
        <DialogFooter>
          {standalone ? (
            <Button asChild variant="primary" size="lg" block>
              <Link to="/org/$orgId/team" params={{ orgId }}>
                {t("onboarding.import.sheet.see")}
              </Link>
            </Button>
          ) : (
            <Button variant="primary" size="lg" block onClick={onClose}>
              {t("common.continue")}
            </Button>
          )}
        </DialogFooter>
      );
    } else if (viaMcp && mcp && client && card) {
      if (isComputerCard(card)) title = t("onboarding.import.sheet.paths.mcp.title", { app });
      body = (
        <>
          <McpWatch flow={flow} />
          <McpAsk flow={flow} card={card} app={app} client={client} url={mcp.url} prompt={mcp.prompt} />
        </>
      );
      foot = isComputerCard(card) ? (
        back
      ) : (
        <DialogFooter>
          <p className="imp-sheet__alt">
            <button type="button" className="ac-link" onClick={() => flow.setMethod(card, "prompt")}>
              {t("onboarding.import.sheet.useRequest")}
            </button>
          </p>
        </DialogFooter>
      );
    } else if (isComputerCard(card)) {
      if (paths === null) body = loading;
      else if (method === null) {
        body = <PathList app={app} paths={paths} onPick={(path) => flow.setMethod(card, path)} />;
      } else if (method === "prompt") {
        title = t("onboarding.import.sheet.paths.prompt.title", { app });
        body = <RequestAsk flow={flow} card={card} app={app} note={null} />;
        foot = back;
      } else {
        if (back) title = t("onboarding.import.sheet.paths.command.title");
        body = <ComputerAsk flow={flow} card={card} app={app} />;
        foot = back;
      }
    } else if (shown === "file") {
      body = <FileAsk flow={flow} />;
    } else if (shown === "agenteschat") {
      body = <WorkspaceAsk flow={flow} orgId={orgId} />;
    } else if (isRequestCard(shown)) {
      if (method === null) body = loading;
      else {
        body = (
          <RequestAsk flow={flow} card={shown} app={app} note={client && mcp && !mcp.available ? mcp.note : null} />
        );
        if (client && mcp?.available) {
          foot = (
            <DialogFooter>
              <p className="imp-sheet__alt">
                <button type="button" className="ac-link" onClick={() => flow.setMethod(shown, "mcp")}>
                  {defaultMethod(shown, true) === "mcp"
                    ? t("onboarding.import.sheet.backToMcp")
                    : t("onboarding.import.method.mcp")}
                </button>
              </p>
            </DialogFooter>
          );
        }
      }
    }
  } else {
    const { bundle } = planned;

    if (choice) {
      ({ title, body, foot } = choice);
    } else if (flow.report) {
      const made = flow.report.filter((i) => i.action === "create" || i.action === "update");
      const here = made.filter((i) => i.kind === "agent").map((i) => i.label);
      const missed = flow.report.filter((i) => i.action === "skip").length;
      const copy = flow.copy;
      title = t("onboarding.import.sheet.arrivedTitle");
      body = (
        <>
          <p className="imp-sheet__text">
            {here.length > 0
              ? t("onboarding.import.sheet.arrived", { count: here.length, names: names.format(here) })
              : t("onboarding.import.sheet.arrivedOther", { count: made.length })}
          </p>
          {copy?.running && (
            <div className="imp-copy" role="status">
              <div className="imp-copy__line">
                <span className="ac-iconline">
                  <Spinner />
                  <b>{t("onboarding.import.sheet.copying")}</b>
                </span>
                <span className="imp-copy__count">
                  {t("onboarding.import.sheet.copyCount", { done: copy.done, total: copy.total })}
                </span>
              </div>
              <div className="imp-copy__bar">
                <i style={{ width: `${copy.total > 0 ? Math.round((copy.done / copy.total) * 100) : 0}%` }} />
              </div>
              <span className="small muted">{t("onboarding.import.sheet.keepOpen")}</span>
            </div>
          )}
          {copy && !copy.running && (copy.result?.copied ?? 0) > 0 && (
            <p className="imp-note ac-iconline">
              <Icon name="drive" size={16} />
              <span>{t("onboarding.import.files.done", { count: copy.result?.copied ?? 0 })}</span>
            </p>
          )}
          {missed > 0 && (
            <p className="imp-note ac-iconline">
              <Icon name="info" size={16} />
              <span>{t("onboarding.import.sheet.missed", { count: missed })}</span>
            </p>
          )}
          {bundle.todo.length > 0 && (
            <div className="imp-sheet__group">
              <p className="imp-sheet__sub">{t("onboarding.import.sheet.after")}</p>
              {todos}
            </div>
          )}
        </>
      );
      foot = (
        <DialogFooter>
          <Button variant="primary" size="lg" block onClick={onClose}>
            {t("onboarding.import.sheet.see")}
          </Button>
        </DialogFooter>
      );
    }
  }

  return (
    <Dialog
      open={sheet !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={title}
      closeLabel={t("common.close")}
      width={520}
      bare
      className="hosting-sheet imp-sheet"
    >
      <div className="hosting-sheet__hero">
        <JourneyScene journey={stage} at={choice?.at} />
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon="close"
          className="hosting-sheet__close"
          aria-label={t("common.close")}
          onClick={onClose}
        />
      </div>
      <p className="hosting-sheet__title" aria-hidden="true">
        {title}
      </p>
      <DialogBody className="hosting-sheet__body imp-sheet__body">{body}</DialogBody>
      {foot}
    </Dialog>
  );
}

/** A numbered step (a MediaRow): its number and title on one line, what to do under them at the row's full width. */
function Step({ n, title, children }: { n: number; title: ReactNode; children?: ReactNode }) {
  return (
    <li className="ac-mediarow ac-mediarow--row">
      <span className="ac-mediarow__face">
        <span className="imp-do__n" aria-hidden="true">
          {n}
        </span>
      </span>
      <span className="ac-mediarow__head">
        <b>{title}</b>
      </span>
      {children && <div className="ac-mediarow__body">{children}</div>}
    </li>
  );
}

/** A file being read or planned, with the way to stop waiting. */
function Reading({ flow }: { flow: ImportFlowState }) {
  const { t } = useTranslation();
  return (
    <div className="imp-reading">
      <span className="imp-reading__text" role="status">
        <Spinner />
        {flow.busy === "planning" ? t("onboarding.import.planning") : t("onboarding.import.reading")}
      </span>
      <Button size="sm" variant="ghost" onClick={flow.cancel}>
        {t("common.cancel")}
      </Button>
    </div>
  );
}

/** Where a file is dropped or picked (a folder too, with `folder`), read as soon as it lands. */
function DropZone({
  flow,
  title,
  help,
  multiple = false,
  folder = false,
}: {
  flow: ImportFlowState;
  title: string;
  help: string;
  multiple?: boolean;
  folder?: boolean;
}) {
  const { t } = useTranslation();
  const area = useFocusOn<HTMLButtonElement>(flow, "drop");
  const [over, setOver] = useState(false);
  const files = useRef<HTMLInputElement>(null);
  const dir = useRef<HTMLInputElement>(null);
  const picked = (list: FileList | null) => {
    const chosen = Array.from(list ?? []);
    if (chosen.length) void flow.read({ files: chosen });
  };
  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a drop target; the buttons inside are the keyboard way */}
      <div
        className="imp-drop"
        data-over={over || undefined}
        onDragOver={(e) => {
          if (!hasFiles(e.dataTransfer)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setOver(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
        }}
        onDrop={(e) => {
          if (!hasFiles(e.dataTransfer)) return;
          e.preventDefault();
          setOver(false);
          void flow.read({ files: droppedFiles(e.dataTransfer) });
        }}
      >
        <button ref={area} type="button" className="imp-drop__area" onClick={() => files.current?.click()}>
          <Icon name="upload" />
          <b>{over ? t("onboarding.import.dropping") : title}</b>
          <span>{help}</span>
        </button>
        {folder && (
          <Button size="sm" variant="ghost" icon="drive" onClick={() => dir.current?.click()}>
            {t("onboarding.import.pickFolder")}
          </Button>
        )}
      </div>
      <input
        ref={files}
        type="file"
        multiple={multiple}
        hidden
        accept={IMPORT_ACCEPT}
        aria-label={t("onboarding.import.fileLabel")}
        onChange={(e) => {
          picked(e.target.files);
          e.target.value = "";
        }}
      />
      {folder && (
        <input
          ref={dir}
          type="file"
          multiple
          hidden
          aria-label={t("onboarding.import.folderLabel")}
          // biome-ignore lint/suspicious/noExplicitAny: non-standard attribute React doesn't type
          {...({ webkitdirectory: "" } as any)}
          onChange={(e) => {
            picked(e.target.files);
            e.target.value = "";
          }}
        />
      )}
    </>
  );
}

/** A link or an app's answer, pasted: an answer is read at once, a link with Enter or Ler. */
function PasteInput({
  flow,
  placeholder,
  label,
}: {
  flow: ImportFlowState;
  placeholder: string;
  /** Its name, where no field label says it. */
  label?: string;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const busy = flow.busy !== null;
  const submit = (value: string) => {
    const v = value.trim();
    if (!v || busy) return;
    void flow.read(/^https?:\/\//i.test(v) ? { url: v } : { text: v });
  };
  return (
    <AffixInput
      value={text}
      placeholder={placeholder}
      aria-label={label}
      autoComplete="off"
      spellCheck={false}
      disabled={busy}
      onChange={(e) => setText(e.target.value)}
      onPaste={(e) => {
        // A pasted reply is read right away, line breaks and all (a one-line field would drop them).
        const pasted = e.clipboardData.getData("text");
        if (!pasted.trim() || /^\s*https?:\/\//i.test(pasted)) return;
        e.preventDefault();
        setText("");
        submit(pasted);
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        submit(text);
      }}
      action={
        <Button variant="ghost" size="sm" onClick={() => submit(text)} disabled={!text.trim() || busy}>
          {t("onboarding.import.readPasted")}
        </Button>
      }
    />
  );
}

/** A request to paste in another app: selected whole on focus, and a copy button that says when it couldn't. */
function RequestBox({
  text,
  label,
  copy: copyLabel,
  copied: copiedText,
}: {
  text: string;
  label: string;
  copy: string;
  copied: string;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied("ok");
    } catch {
      setCopied("failed");
    }
  };
  return (
    <>
      <Textarea
        readOnly
        rows={4}
        value={text}
        aria-label={label}
        className="imp-other__prompt imp-do__text"
        onFocus={(e) => e.currentTarget.select()}
      />
      <div className="imp-other__copy">
        <Button onClick={() => void copy()}>
          <SwapLabel icon="copy" altIcon="check" label={copyLabel} alt={t("common.copied")} showAlt={copied === "ok"} />
        </Button>
        <span role="status" className="small muted">
          {copied === "ok" ? copiedText : copied === "failed" ? t("onboarding.import.request.copyFailed") : ""}
        </span>
      </div>
    </>
  );
}

/** Watches for the agents the app makes through MCP while its steps, or what came, show. */
function McpWatch({ flow }: { flow: ImportFlowState }) {
  const { watch } = flow;
  useEffect(watch, [watch]);
  return null;
}

/**
 * Waiting for the agents the app makes: what to check once a while passes with nothing, or why they can't be read,
 * with the way to read them again. `more`: some came, and more may.
 */
function Waiting({ flow, more = false }: { flow: ImportFlowState; more?: boolean }) {
  const { t, i18n } = useTranslation();
  const [late, setLate] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setLate(true), STUCK_MS);
    return () => clearTimeout(timer);
  }, []);
  if (flow.watchError)
    return (
      <div className="imp-failure">
        <Alert>{errorText(t, flow.watchError, i18n.language)}</Alert>
        <Button size="sm" icon="refresh" onClick={flow.rewatch}>
          {t("common.retry")}
        </Button>
      </div>
    );
  return (
    <div className="imp-arrivals">
      <p className="imp-arrivals__line ac-iconline" role="status">
        <Spinner />
        <span>{more ? t("onboarding.import.sheet.waitingMore") : t("onboarding.import.aiApp.waiting")}</span>
      </p>
      {late && !more && (
        <p className="small muted">{t("onboarding.import.aiApp.stuck", { access: t("apps.consent.manage") })}</p>
      )}
    </div>
  );
}

/** The app's own steps to connect this server's MCP, numbered, then the request that has it make the agents. */
function McpAsk({
  flow,
  card,
  app,
  client,
  url,
  prompt,
}: {
  flow: ImportFlowState;
  card: ImportCard;
  /** The app's name in a sentence. */
  app: string;
  client: NonNullable<ReturnType<typeof mcpClient>>;
  url: string;
  prompt: string;
}) {
  const { t } = useTranslation();
  const guide = client.guide(url);
  const steps = guide.steps.filter((s) => !s.install);
  return (
    <>
      <p className="imp-sheet__text">
        {card === "other"
          ? t("onboarding.import.aiApp.leadAny")
          : card === "chatgpt-dots"
            ? t("onboarding.import.aiApp.leadDots")
            : t("onboarding.import.aiApp.lead", { app })}
      </p>
      {guide.lead && <p className="small muted">{t(`apps.dialog.${guide.lead}`)}</p>}
      <GuideInstalls steps={guide.steps} />
      <ol className="imp-do">
        {steps.map((s, i) => (
          <Step key={`${s.text}${s.code ?? ""}`} n={i + 1} title={<GuideWords step={s} />}>
            <GuideExtras step={s} client={client} url={url} />
          </Step>
        ))}
        <Step n={steps.length + 1} title={t("onboarding.import.aiApp.paste")}>
          <RequestBox
            text={prompt}
            label={t("onboarding.import.aiApp.promptLabel")}
            copy={t("onboarding.import.aiApp.copy")}
            copied={t("onboarding.import.aiApp.copied")}
          />
        </Step>
      </ol>
      <GuideNotes notes={guide.notes} />
      {card === "other" && (
        <span className="imp-do__alt">
          <HelpLink slug="apps-de-ia" section="connect">
            {t("onboarding.import.aiApp.howTo")}
          </HelpLink>
        </span>
      )}
      <Waiting flow={flow} />
    </>
  );
}

/**
 * The export request to paste in the app, then what it gives back: Grok Bot answers in its chat (pasted here), a dot
 * makes a file (dropped here), any other app (and one on the computer, asked in a chat with one of its agents) either.
 * `note`: why MCP isn't offered, where the app takes it.
 */
function RequestAsk({
  flow,
  card,
  app,
  note,
}: {
  flow: ImportFlowState;
  card: RequestCard | ComputerCard;
  /** The app's name in a sentence. */
  app: string;
  note: string | null;
}) {
  const { t } = useTranslation();
  const words = isComputerCard(card) ? "computer" : card;
  const copied = isComputerCard(card) ? "other" : card;
  return (
    <>
      {words !== "other" && (
        <p className="imp-sheet__text">{t(`onboarding.import.sheet.request.${words}.lead`, { app })}</p>
      )}
      <ol className="imp-do">
        <Step n={1} title={t(`onboarding.import.sheet.request.${words}.copyStep`, { app })}>
          <RequestBox
            text={EXPORT_PROMPT}
            label={t("onboarding.import.request.prompt")}
            copy={t("onboarding.import.request.copy")}
            copied={t(`onboarding.import.request.${copied}.copied`)}
          />
          {card === "other" && (
            <span className="imp-do__alt">
              <HelpLink slug="import" section="other-apps">
                {t("onboarding.import.request.where")}
              </HelpLink>
            </span>
          )}
        </Step>
        <Step n={2} title={t(`onboarding.import.sheet.request.${words}.answerStep`)}>
          {flow.busy !== null ? (
            <Reading flow={flow} />
          ) : (
            <>
              {card !== "grok-bot" && (
                <DropZone
                  flow={flow}
                  title={t("onboarding.import.sheet.drop")}
                  help={t("onboarding.import.dropHelp")}
                />
              )}
              {words !== "chatgpt-dots" && (
                <PasteInput
                  flow={flow}
                  label={t(`onboarding.import.sheet.request.${words}.answerStep`)}
                  placeholder={t(`onboarding.import.sheet.request.${words}.answerPlaceholder`, { app })}
                />
              )}
            </>
          )}
        </Step>
      </ol>
      {flow.failure && <ImportFailureNote failure={flow.failure} retry={flow.retry} />}
      {note && (
        <p className="imp-note ac-iconline">
          <Icon name="info" size={16} />
          <span>{note}</span>
        </p>
      )}
      <p className="imp-note ac-iconline">
        <Icon name="lock" size={16} />
        <span>{t("onboarding.import.sheet.readHere")}</span>
      </p>
    </>
  );
}

/** What each way of an app on the computer looks like in its list. */
const PATH_ICON: Record<ImportMethod, IconName> = { command: "code", mcp: "plug", prompt: "message" };

/**
 * An app on the computer's ways, each a row that opens its steps: what it brings and what it needs on its line, the
 * command (the one that brings the most) first.
 */
function PathList({
  app,
  paths,
  onPick,
}: {
  app: string;
  paths: readonly ImportMethod[];
  onPick: (path: ImportMethod) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <p className="imp-sheet__text">{t("onboarding.import.sheet.paths.lead")}</p>
      <OptionLinks
        className="imp-paths"
        options={paths.map((path) => ({
          value: path,
          leading: (
            <span className="ac-brand ac-brand--sm ac-brand--mono" aria-hidden="true">
              <Icon name={PATH_ICON[path]} size={16} />
            </span>
          ),
          title: t(`onboarding.import.sheet.paths.${path}.title`, { app }),
          tag: path === "command" ? t("onboarding.import.sheet.paths.best") : undefined,
          description: t(`onboarding.import.sheet.paths.${path}.line`),
          onSelect: () => onPick(path),
        }))}
      />
      <p className="imp-note ac-iconline">
        <Icon name="lock" size={16} />
        <span>{t("onboarding.import.sheet.paths.safe", { app })}</span>
      </p>
    </>
  );
}

/** Another agentes.chat workspace: where its file is downloaded (one click away when it's on this server), then the file. */
function WorkspaceAsk({ flow, orgId }: { flow: ImportFlowState; orgId: string }) {
  const { t } = useTranslation();
  const orgs = useMe().data?.organizations ?? [];
  const others = orgs.filter((o) => o.id !== orgId && can(o, "create_agents"));
  const other = others.length === 1 ? others[0] : undefined;
  return (
    <>
      <ol className="imp-do">
        <Step n={1} title={t("onboarding.import.sheet.workspace.download")}>
          <span className="imp-do__hint">{t("onboarding.import.sheet.workspace.where")}</span>
          {other && (
            <Link
              className="ac-link imp-do__alt"
              to="/org/$orgId/settings/$section"
              params={{ orgId: other.id, section: "import" }}
              search={{}}
              target="_blank"
            >
              {t("onboarding.import.sheet.workspace.open", { org: other.name })}
            </Link>
          )}
        </Step>
        <Step n={2} title={t("onboarding.import.sheet.workspace.drop")}>
          {flow.busy !== null ? (
            <Reading flow={flow} />
          ) : (
            <DropZone flow={flow} title={t("onboarding.import.sheet.drop")} help={t("onboarding.import.dropHelp")} />
          )}
        </Step>
      </ol>
      {flow.failure && <ImportFailureNote failure={flow.failure} retry={flow.retry} />}
    </>
  );
}

/** A file, a folder or a link from any app, recognized on its own. */
function FileAsk({ flow }: { flow: ImportFlowState }) {
  const { t } = useTranslation();
  return (
    <>
      <p className="imp-sheet__text">{t("onboarding.import.sheet.fileLead")}</p>
      {flow.busy !== null ? (
        <Reading flow={flow} />
      ) : (
        <>
          <DropZone
            flow={flow}
            multiple
            folder
            title={t("onboarding.import.drop")}
            help={t("onboarding.import.dropHelp")}
          />
          <Field label={t("onboarding.import.paste")} id="import-paste">
            <PasteInput flow={flow} placeholder={t("onboarding.import.pastePlaceholder")} />
          </Field>
        </>
      )}
      {flow.failure && <ImportFailureNote failure={flow.failure} retry={flow.retry} />}
      {/* What a person needs before dropping a folder that holds keys: said on the line, the rest in its ⓘ. */}
      <p className="imp-note ac-iconline">
        <Icon name="lock" size={16} />
        <span className="ac-hintline">
          <span>{t("onboarding.import.privacy")}</span>
          <InfoHint name={t("common.about", { label: t("onboarding.import.privacyLabel") })}>
            {t("onboarding.import.privacyMore")}
          </InfoHint>
        </span>
      </p>
    </>
  );
}

/** An app on the person's computer: the request to paste (or the command), then the file dropped here. */
function ComputerAsk({ flow, card, app }: { flow: ImportFlowState; card: ComputerCard; app: string }) {
  const { t } = useTranslation();
  const [os, setOs] = useState<ComputerOs>(() =>
    computerOs(typeof navigator === "undefined" ? "" : navigator.platform),
  );
  const [byHand, setByHand] = useState(false);
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);
  const text = byHand
    ? migrateCommand(window.location.origin, card, os)
    : migratePrompt(window.location.origin, card, os);
  // The mark goes back to "Copiar" on its own, and at once when what there is to copy changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `text` is what resets it
  useEffect(() => setCopied(null), [text]);
  useEffect(() => {
    if (copied !== "ok") return;
    const timer = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied("ok");
    } catch {
      setCopied("failed");
    }
  };
  return (
    <>
      <p className="imp-sheet__text">
        {t(byHand ? "onboarding.import.sheet.leadCommand" : "onboarding.import.sheet.lead", { app })}
      </p>
      <ol className="imp-do">
        <Step
          n={1}
          title={
            byHand
              ? t(
                  os === "windows"
                    ? "onboarding.import.sheet.pastePowerShell"
                    : "onboarding.import.sheet.pasteTerminal",
                )
              : t("onboarding.import.sheet.pasteAssistant")
          }
        >
          <Textarea
            readOnly
            rows={byHand ? 2 : 4}
            value={text}
            aria-label={t(byHand ? "onboarding.import.sheet.commandLabel" : "onboarding.import.sheet.promptLabel")}
            className="imp-other__prompt imp-do__text"
            data-command={byHand || undefined}
            onFocus={(e) => e.currentTarget.select()}
          />
          <div className="imp-other__copy">
            <Button onClick={() => void copy()}>
              <SwapLabel
                icon="copy"
                altIcon="check"
                label={t(byHand ? "common.copy" : "onboarding.import.sheet.copy")}
                alt={t("common.copied")}
                showAlt={copied === "ok"}
              />
            </Button>
            <Segmented
              label={t("onboarding.import.sheet.os.label")}
              value={os}
              onValueChange={setOs}
              options={[
                { value: "unix", label: t("onboarding.import.sheet.os.unix") },
                { value: "windows", label: t("onboarding.import.sheet.os.windows") },
              ]}
            />
          </div>
          <span role="status" className="imp-do__hint">
            {copied === "failed"
              ? t("onboarding.import.request.copyFailed")
              : byHand
                ? t("onboarding.import.sheet.commandHelp")
                : t("onboarding.import.sheet.assistants")}
          </span>
          <button type="button" className="ac-link imp-do__alt" onClick={() => setByHand(!byHand)}>
            {t(byHand ? "onboarding.import.sheet.usePrompt" : "onboarding.import.sheet.useCommand")}
          </button>
        </Step>
        <Step n={2} title={t("onboarding.import.sheet.dropStep")}>
          {flow.busy !== null ? (
            <Reading flow={flow} />
          ) : (
            <DropZone
              flow={flow}
              title={t("onboarding.import.sheet.drop")}
              help={t("onboarding.import.sheet.dropHelp", { file: migrateFile(card) })}
            />
          )}
        </Step>
      </ol>
      {flow.failure && <ImportFailureNote failure={flow.failure} retry={flow.retry} />}
      <p className="imp-note ac-iconline">
        <Icon name="lock" size={16} />
        <span>{t("onboarding.import.sheet.safe", { app })}</span>
      </p>
    </>
  );
}
