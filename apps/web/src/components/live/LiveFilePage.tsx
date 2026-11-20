import type { LiveKind, LiveRoomError, LiveSelection } from "@agenteschat/client";
import {
  ApiError,
  isLiveFileKind,
  useArtifact,
  useArtifactVersions,
  useFileConversation,
  useLivePeers,
  useRestoreLiveVersion,
  useSaveLiveVersion,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { clockHour, dayLabel, formatTime } from "@agenteschat/client/lib/format";
import type { Peer } from "@agenteschat/live/awareness";
import {
  Button,
  cx,
  Dialog,
  DialogBody,
  EmptyState,
  Kbd,
  modKey,
  Skeleton,
  SkeletonGroup,
  typingInField,
  useMatchMedia,
} from "@agenteschat/ui";
import { useNavigate } from "@tanstack/react-router";
import { type ComponentType, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDeleteArtifact } from "@/components/artifacts/ArtifactActions";
import { useFileShare } from "@/components/artifacts/ShareDialog";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useDocumentTitle } from "@/lib/desktop";
import { useToast } from "@/lib/toast";
import { Canvas } from "./canvas";
import { canvasShortcuts } from "./canvas/tools";
import { DocumentEditor } from "./document";
import { documentShortcuts } from "./document/shortcuts";
import type { LiveAskRequest, LiveEditorProps, LiveEditorSearch, LiveReveal } from "./editor";
import {
  FileConversationButton,
  FileConversationPanel,
  LIVE_TALK_DOCKED,
  useFileAgent,
  useFileTalkColumn,
  useFileTalkLive,
} from "./FileConversation";
import { LiveHeader } from "./LiveHeader";
import { FollowingIsland, usePeerLooks } from "./peers";
import { usePageRoom } from "./room";
import { Slides } from "./slides";
import { Spreadsheet } from "./spreadsheet";
import {
  FileAgentContext,
  type FileTalk,
  FileTalkContext,
  LiveAskContext,
  selectionKey,
  takeRevealOnOpen,
} from "./talk";
import { useLiveRoomWeb, useLiveVersionRoom } from "./useLiveRoomWeb";
import { SaveVersionDialog, VersionsPanel } from "./VersionsPanel";
import "./live.css";
import "./covers.css";

/** The page's address: a version to look at (`v`), and the editor's own (a sheet, a slide, presenting, a message). */
export interface LiveFileSearch extends LiveEditorSearch {
  v?: number;
}

/**
 * Under this window width the header keeps its faces and glyphs and the rest goes into ⋯ (ADR 0196 §9); a page made
 * narrow by the conversation beside it folds the same way (`usePageRoom`).
 */
export const LIVE_COMPACT_QUERY = "(max-width: 760px)";

/** The editor of each kind; a kind this build has none for says so instead of opening. */
const EDITORS: Partial<Record<LiveKind, ComponentType<LiveEditorProps>>> = {
  spreadsheet: Spreadsheet,
  slides: Slides,
  canvas: Canvas,
  document: DocumentEditor,
};

/**
 * A spreadsheet, a presentation, a canvas or a document (ADR 0200) on a page of the app (ADR 0196 §9, ADR 0199): the
 * sidebar stays, the header (`LiveHeader`: where it lives, who is here, Compartilhar, Apresentar, ⋯, the conversation's
 * toggle, the title, who made it and who sees it) over the kind's editor, and the file's own conversation beside it,
 * the page keeping its width so it never covers the file. What the person selects in the file shows over that
 * conversation's composer and rides on the next message; a message's line about part of the file selects it here. The
 * page opens the file's room, says when it is offline or read-only, shows a saved version read-only in place (`?v=`),
 * and keeps whom the person follows.
 */
export function LiveFilePage({
  fileId,
  search,
  onSearch,
}: {
  fileId: string;
  search: LiveFileSearch;
  onSearch: (patch: Partial<LiveFileSearch>) => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const toast = useToast();
  const dir = useDirectory(org.id);
  const compact = useMatchMedia(LIVE_COMPACT_QUERY);
  const wide = useMatchMedia(LIVE_TALK_DOCKED);
  const query = useArtifact(org.id, fileId);
  const artifact = query.data;
  const kind: LiveKind | null = artifact && isLiveFileKind(artifact.kind) ? artifact.kind : null;
  const live = useLiveRoomWeb(org.id, fileId, { kind });
  const version = useLiveVersionRoom(org.id, fileId, search.v, kind);
  const peers = useLivePeers(live.room);
  const looks = usePeerLooks();
  const pageRef = useRef<HTMLDivElement | null>(null);
  // The page's element as state too: its width is watched once it is there (`usePageRoom`).
  const [pageEl, setPageEl] = useState<HTMLDivElement | null>(null);
  const placePage = useCallback((el: HTMLDivElement | null) => {
    pageRef.current = el;
    setPageEl(el);
  }, []);
  const [selection, setSelection] = useState<LiveSelection | null>(null);
  const [versionsOpen, setVersionsOpen] = useState(() => Boolean(search.v));
  const [saveOpen, setSaveOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [followId, setFollowId] = useState<number | null>(null);
  const save = useSaveLiveVersion(org.id, fileId);
  const restore = useRestoreLiveVersion(org.id, fileId);
  const share = useFileShare();
  const remover = useDeleteArtifact(() => void navigate({ to: "/org/$orgId/drive", params: { orgId: org.id } }));
  // The window's title in the desktop app (its Window menu, Mission Control) and the browser's tab: the file's name.
  useDocumentTitle(artifact?.title);

  // Not a live file (an old link, a file that changed kind): the Drive's viewer shows it.
  useEffect(() => {
    if (!artifact || isLiveFileKind(artifact.kind)) return;
    void navigate({
      to: "/org/$orgId/drive",
      params: { orgId: org.id },
      search: { artifact: artifact.id },
      replace: true,
    });
  }, [artifact, navigate, org.id]);

  // What the server refused while the person edits, said once each time.
  useEffect(() => {
    const room = live.room;
    if (!room) return;
    const words: Partial<Record<LiveRoomError, string>> = {
      too_large: t("live.shell.errors.tooLarge"),
      rate: t("live.shell.errors.rate"),
      read_only: t("live.shell.errors.readOnly"),
      invalid: t("live.shell.errors.invalid"),
    };
    return room.onError((code) => {
      const text = words[code];
      if (text) toast.show(text, code === "rate" ? "info" : "error");
    });
  }, [live.room, t, toast]);

  // Whom the person follows: their presence says so, and the island shows while they are here.
  const following = followId === null ? null : (peers.find((p) => p.clientId === followId) ?? null);
  const followedName = useRef<string | null>(null);
  if (following) followedName.current = looks(following.user).name;
  useEffect(() => {
    live.room?.setLocal({ following: followId ?? undefined });
  }, [live.room, followId]);
  useEffect(() => {
    if (followId === null || following || live.status !== "live") return;
    // They left the file.
    if (followedName.current) toast.show(t("live.shell.presence.left", { name: followedName.current }), "info");
    followedName.current = null;
    setFollowId(null);
  }, [followId, following, live.status, toast, t]);
  const follow = useCallback((peer: Peer | null) => setFollowId(peer ? peer.clientId : null), []);
  const stopFollowing = useCallback(() => setFollowId(null), []);

  const readOnlyNow = live.loaded && live.mode === "view";
  const previewing = search.v !== undefined;
  const canChange = Boolean(artifact) && !readOnlyNow && !previewing;
  const openSave = useCallback(() => {
    if (canChange) setSaveOpen(true);
  }, [canChange]);

  // ⌘S saves a version (free in the desktop app); ? shows the shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        openSave();
        return;
      }
      if (e.key === "?" && !e.metaKey && !e.ctrlKey && !typingInField(e.target)) {
        if (document.querySelector('[role="dialog"], [role="menu"]')) return;
        e.preventDefault();
        setKeysOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openSave]);

  // Presenting: the page takes the screen inside the click (a browser allows it only there); leaving the screen leaves
  // presenting, and leaving presenting gives the screen back.
  const present = () => {
    const el = pageRef.current;
    if (el && !document.fullscreenElement) el.requestFullscreen?.().catch(() => {});
    onSearch({ present: true });
  };
  const presenting = Boolean(search.present);
  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement && presenting) onSearch({ present: undefined });
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [presenting, onSearch]);
  useEffect(() => {
    if (!presenting && document.fullscreenElement && document.fullscreenElement === pageRef.current) {
      void document.exitFullscreen?.().catch(() => {});
    }
  }, [presenting]);

  // ── The file's conversation (ADR 0199) ────────────────────────────────────────────────────────────────────────

  // On its way to the Drive's viewer (not a live file): its socket was refused, which says nothing about the file.
  const leaving = Boolean(artifact) && !kind;
  const column = useFileTalkColumn(artifact);
  const talkOpen = column.open && Boolean(artifact && kind) && !presenting;
  const docked = talkOpen && wide;
  // Its own width decides the header's folding (the conversation beside it takes its part) and, docked, whether the
  // sidebar folds to its rail to give the file room.
  const pageRoom = usePageRoom(pageEl, docked);
  const folded = compact || pageRoom.narrow;
  const at = useFileConversation(org.id, artifact ?? { id: fileId, conversation: null }, talkOpen);
  const fileAgent = useFileAgent(artifact);
  // "Conversa N" follows the conversation with the panel closed too.
  useFileTalkLive(fileId, artifact?.conversation?.channelId ?? at?.channelId);
  // A link or a notice named one of its messages: the conversation opens there.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per message named; the column's state is read then
  useEffect(() => {
    if (search.m && !column.open) column.toggle();
  }, [search.m]);
  const closeTalk = () => (column.sheet ? column.closeSheet() : column.toggle());

  // What the person selected, as the quote over the composer: until they drop it (or a message carries it), and never
  // the cell a spreadsheet simply opens on.
  const [dropped, setDropped] = useState<string | null>(null);
  const [asked, setAsked] = useState<{ selection: LiveSelection | null } | null>(null);
  // The editor shown (the file, or a saved version): each one's first selection is where it opened.
  const editorKey = previewing ? `v${search.v}` : "live";
  const opened = useRef<string | null>(null);
  const onSelection = useCallback(
    (next: LiveSelection | null) => {
      setSelection(next);
      if (opened.current === editorKey || !next) return;
      opened.current = editorKey;
      if (kind === "spreadsheet") setDropped(selectionKey(next));
    },
    [kind, editorKey],
  );
  const selected = selectionKey(selection);
  // Another selection: what was asked about before ("Variações" on one picture) gives way to it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the selection's key stands for it
  useEffect(() => setAsked(null), [selected]);
  const about = previewing ? null : asked ? asked.selection : selection && selected !== dropped ? selection : null;
  const [prefill, setPrefill] = useState<{ text: string; key: number } | null>(null);
  const [reveal, setReveal] = useState<LiveReveal | null>(null);
  // A message's line elsewhere opened this file at part of it.
  useEffect(() => {
    const waiting = takeRevealOnOpen(fileId);
    if (waiting) setReveal({ selection: waiting, key: Date.now() });
  }, [fileId]);

  /** "Pedir ao Atlas", "Variações": the conversation opens with the agent's @ and the words, about the selection. */
  const ask = useCallback(
    (request: LiveAskRequest = {}) => {
      const agent =
        request.agentId === null ? null : request.agentId ? (dir.agentById.get(request.agentId) ?? null) : fileAgent;
      const words = [agent ? `@${agent.handle}` : "", request.text?.trim() ?? ""].filter(Boolean).join(" ");
      if (words) setPrefill({ text: `${words} `, key: Date.now() });
      // A request about something in particular; else what is selected now rides along, even after its ×.
      if (request.selection !== undefined) setAsked({ selection: request.selection });
      else setDropped(null);
      if (!column.open) column.toggle();
    },
    [dir.agentById, fileAgent, column],
  );

  const talk = useMemo<FileTalk | null>(
    () =>
      artifact && kind
        ? {
            artifactId: artifact.id,
            kind,
            title: artifact.title,
            rootId: at?.rootId ?? null,
            about,
            dropAbout: () => {
              setAsked(null);
              setDropped(selected);
            },
            prefill,
            tookPrefill: () => setPrefill(null),
            reveal: (part) => setReveal({ selection: part, key: Date.now() }),
          }
        : null,
    [artifact, kind, at?.rootId, about, selected, prefill],
  );

  const notFound =
    (query.isError && query.error instanceof ApiError && (query.error.status === 404 || query.error.status === 403)) ||
    (!leaving && live.status === "closed" && (live.error === "not_found" || live.error === "forbidden"));
  if (notFound) {
    return (
      <div className="lf-page lf-page--empty">
        <EmptyState
          size="page"
          icon="file"
          title={t("live.shell.notFound.title")}
          actions={
            <Button
              variant="primary"
              onClick={() => void navigate({ to: "/org/$orgId/drive", params: { orgId: org.id } })}
            >
              {t("live.shell.notFound.back")}
            </Button>
          }
        />
      </div>
    );
  }
  if (query.isError || (!leaving && live.status === "closed" && live.error !== null && !live.loaded)) {
    return (
      <div className="lf-page lf-page--empty">
        <EmptyState
          size="page"
          icon="alert"
          title={t("live.shell.failed.title")}
          actions={
            <Button
              onClick={() => {
                void query.refetch();
                live.room?.checkAlive();
              }}
            >
              {t("live.shell.failed.retry")}
            </Button>
          }
        >
          {query.isError ? errorText(t, query.error, i18n.language) : t("live.shell.failed.body")}
        </EmptyState>
      </div>
    );
  }

  const room = previewing ? version.room : live.room;
  const ready = Boolean(artifact && kind && room && (previewing ? version.room : live.loaded));
  const Editor = kind ? (EDITORS[kind] ?? null) : null;
  return (
    <FileTalkContext.Provider value={talk}>
      <FileAgentContext.Provider value={fileAgent}>
        <LiveAskContext.Provider value={previewing ? null : ask}>
          <div
            ref={placePage}
            className={cx("lf-page", presenting && "lf-page--presenting")}
            data-kind={kind ?? undefined}
            data-compact={folded || undefined}
            data-talk={docked || undefined}
          >
            {!presenting && (
              <LiveHeader
                artifact={artifact ?? null}
                kind={kind}
                live={live}
                previewing={previewing}
                compact={folded}
                peers={peers}
                followId={followId}
                onFollow={follow}
                talk={
                  artifact && kind ? (
                    <FileConversationButton
                      artifact={artifact}
                      open={talkOpen}
                      compact={folded}
                      onToggle={column.toggle}
                    />
                  ) : null
                }
                onShare={() => artifact && share.open(artifact)}
                onCopyLink={() => artifact && share.copyLink(artifact)}
                onPresent={present}
                onVersions={() => setVersionsOpen((o) => !o)}
                onSave={openSave}
                onShortcuts={() => setKeysOpen(true)}
                onDelete={() => artifact && remover.ask(artifact)}
              />
            )}
            <div className="lf-body">
              <div className="lf-stage">
                {previewing && artifact && (
                  <VersionBanner
                    fileId={fileId}
                    version={search.v ?? 0}
                    canRestore={!readOnlyNow}
                    busy={restore.isPending}
                    onRestore={() => {
                      const v = search.v;
                      if (!v) return;
                      restore.mutate(v, {
                        onSuccess: () => {
                          toast.show(t("live.shell.versions.restored", { version: v }));
                          onSearch({ v: undefined });
                        },
                        onError: (error) => toast.show(errorText(t, error, i18n.language), "error"),
                      });
                    }}
                    onBack={() => onSearch({ v: undefined })}
                  />
                )}
                {following && !previewing && !presenting && <FollowingIsland peer={following} onStop={stopFollowing} />}
                {previewing && version.failed ? (
                  <EmptyState
                    size="panel"
                    icon="alert"
                    title={t("live.shell.versions.openFailed")}
                    actions={<Button onClick={version.retry}>{t("live.shell.versions.retry")}</Button>}
                  />
                ) : ready && kind && !Editor ? (
                  <EmptyState size="panel" icon="file" title={t("live.shell.notHere")} />
                ) : ready && Editor && room && artifact ? (
                  <div className="lf-editor" data-kind={kind}>
                    <Editor
                      key={editorKey}
                      room={room}
                      orgId={org.id}
                      artifact={artifact}
                      readOnly={previewing || readOnlyNow}
                      locale={i18n.language}
                      search={search}
                      onSearch={onSearch}
                      following={previewing ? null : following}
                      onStopFollowing={stopFollowing}
                      onSelection={onSelection}
                      onAsk={previewing ? undefined : ask}
                      reveal={previewing ? null : reveal}
                      onVersions={() => setVersionsOpen((o) => !o)}
                    />
                  </div>
                ) : (
                  <EditorSkeleton
                    kind={kind}
                    label={previewing ? t("live.shell.versions.opening") : t("live.shell.loading")}
                  />
                )}
              </div>
              {versionsOpen && artifact && !presenting && (
                <VersionsPanel
                  artifact={artifact}
                  room={live.room}
                  shown={search.v}
                  onShow={(v) => onSearch({ v })}
                  onSave={openSave}
                  canSave={!readOnlyNow}
                  onClose={() => {
                    setVersionsOpen(false);
                    if (previewing) onSearch({ v: undefined });
                  }}
                />
              )}
            </div>
            {talkOpen && artifact && kind && (
              <FileConversationPanel
                kind={kind}
                rootId={at?.rootId ?? null}
                docked={docked}
                focusMessageId={search.m}
                onClose={closeTalk}
              />
            )}
            <SaveVersionDialog
              open={saveOpen}
              busy={save.isPending}
              onClose={() => setSaveOpen(false)}
              onSave={(name) =>
                save.mutate(name || null, {
                  onSuccess: (done) => {
                    setSaveOpen(false);
                    toast.show(
                      done.version === null ? t("live.shell.versions.nothingNew") : t("live.shell.versions.saved"),
                    );
                  },
                  onError: (error) => toast.show(errorText(t, error, i18n.language), "error"),
                })
              }
            />
            <ShortcutsDialog open={keysOpen} kind={kind} onClose={() => setKeysOpen(false)} />
            {remover.dialog}
            {share.dialog}
          </div>
        </LiveAskContext.Provider>
      </FileAgentContext.Provider>
    </FileTalkContext.Provider>
  );
}

/** "Versão de 14:32 · Restaurar esta versão · Voltar à atual", over a saved version shown read-only. */
function VersionBanner({
  fileId,
  version,
  canRestore,
  busy,
  onRestore,
  onBack,
}: {
  fileId: string;
  version: number;
  canRestore: boolean;
  busy: boolean;
  onRestore: () => void;
  onBack: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const versions = useArtifactVersions(org.id, fileId);
  const at = versions.data?.find((v) => v.version === version)?.createdAt;
  const today = at ? dayLabel(t, i18n.language, at) === t("common.today") : false;
  const when = at
    ? today
      ? formatTime(i18n.language, at)
      : new Intl.DateTimeFormat(i18n.language, {
          day: "numeric",
          month: "short",
          hour: clockHour(i18n.language),
          minute: "2-digit",
        }).format(new Date(at))
    : null;
  return (
    <div className="lf-banner" role="status">
      <span className="lf-banner__words">
        {when ? t("live.shell.versions.viewing", { when }) : t("live.shell.versions.number", { version })}
      </span>
      <span className="lf-banner__acts">
        {canRestore && (
          <Button size="sm" variant="primary" loading={busy} disabled={busy} onClick={onRestore}>
            {t("live.shell.versions.restore")}
          </Button>
        )}
        <Button size="sm" onClick={onBack}>
          {t("live.shell.versions.back")}
        </Button>
      </span>
    </div>
  );
}

/** Loading: the editor's own shape (a grid, a slide and its rail, a dotted plane), never a spinner alone. */
function EditorSkeleton({ kind, label }: { kind: LiveKind | null; label: string }) {
  return (
    <SkeletonGroup label={label} className={cx("lf-skel", kind && `lf-skel--${kind}`)}>
      {kind === "slides" ? (
        <>
          <span className="lf-skel__rail">
            <Skeleton shape="block" className="lf-skel__thumb" />
            <Skeleton shape="block" className="lf-skel__thumb" />
            <Skeleton shape="block" className="lf-skel__thumb" />
          </span>
          <span className="lf-skel__stage">
            <Skeleton shape="block" className="lf-skel__slide" />
          </span>
        </>
      ) : kind === "canvas" ? (
        <span className="lf-skel__plane">
          <Skeleton shape="block" className="lf-skel__dock" />
        </span>
      ) : kind === "document" ? (
        <>
          <span className="lf-skel__bar" />
          <span className="lf-skel__page">
            <Skeleton shape="block" width="55%" height={44} />
            <Skeleton shape="block" width="40%" height={16} />
            <Skeleton shape="block" width="100%" height={14} />
            <Skeleton shape="block" width="92%" height={14} />
            <Skeleton shape="block" width="96%" height={14} />
          </span>
        </>
      ) : (
        <>
          <span className="lf-skel__bar">
            <Skeleton shape="block" width="40%" height={24} />
          </span>
          <span className="lf-skel__grid" />
        </>
      )}
    </SkeletonGroup>
  );
}

/** The keys of the page and of its editor ("?" opens it, or ⋯ › Keyboard shortcuts). */
function ShortcutsDialog({ open, kind, onClose }: { open: boolean; kind: LiveKind | null; onClose: () => void }) {
  const { t } = useTranslation();
  const mod = modKey();
  const general: [string, string[]][] = [
    [t("live.shell.shortcuts.undo"), [mod, "Z"]],
    [t("live.shell.shortcuts.redo"), [mod, "⇧", "Z"]],
    [t("live.shell.shortcuts.saveVersion"), [mod, "S"]],
    [t("live.shell.shortcuts.show"), ["?"]],
    [t("live.shell.shortcuts.stopFollowing"), ["Esc"]],
  ];
  const own: Partial<Record<LiveKind, { title: string; keys: [string, string[]][] }>> = {
    spreadsheet: {
      title: t("live.shell.shortcuts.spreadsheet"),
      keys: [
        [t("live.shell.shortcuts.edit"), ["F2"]],
        [t("live.shell.shortcuts.confirm"), ["↵"]],
        [t("live.shell.shortcuts.cancel"), ["Esc"]],
        [t("live.shell.shortcuts.nextCell"), ["Tab"]],
        [t("live.shell.shortcuts.bold"), [mod, "B"]],
        [t("live.shell.shortcuts.italic"), [mod, "I"]],
        [t("live.shell.shortcuts.fillDown"), [mod, "D"]],
        [t("live.shell.shortcuts.clear"), ["⌫"]],
        [t("live.shell.shortcuts.selectAll"), [mod, "A"]],
      ],
    },
    slides: {
      title: t("live.shell.shortcuts.slides"),
      keys: [
        [t("live.shell.shortcuts.duplicate"), [mod, "D"]],
        [t("live.shell.shortcuts.remove"), ["⌫"]],
        [t("live.shell.shortcuts.nudge"), ["←", "→"]],
        [t("live.shell.shortcuts.bold"), [mod, "B"]],
        [t("live.shell.shortcuts.italic"), [mod, "I"]],
      ],
    },
    canvas: { title: t("live.shell.shortcuts.canvas"), keys: canvasShortcuts(t, mod) },
    document: { title: t("live.doc.keys.title"), keys: documentShortcuts(t, mod) },
  };
  const mine = kind ? own[kind] : undefined;
  // The editor's own keys first (what the person came to look up), then the page's.
  const groups = [...(mine ? [mine] : []), { title: t("live.shell.shortcuts.general"), keys: general }];
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("live.shell.shortcuts.title")}
      closeLabel={t("common.close")}
      width={440}
    >
      {/* The dialog's body: its padding, and the one part that scrolls when the list is taller than the window. */}
      <DialogBody className="lf-keys">
        {groups.map((g) => (
          <section key={g.title} className="lf-keys__group">
            <h3 className="lf-keys__title">{g.title}</h3>
            <dl className="lf-keys__list">
              {g.keys.map(([what, keys]) => (
                <div key={what} className="lf-keys__row">
                  <dt className="lf-keys__what">{what}</dt>
                  <dd className="lf-keys__keys">
                    {keys.map((k) => (
                      <Kbd key={k}>{k}</Kbd>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </DialogBody>
    </Dialog>
  );
}
