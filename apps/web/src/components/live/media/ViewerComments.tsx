import type { ArtifactDetail, FileMediaKind, LiveSelection } from "@agenteschat/client";
import { keys, useApi, useFileConversation, useThreadMessages } from "@agenteschat/client";
import { MAX_PREVIEW_BYTES } from "@agenteschat/client/lib/files";
import { formatPercent } from "@agenteschat/client/lib/format";
import { Button, cx } from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { type MouseEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileView, usePreviewUrl } from "@/components/artifacts/FileView";
import { ImageZoom } from "@/components/artifacts/ImageZoom";
import { useOrg } from "@/components/org-context";
import { STORAGE_KEYS, storage } from "@/lib/storage";
import { ChannelSkeleton } from "@/pages/ChannelPage";
import { ThreadPage } from "@/pages/ThreadPage";
import type { LiveAskRequest } from "../editor";
import { TalkGrip, useFileAgent, useFileTalkLive } from "../FileConversation";
import { FileAgentContext, type FileTalk, FileTalkContext, LiveAskContext, takeRevealOnOpen } from "../talk";
import { DraftMark } from "./DraftMark";
import { MediaPins } from "./MediaPins";
import { type Mark, type MarkPictures, mediaPinsOf, type StageMarks, takeMarkPictures } from "./marks";
import { PdfStage } from "./PdfStage";
import { type StagePad, type VideoHandle, VideoStage } from "./VideoStage";
import "./media.css";

/*
 * A picture's, a video's or a PDF's comments in the viewer (ADR 0208): its pins over the file, and "Comments" opens
 * the file's conversation (ADR 0199) as the viewer's right column. With it open, a press on the file marks it (a
 * point, or an area when dragged; a video at that moment, a PDF on that page) and the conversation's composer gets
 * "About area 4 of the image" with the app's picture of the place, which goes up only with the message. "Mark" on the
 * file's bar turns that off and on (kept per person): off, a press zooms, plays or scrolls as with the comments closed.
 */

type FileContent = Extract<ArtifactDetail["content"], { kind: "file" }>;

/** A comment being written: what it points at, the app's pictures of the place (sent with it), and its own key. */
interface Draft {
  selection: LiveSelection;
  thumb: string | null;
  pictures: MarkPictures | null;
  key: number;
}

/** A message waits at most this long for its pictures to go up; past it, it goes without them. */
const PICTURES_WAIT_MS = 8_000;
/** A PDF's zoom steps (1 = its pages as wide as the stage allows). */
const PDF_STEPS = [0.75, 1, 1.25, 1.5, 2, 3];
/** The video's frame in the stage; with the bar over it, the frame starts under the bar. */
const VIDEO_PAD: StagePad = { x: 24, top: 24, bottom: 24 };
const VIDEO_PAD_BAR: StagePad = { x: 24, top: 68, bottom: 24 };

export interface ViewerCommentsParts {
  /** The file with its pins, where the viewer shows a file. */
  stage: ReactNode;
  /** The conversation, as the viewer's right column; null while closed. */
  panel: ReactNode;
}

export function ViewerComments({
  artifact,
  media,
  open,
  onOpen,
  at,
  onSwipe,
  onLeave,
  children,
}: {
  artifact: ArtifactDetail;
  media: FileMediaKind;
  open: boolean;
  onOpen: (open: boolean) => void;
  /** A comment to open at (the chat's line, a link to it). */
  at?: string | undefined;
  /** A picture of a message's set: a finger's sideways swipe moves to the next or previous one. */
  onSwipe?: ((dir: 1 | -1) => void) | undefined;
  /** A link in the conversation leads elsewhere: the viewer gives way. */
  onLeave: () => void;
  children: (parts: ViewerCommentsParts) => ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const fileId = artifact.id;
  const version = artifact.shownVersion;
  const content = artifact.content.kind === "file" ? artifact.content : null;

  // ── The conversation (ADR 0199), made on first opening ───────────────────────────────────────────────────────
  const made = useFileConversation(org.id, artifact, open);
  const talkRef = artifact.conversation ?? made ?? null;
  useFileTalkLive(fileId, talkRef?.channelId);
  const fileAgent = useFileAgent(artifact);
  const messages = useThreadMessages(org.id, talkRef?.channelId, talkRef?.rootId ?? "");
  // With the conversation closed nothing else reads it: a new message there (the count moves) reads it again.
  const counted = useRef(artifact.conversation?.count);
  useEffect(() => {
    const talk = artifact.conversation;
    if (!talk || counted.current === talk.count) return;
    counted.current = talk.count;
    void qc.invalidateQueries({ queryKey: keys.thread(org.id, talk.channelId, talk.rootId), exact: true });
  }, [qc, org.id, artifact.conversation]);
  const pins = useMemo(() => mediaPinsOf(messages.data ?? [], fileId, version), [messages.data, fileId, version]);

  const [showResolved, setShowResolved] = useState(false);
  const [markOn, setMarkOn] = useState(() => storage.get(STORAGE_KEYS.fileMarking) !== "0");
  const marking = open && markOn;
  const [focusId, setFocusId] = useState<string | null>(at ?? null);
  // The message the conversation scrolls to (set again to scroll there again).
  const [jump, setJump] = useState<string | undefined>(at);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dragging, setDragging] = useState<Mark | null>(null);
  const [draftPage, setDraftPage] = useState<number | undefined>(undefined);
  const [zoom, setZoom] = useState(1);
  const [pageNow, setPageNow] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [prefill, setPrefill] = useState<{ text: string; key: number } | null>(null);
  const video = useRef<VideoHandle | null>(null);
  // The viewer's body the conversation is a column of: its handle sets the column's width there.
  const [body, setBody] = useState<HTMLElement | null>(null);
  const placeGrip = useCallback((el: HTMLElement | null) => setBody(el?.parentElement ?? null), []);

  // The draft's picture goes with it.
  useEffect(() => {
    const thumb = draft?.thumb;
    return () => {
      if (thumb) URL.revokeObjectURL(thumb);
    };
  }, [draft?.thumb]);
  // Closed, nothing is being written: a comment left half made goes with it.
  useEffect(() => {
    if (open) return;
    setDraft(null);
    setDraftPage(undefined);
  }, [open]);

  /** A pin was pressed: the conversation opens at its message, and a video goes to its moment. */
  const openPin = useCallback(
    (messageId: string) => {
      setFocusId(messageId);
      const pin = pins.find((p) => p.message.id === messageId);
      if (pin?.selection.time !== undefined) video.current?.seek(pin.selection.time);
      onOpen(true);
      setJump(undefined);
      requestAnimationFrame(() => setJump(messageId));
    },
    [pins, onOpen],
  );

  /** A message's line about this file: its pin, its moment, its page. */
  const reveal = useCallback(
    (part: LiveSelection) => {
      const pin = pins.find(
        (p) =>
          (part.crop && p.selection.crop === part.crop) ||
          (JSON.stringify(p.selection.mark) === JSON.stringify(part.mark) &&
            p.selection.time === part.time &&
            p.selection.page === part.page),
      );
      if (pin) {
        setFocusId(pin.message.id);
        setJump(pin.message.id);
      }
      if (part.time !== undefined) {
        video.current?.pause();
        video.current?.seek(part.time);
      }
    },
    [pins],
  );
  // A message's line elsewhere opened this file at part of it: the comments open there.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once the comments are read
  useEffect(() => {
    if (!messages.data) return;
    const waiting = takeRevealOnOpen(fileId);
    if (!waiting) return;
    onOpen(true);
    reveal(waiting);
  }, [fileId, Boolean(messages.data)]);

  /** "Ask Iris": the conversation opens with the agent's @. */
  const ask = useCallback(
    (request: LiveAskRequest = {}) => {
      const agent = request.agentId === null ? null : fileAgent;
      const words = [agent ? `@${agent.handle}` : "", request.text?.trim() ?? ""].filter(Boolean).join(" ");
      if (words) setPrefill({ text: `${words} `, key: Date.now() });
      onOpen(true);
    },
    [fileAgent, onOpen],
  );

  /**
   * A mark on the file: the composer gets it at once ("About area 4 of the image") with the app's two pictures of the
   * place, which go up only with the message (`prepareAbout`): a comment dropped stores nothing.
   */
  const comment = useCallback(
    async (
      mark: Mark | null,
      picture: { source: CanvasImageSource; width: number; height: number } | null,
      extra: { time?: number; page?: number },
    ) => {
      const key = Date.now();
      const selection: LiveSelection = {
        label: String(pins.length + 1),
        ...(mark ? { mark } : {}),
        ...extra,
        version,
      };
      setDraft({ selection, thumb: null, pictures: null, key });
      setDraftPage(extra.page);
      setFocusId(null);
      onOpen(true);
      if (!mark || !picture) return;
      const pictures = await takeMarkPictures(picture.source, picture.width, picture.height, mark);
      if (!pictures) return;
      const thumb = URL.createObjectURL(pictures.crop);
      setDraft((d) => (d?.key === key ? { ...d, thumb, pictures } : d));
    },
    [pins.length, version, onOpen],
  );

  // The draft as the send reads it (the conversation calls `prepareAbout` as the message goes).
  const draftNow = useRef<Draft | null>(null);
  draftNow.current = draft;
  /** The comment's pictures go up as its message goes; it goes without them when they can't (the agent reads the file). */
  const prepareAbout = useCallback(
    async (about: LiveSelection): Promise<LiveSelection> => {
      const pictures = draftNow.current?.pictures;
      if (!pictures || about.crop) return about;
      const upload = Promise.all([
        api.live.uploadMark(org.id, fileId, pictures.crop),
        api.live.uploadMark(org.id, fileId, pictures.frame),
      ]).then(([crop, frame]) => ({ ...about, crop: crop.id, frame: frame.id }));
      const late = new Promise<LiveSelection>((resolve) => setTimeout(() => resolve(about), PICTURES_WAIT_MS));
      return Promise.race([upload, late]).catch(() => about);
    },
    [api, org.id, fileId],
  );

  const dropAbout = useCallback(() => {
    setDraft(null);
    setDraftPage(undefined);
  }, []);
  const tookPrefill = useCallback(() => setPrefill(null), []);
  const talk = useMemo<FileTalk>(
    () => ({
      artifactId: fileId,
      kind: media,
      title: artifact.title,
      rootId: talkRef?.rootId ?? null,
      about: draft?.selection ?? null,
      aboutThumb: draft?.thumb ?? null,
      dropAbout,
      prepareAbout,
      prefill,
      tookPrefill,
      reveal,
    }),
    [fileId, media, artifact.title, talkRef?.rootId, draft, dropAbout, prepareAbout, prefill, tookPrefill, reveal],
  );

  const onHandle = useCallback((h: VideoHandle | null) => {
    video.current = h;
  }, []);

  // ── The file with its pins ───────────────────────────────────────────────────────────────────────────────────
  const marks: StageMarks = {
    pins,
    focusId,
    showResolved,
    draft: draft?.selection.mark
      ? { mark: draft.selection.mark, n: Number(draft.selection.label) || pins.length + 1 }
      : null,
    draftPage,
    tool: marking ? "comment" : "move",
    onOpenPin: openPin,
  };
  const resolvedCount = pins.filter((p) => p.resolved).length;
  const resolved =
    resolvedCount > 0 ? (
      <Button
        size="sm"
        variant="ghost"
        icon={showResolved ? "eye" : "eyeOff"}
        aria-pressed={showResolved}
        title={t(showResolved ? "files.comments.hideResolved" : "files.comments.showResolved")}
        onClick={() => setShowResolved((v) => !v)}
      >
        {t("files.comments.resolvedCount", { count: resolvedCount })}
      </Button>
    ) : null;
  const markTool = open ? (
    <Button
      size="sm"
      variant="ghost"
      icon="comment"
      aria-pressed={markOn}
      title={t(markOn ? "files.comments.markOff" : "files.comments.markOn")}
      onClick={() => {
        storage.set(STORAGE_KEYS.fileMarking, markOn ? "0" : "1");
        setMarkOn(!markOn);
      }}
    >
      {t("files.comments.mark")}
    </Button>
  ) : null;
  const tools =
    markTool || resolved ? (
      <>
        {markTool}
        {resolved}
      </>
    ) : null;
  const hint = marking ? t(`files.comments.hint.${media}` as "files.comments.hint.image") : null;
  const fileUrl = api.artifacts.fileUrl(org.id, fileId, { version });

  let stage: ReactNode = null;
  if (content && media === "image") {
    stage = (
      <ImageCommentStage
        artifact={artifact}
        content={content}
        marks={marks}
        hint={hint}
        tools={tools}
        dragging={dragging}
        onDraft={setDragging}
        onSwipe={onSwipe}
        onMark={(mark, el) => void comment(mark, { source: el, width: el.naturalWidth, height: el.naturalHeight }, {})}
      />
    );
  } else if (content && media === "video") {
    const bar = Boolean(hint || tools);
    stage = (
      <div className="file-view file-view--image mf-viewstage">
        <VideoStage
          src={fileUrl}
          handoff={fileId}
          name={content.name}
          marks={marks}
          pad={bar ? VIDEO_PAD_BAR : VIDEO_PAD}
          onHandle={onHandle}
          onMark={(mark, time, el) =>
            void comment(
              mark,
              { source: el, width: el.videoWidth, height: el.videoHeight },
              { time: Math.round(time * 10) / 10 },
            )
          }
        />
        {bar && <StageBar hint={hint} tools={tools} top />}
      </div>
    );
  } else if (content) {
    const step = (dir: 1 | -1) =>
      setZoom((z) => {
        const i = PDF_STEPS.findIndex((s) => s >= z - 1e-6);
        return PDF_STEPS[Math.max(0, Math.min(PDF_STEPS.length - 1, (i < 0 ? PDF_STEPS.length - 1 : i) + dir))] ?? 1;
      });
    stage = (
      <div className="file-view file-view--image mf-viewstage mf-viewstage--pdf">
        <PdfStage
          src={fileUrl}
          zoom={zoom}
          marks={marks}
          onPages={setPageCount}
          onPage={setPageNow}
          onMark={(mark, page, canvas) =>
            void comment(mark, { source: canvas, width: canvas.width, height: canvas.height }, { page })
          }
        />
        <StageBar
          hint={hint}
          tools={
            <>
              {tools}
              {pageCount > 0 && (
                <span className="mf-pages-now tabular">
                  {t("files.comments.pageOf", { page: pageNow, count: pageCount })}
                </span>
              )}
              <Button
                size="sm"
                variant="ghost"
                iconOnly
                icon="dash"
                aria-label={t("files.zoom.out")}
                title={t("files.zoom.out")}
                disabled={zoom <= (PDF_STEPS[0] ?? 1)}
                onClick={() => step(-1)}
              />
              <Button size="sm" variant="ghost" className="izoom__level tabular" onClick={() => setZoom(1)}>
                {formatPercent(i18n.language, Math.round(zoom * 100))}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                iconOnly
                icon="plus"
                aria-label={t("files.zoom.in")}
                title={t("files.zoom.in")}
                disabled={zoom >= (PDF_STEPS[PDF_STEPS.length - 1] ?? 3)}
                onClick={() => step(1)}
              />
            </>
          }
        />
      </div>
    );
  }

  // ── The conversation, as the viewer's right column ──────────────────────────────────────────────────────────
  // A link in it (where the file was posted, a message's place) leads away from the viewer, which gives way.
  const onClickCapture = (e: MouseEvent<HTMLElement>) => {
    const link = (e.target as HTMLElement).closest("a[href]");
    if (link && link.getAttribute("target") !== "_blank") onLeave();
  };
  // Its left edge sizes it, as a live file's conversation does (the same width, kept per person).
  const panel = open ? (
    <>
      {body && <TalkGrip work={body} className="lf-talk-grip--viewer" />}
      <aside
        ref={placeGrip}
        className="viewer-talk"
        aria-label={t(`live.conversation.title.${media}` as "live.conversation.title.file")}
        onClickCapture={onClickCapture}
      >
        {talkRef?.rootId ? (
          <ThreadPage
            threadId={talkRef.rootId}
            focusMessageId={jump}
            onClose={() => onOpen(false)}
            escInside
            headless
          />
        ) : (
          <ChannelSkeleton thread panel />
        )}
      </aside>
    </>
  ) : null;

  return (
    <FileTalkContext.Provider value={talk}>
      <FileAgentContext.Provider value={fileAgent}>
        <LiveAskContext.Provider value={ask}>{children({ stage, panel })}</LiveAskContext.Provider>
      </FileAgentContext.Provider>
    </FileTalkContext.Provider>
  );
}

/**
 * A picture in the viewer with its comments: its zoom as ever, its pins over it (their words on hover while the
 * comments are closed) and, with them open, a press marks it. Too big to preview, or failing to load: the file's own
 * view, with no pins.
 */
function ImageCommentStage({
  artifact,
  content,
  marks,
  hint,
  tools,
  dragging,
  onDraft,
  onSwipe,
  onMark,
}: {
  artifact: ArtifactDetail;
  content: FileContent;
  marks: StageMarks;
  hint: string | null;
  tools: ReactNode;
  dragging: Mark | null;
  onDraft: (mark: Mark | null) => void;
  onSwipe?: ((dir: 1 | -1) => void) | undefined;
  onMark: (mark: Mark, picture: HTMLImageElement) => void;
}) {
  const { t } = useTranslation();
  const canPreview = content.size <= MAX_PREVIEW_BYTES;
  const { url, failed } = usePreviewUrl(artifact.id, artifact.shownVersion, content.contentType, canPreview);
  if (!canPreview || failed) {
    return (
      <FileView
        content={content}
        artifactId={artifact.id}
        version={artifact.shownVersion}
        title={artifact.title}
        onSwipe={onSwipe}
      />
    );
  }
  const marking = marks.tool === "comment" && hint ? { hint, onMark, onDraft } : undefined;
  return (
    <div className="file-view file-view--image">
      <ImageZoom
        key={url}
        src={url}
        alt={t("files.imageAlt", { title: artifact.title })}
        onSwipe={marking ? undefined : onSwipe}
        overlay={
          <>
            <MediaPins
              pins={marks.pins}
              focusId={marks.focusId}
              showResolved={marks.showResolved}
              peek={!marking}
              onOpen={marks.onOpenPin}
            />
            {dragging ? <DraftMark mark={dragging} /> : marks.draft && <DraftMark {...marks.draft} />}
          </>
        }
        marking={marking}
        tools={tools}
      />
    </div>
  );
}

/** The bar over a video's or a PDF's stage, the picture's own (ImageZoom's): what a press does, then its tools. */
function StageBar({ hint, tools, top = false }: { hint: string | null; tools: ReactNode; top?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className={cx("izoom__bar mf-bar", top && "mf-bar--top")}>
      {hint && <p className="izoom__hint small muted">{hint}</p>}
      {tools && (
        <div className="izoom__tools ac-acts" role="toolbar" aria-label={t("files.zoom.toolbar")}>
          {tools}
        </div>
      )}
    </div>
  );
}
