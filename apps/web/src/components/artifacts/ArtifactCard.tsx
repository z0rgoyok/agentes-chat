import type { Artifact, ArtifactContent, ArtifactFileContent, ArtifactRef } from "@agenteschat/client";
import { isLiveFileKind, useArtifact } from "@agenteschat/client";
import { documentStart, KIND_ICON, parseDelimited, patchCounts } from "@agenteschat/client/lib/artifacts";
import {
  extensionOf,
  fileIcon,
  formatBytes,
  hasThumbnail,
  isCodeName,
  pictureRatio,
  previewKind,
  previewKindOfName,
} from "@agenteschat/client/lib/files";
import { Button, Icon, type IconName, Menu, Tip } from "@agenteschat/ui";
import { useNavigate } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { type CSSProperties, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { useArtifactViewer } from "@/components/artifacts/viewer-context";
import { ChoicesCard } from "@/components/blocks/ChoicesCard";
import { LiveBlockCard } from "@/components/blocks/LiveBlock";
import { PollCard } from "@/components/blocks/PollCard";
import { MenuEntries } from "@/components/DesktopMenus";
import { LiveCover } from "@/components/live/LiveCover";
import { openLivePage } from "@/components/live/open";
import { useOrg } from "@/components/org-context";
import { canCopyImage, contextMenuHandler, copyImage, type MenuEntry } from "@/lib/context-menu";
import { Markdown } from "@/lib/markdown";
import { useToast } from "@/lib/toast";
import { useArtifactDownload, useDeleteArtifact } from "./ArtifactActions";
import { FileVideo, MAX_THUMB_BYTES, usePreviewUrl } from "./FileView";
import { HtmlFrame } from "./HtmlFrame";
import { MermaidDiagram } from "./Mermaid";
import { PdfCover } from "./PdfCover";
import { useFileShare } from "./ShareDialog";

/** What a cover shows of a table, a code change or a text file: the rest is in the viewer. */
const COVER_ROWS = 5;
const COVER_COLUMNS = 3;
const COVER_FILES = 4;
const COVER_LINES = 12;
/** The start of a document drawn on its cover (cut at a line, never mid-word). */
const COVER_CHARS = 1200;

/**
 * An attachment on a message as a tile of one size, so several sit side by side: what it holds drawn small on top
 * (its cover: the start of a document, a table's first rows, a change's files, a diagram, a page, a PDF's first
 * page) and its name with its kind and size under it. A click opens the viewer; Download and More show over the cover
 * on hover, and the desktop app's right click has the same actions. A picture is only the picture, as is a video its
 * player: their name and size are in their tip and in the viewer's header. A picture alone on its message shows whole inside its tile
 * (CSS: `.artifact-cards > :only-child`), in its own proportions when its size is known (`pictureRatio`). Every tile
 * has its size before what it holds loads (`LoadingTile`). A picture or a video whose card carries its file's facts
 * (`quickFile`) draws from them at once, while its details load. `alone`: the only one on its message, drawn bigger.
 */
export function ArtifactCard({ artifact: ref, alone = false }: { artifact: ArtifactRef; alone?: boolean }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const viewer = useArtifactViewer();
  const download = useArtifactDownload();
  const share = useFileShare();
  const remove = useDeleteArtifact();
  const toast = useToast();
  const query = useArtifact(org.id, ref.deleted ? null : ref.id, ref.version, undefined, true);
  const full = query.data;
  const a = full ?? quickFile(ref);
  const navigate = useNavigate();
  // A live file is the file as it is now (ADR 0196 §7), whichever version the message named: its head's preview.
  const live = Boolean(a && isLiveFileKind(a.kind));
  const head = useArtifact(org.id, live && ref.version ? ref.id : null).data;
  // Deleted (to the trash): a quiet placeholder, never a broken card.
  if (ref.deleted) {
    return (
      <div className="artifact-card artifact-card--removed" role="note">
        <Icon name="trash" size={16} />
        <span className="small muted">{t("artifacts.removedFile")}</span>
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="artifact-card artifact-card--missing">
        <span className="small muted">{t("artifacts.notFound")}</span>
      </div>
    );
  }
  if (!a) return <LoadingTile title={ref.title} ratio={pictureRatio(ref)} />;
  // What lives in the conversation isn't a file: the thing itself, not a tile that opens it (ADR 0113).
  if (a.kind === "block") return <LiveBlockCard id={a.id} version={ref.version ?? a.shownVersion} />;
  if (a.kind === "poll") return <PollCard id={a.id} version={a.shownVersion} />;
  if (a.kind === "choices") return <ChoicesCard id={a.id} version={a.shownVersion} />;
  // A live file opens on its own page, as it is now (ADR 0196 §9); the rest in the viewer, at the version they name.
  const open = () => {
    if (live) openLivePage(navigate, org.id, a.id);
    else viewer.open(a.id, full ? (a.shownVersion < a.version ? a.shownVersion : undefined) : a.shownVersion);
  };
  // A live file downloads as it is now (its versions are checkpoints behind it, ADR 0196 §7).
  const save = () => void download.save(a, undefined, live ? undefined : a.shownVersion, a.content);
  const picture = a.content.kind === "file" && previewKind(a.content.contentType) === "image";
  const copyPicture = () =>
    copyImage(
      api.artifacts.fileBlob(org.id, a.id, a.shownVersion),
      () => toast.show(t("contextMenu.imageCopied")),
      () => toast.show(t("contextMenu.copyImageFailed"), "error"),
    );
  // Open, download, Copiar imagem, Compartilhar, its link (through the share dialog while only its conversation sees it), and the
  // trash for who may delete it: the right click and the More menu.
  const actions = (): MenuEntry[] => [
    { kind: "item", id: "open", label: t("contextMenu.open"), icon: "eye", run: open },
    { kind: "item", id: "download", label: t("contextMenu.download"), icon: "download", run: save },
    ...(picture && canCopyImage()
      ? ([
          { kind: "item", id: "copy-image", label: t("contextMenu.copyImage"), icon: "image", run: copyPicture },
        ] as const)
      : []),
    // Sharing and deleting go by what the file's details say (who may, where it lives): only once they loaded.
    ...(full && full.inDrive !== false
      ? ([
          { kind: "item", id: "share", label: t("share.button"), icon: "personAdd", run: () => share.open(full) },
        ] as const)
      : []),
    ...(full
      ? ([
          {
            kind: "item",
            id: "copy-link",
            label: t("contextMenu.copyLink"),
            icon: "link",
            run: () => share.copyLink(full, full.shownVersion < full.version ? full.shownVersion : undefined),
          },
        ] as const)
      : []),
    ...(full?.canDelete
      ? ([
          { kind: "separator" },
          {
            kind: "item",
            id: "delete",
            label: t("artifacts.delete"),
            icon: "trash",
            danger: true,
            run: () => remove.ask(full),
          },
        ] as const)
      : []),
  ];
  const tile = (props: Pick<TileProps, "icon" | "meta" | "cover" | "media" | "ratio">) => (
    <>
      <Tile artifact={a} actions={actions} onOpen={open} onDownload={save} {...props} />
      {remove.dialog}
      {share.dialog}
    </>
  );
  const content = live ? (head?.content ?? a.content) : a.content;
  if (
    content.kind === "document" ||
    content.kind === "spreadsheet" ||
    content.kind === "slides" ||
    content.kind === "canvas"
  )
    return tile({
      icon: KIND_ICON[a.kind],
      meta: metaOf(t, content, a.shownVersion),
      cover: <LiveCover content={content} fileId={a.id} size="tile" />,
    });
  if (content.kind !== "file")
    return tile({
      icon: KIND_ICON[a.kind],
      meta: metaOf(t, content, a.shownVersion),
      cover: <Cover content={content} title={a.title} />,
    });
  const meta = fileMeta(content, formatBytes(i18n.language, content.size));
  const icon = fileIcon(content.name, content.contentType);
  const kind = previewKind(content.contentType);
  if (kind === "video")
    return (
      <>
        <FileVideo
          content={content}
          artifactId={a.id}
          version={a.shownVersion}
          onOpen={open}
          tip={`${a.title} · ${meta}`}
          actions={<TileActions title={a.title} actions={actions} onDownload={save} />}
          // A video this browser can't play is a file's tile.
          fallback={
            <Tile
              artifact={a}
              actions={actions}
              onOpen={open}
              onDownload={save}
              icon={icon}
              meta={meta}
              cover={<TypeCover content={content} />}
            />
          }
        />
        {remove.dialog}
        {share.dialog}
      </>
    );
  if (kind === "image" && (hasThumbnail(content.contentType) || content.size <= MAX_THUMB_BYTES))
    return tile({
      media: true,
      ratio: pictureRatio(content) ?? pictureRatio(ref),
      icon: "image",
      meta,
      cover: (
        <PictureCover content={content} artifactId={a.id} version={a.shownVersion} title={a.title} alone={alone} />
      ),
    });
  if (kind === "pdf")
    return tile({
      icon,
      meta,
      cover: (
        <PdfCover
          src={api.artifacts.fileUrl(org.id, a.id, { version: a.shownVersion })}
          label={t("files.pdfFrame", { title: a.title })}
          fallback={<TypeCover content={content} />}
        />
      ),
    });
  return tile({ icon, meta, cover: <FileCover content={content} /> });
}

/**
 * A tile before its file's details arrive, in the box it keeps once they do, so the rows around it never move: a
 * picture or a video by its name ("tela.png"), as the phone reads it; anything else a cover over its name, which wraps
 * as it will.
 */
function LoadingTile({ title = "", ratio }: { title?: string; ratio?: number }) {
  const kind = previewKindOfName(title);
  if (kind === "video")
    return (
      <div className="artifact-tile artifact-tile--loading" data-kind="video" aria-busy="true">
        <span className="ac-video ac-video--tile">
          <span className="ac-video__media" />
        </span>
      </div>
    );
  return (
    <div
      className="artifact-tile artifact-tile--loading"
      data-media={kind === "image" || undefined}
      {...(kind === "image" ? ratioProps(ratio) : {})}
      aria-busy="true"
    >
      <div className="artifact-tile__cover" />
      {kind !== "image" && (
        <div className="artifact-tile__foot ac-iconline" aria-hidden="true">
          <Icon name={fileIcon(title)} size={16} />
          <span className="artifact-tile__name">
            <span className="artifact-tile__title">{title || "\u00a0"}</span>
            <span className="artifact-tile__meta">{"\u00a0"}</span>
          </span>
        </div>
      )}
    </div>
  );
}

/** A tile in a picture's proportions: alone on its message it is that shape (CSS: `[data-ratio]`). */
const ratioProps = (ratio: number | undefined) =>
  ratio ? { "data-ratio": true, style: { "--ratio": String(ratio) } as CSSProperties } : {};

/** "PDF · 1,2 MB": the file's extension stands for its kind (no word to translate), then its size. */
function fileMeta(content: ArtifactFileContent, size: string) {
  const ext = extensionOf(content.name).toUpperCase();
  return ext ? `${ext} · ${size}` : size;
}

/** Under a tile's name: its kind and how big it is ("Tabela · 15 linhas", "5 arquivos · +58 −31", "Documento · v2"). */
function metaOf(t: TFunction, content: ArtifactContent, version: number) {
  const kind = t(`artifacts.kind.${content.kind}`);
  switch (content.kind) {
    case "table":
      return `${kind} · ${t("artifacts.rows", { count: content.rows.length })}`;
    case "diff": {
      const total = { added: 0, removed: 0 };
      for (const f of content.files) {
        const c = patchCounts(f.patch);
        total.added += c.added;
        total.removed += c.removed;
      }
      return `${t("artifacts.files", { count: content.files.length })} · ${t("artifacts.counts", total)}`;
    }
    // Live files (ADR 0196): how many sheets or slides; a canvas by its kind alone.
    case "spreadsheet":
      return content.preview.sheets > 1
        ? `${kind} · ${t("live.kinds.sheetCount", { count: content.preview.sheets })}`
        : kind;
    case "slides":
      return `${kind} · ${t("live.kinds.slideCount", { count: content.preview.count })}`;
    case "canvas":
    // A document is a live file (ADR 0200): no versions to count on its card.
    case "document":
      return kind;
    default:
      return `${kind} · ${t("artifacts.version", { version })}`;
  }
}

interface TileProps {
  artifact: Pick<Artifact, "kind" | "title">;
  icon: IconName;
  meta: string;
  cover: ReactNode;
  /** A picture: only the picture, its name and size in its tip; alone on its message it shows whole. */
  media?: boolean;
  /** A picture's width over its height: alone on its message, its tile takes that shape. */
  ratio?: number;
  actions: () => MenuEntry[];
  onOpen: () => void;
  onDownload: () => void;
}

function Tile({ artifact: a, icon, meta, cover, media, ratio, actions, onOpen, onDownload }: TileProps) {
  const { t } = useTranslation();
  const sizeId = useId();
  // The whole tile opens the viewer; the actions sit above it.
  const open = (
    <button
      type="button"
      className="artifact-tile__open"
      aria-label={t("artifacts.open", { title: a.title })}
      aria-describedby={media ? sizeId : undefined}
      onClick={onOpen}
    />
  );
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: right click only; the open button inside is the accessible way
    <div
      className="artifact-tile"
      data-kind={a.kind}
      data-media={media || undefined}
      {...(media ? ratioProps(ratio) : {})}
      onContextMenu={contextMenuHandler(() => [{ kind: "header", label: a.title }, ...actions()])}
    >
      {media ? (
        <Tip className="artifact-tile__tip" tip={`${a.title} · ${meta}`} look="ac-msg__tip">
          {open}
          <span id={sizeId} hidden>
            {meta}
          </span>
        </Tip>
      ) : (
        open
      )}
      <div className="artifact-tile__cover">{cover}</div>
      {!media && (
        <div className="artifact-tile__foot ac-iconline" aria-hidden="true">
          <Icon name={icon} size={16} />
          <span className="artifact-tile__name">
            <span className="artifact-tile__title">{a.title}</span>
            <span className="artifact-tile__meta tabular">{meta}</span>
          </span>
        </div>
      )}
      <span className="artifact-tile__acts">
        <TileActions title={a.title} actions={actions} onDownload={onDownload} />
      </span>
    </div>
  );
}

/** Download, then More (the right click's other actions), as small ghost buttons. */
function TileActions({
  title,
  actions,
  onDownload,
}: {
  title: string;
  actions: () => MenuEntry[];
  onDownload: () => void;
}) {
  const { t } = useTranslation();
  const label = t("artifacts.more", { title });
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        iconOnly
        icon="download"
        aria-label={t("artifacts.download")}
        title={t("artifacts.download")}
        onClick={onDownload}
      />
      <Menu
        align="end"
        label={label}
        trigger={
          <Button size="sm" variant="ghost" iconOnly icon="more" aria-label={label} title={t("artifacts.moreShort")} />
        }
      >
        <MenuEntries entries={actions().filter((e) => !(e.kind === "item" && e.id === "download"))} />
      </Menu>
    </>
  );
}

/** A document, table, code change, diagram or page, drawn small. */
function Cover({ content, title }: { content: ArtifactContent; title: string }) {
  const { t } = useTranslation();
  switch (content.kind) {
    case "table":
      return <CoverTable columns={content.columns} rows={content.rows} />;
    case "diff":
      return (
        <ul className="artifact-tile__files">
          {content.files.slice(0, COVER_FILES).map((f) => {
            const c = patchCounts(f.patch);
            return (
              <li key={f.path}>
                <code>
                  {f.path.includes("/") && (
                    <span className="artifact-tile__dir">{f.path.slice(0, f.path.lastIndexOf("/") + 1)}</span>
                  )}
                  <span>{f.path.slice(f.path.lastIndexOf("/") + 1)}</span>
                </code>
                <span className="artifact-tile__added tabular">+{c.added}</span>
                <span className="artifact-tile__removed tabular">−{c.removed}</span>
              </li>
            );
          })}
        </ul>
      );
    case "diagram":
      return <MermaidDiagram source={content.mermaid} label={t("artifacts.diagramLabel", { title })} compact />;
    case "html":
      return (
        <PageThumbnail
          html={content.html}
          label={t("artifacts.htmlPreview")}
          title={t("artifacts.htmlFrame", { title })}
        />
      );
    default:
      return null;
  }
}

/** A signed percentage ("+12%", "−3%"): its cell takes the up or down tone. */
const SIGNED = /^([+\-−])\s?\d[\d.,]*\s?%$/;
/** A column of numbers, amounts or percentages lines up on the right. */
const NUMBER = /^[+\-−]?\s?(?:[A-Z]{0,3}\$|€|£)?\s?\d[\d.,\s]*%?$/;

function CoverTable({ columns, rows }: { columns: string[]; rows: string[][] }) {
  const cols = columns.slice(0, COVER_COLUMNS);
  const shown = rows.slice(0, COVER_ROWS);
  const numeric = cols.map((_, j) => {
    const cells = shown.map((r) => (r[j] ?? "").trim()).filter(Boolean);
    return cells.length > 0 && cells.every((c) => NUMBER.test(c));
  });
  return (
    <table className="artifact-tile__table">
      <thead>
        <tr>
          {cols.map((c, j) => (
            <th key={c} className={numeric[j] ? "is-num" : undefined}>
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {shown.map((r) => (
          // A static drawing of a few rows: the row's own text is its key.
          <tr key={r.join("\u001f")}>
            {cols.map((_, j) => {
              const cell = (r[j] ?? "").trim();
              const sign = SIGNED.exec(cell)?.[1];
              const tone = sign ? (sign === "+" ? "is-up" : "is-down") : "";
              return (
                <td key={cols[j]} className={[numeric[j] ? "is-num" : "", tone].filter(Boolean).join(" ") || undefined}>
                  {cell}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A picture's cover: its box is the tile's from the first paint, the picture comes into it. */
function PictureCover({
  content,
  artifactId,
  version,
  title,
  alone = false,
}: {
  content: ArtifactFileContent;
  artifactId: string;
  version: number;
  title: string;
  alone?: boolean;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  // What the server can't make small (a picture it can't decode): the file itself, as before, when not too big.
  const [whole, setWhole] = useState(!hasThumbnail(content.contentType));
  if (whole)
    return content.size <= MAX_THUMB_BYTES ? (
      <WholePicture content={content} artifactId={artifactId} version={version} title={title} />
    ) : (
      <TypeCover content={content} />
    );
  const src = (width: 480 | 960) => api.artifacts.thumbUrl(org.id, artifactId, { version, width });
  return (
    <span className="artifact-tile__picture">
      <img
        src={src(480)}
        srcSet={`${src(480)} 480w, ${src(960)} 960w`}
        sizes={alone ? "400px" : "206px"}
        alt={t("files.imageAlt", { title })}
        loading="lazy"
        decoding="async"
        // Loaded after it showed (a picture just sent, not one the browser kept): it comes in softly.
        ref={(img) => {
          if (img && !img.complete)
            img.addEventListener("load", () => img.setAttribute("data-fresh", ""), { once: true });
        }}
        onError={() => setWhole(true)}
      />
    </span>
  );
}

/** A picture's whole file, for one the server doesn't make small. */
function WholePicture({
  content,
  artifactId,
  version,
  title,
}: {
  content: ArtifactFileContent;
  artifactId: string;
  version: number;
  title: string;
}) {
  const { t } = useTranslation();
  const { url, failed } = usePreviewUrl(artifactId, version, content.contentType, true);
  // Fetched after it showed (a picture just made or sent, not one read again from the cache): it comes in softly.
  const fresh = useRef(url === null);
  if (failed) return <TypeCover content={content} />;
  return (
    <span className="artifact-tile__picture">
      {url && <img src={url} alt={t("files.imageAlt", { title })} data-fresh={fresh.current || undefined} />}
    </span>
  );
}

/**
 * A card's picture or video as its facts tell it (`ArtifactRef`, servers from 2026-11 on): enough to draw its tile at
 * once, never what its actions need (who may share or delete it), which come with its details.
 */
function quickFile(ref: ArtifactRef) {
  const { name, contentType, size, version } = ref;
  if (ref.deleted || !name || !contentType || size === undefined || !version) return null;
  const kind = previewKind(contentType);
  if (kind !== "video" && !(kind === "image" && hasThumbnail(contentType))) return null;
  const content: ArtifactFileContent = {
    kind: "file",
    name,
    contentType,
    size,
    sha256: "",
    ...(ref.width && ref.height ? { width: ref.width, height: ref.height } : {}),
  };
  return { id: ref.id, kind: "file" as const, title: ref.title ?? name, version, shownVersion: version, content };
}

/** An uploaded file's cover: a CSV as its table, a small text file as its first lines, anything else its type. */
function FileCover({ content }: { content: ArtifactFileContent }) {
  const ext = extensionOf(content.name);
  const text = content.text;
  if (text === undefined || !text.trim()) return <TypeCover content={content} />;
  if (ext === "csv" || ext === "tsv") {
    const [head = [], ...rows] = parseDelimited(text, ext === "tsv" ? "\t" : ",", COVER_ROWS + 1);
    return <CoverTable columns={head} rows={rows} />;
  }
  if (ext === "md" || ext === "markdown")
    return <Markdown source={documentStart(text, COVER_CHARS)} excerpt className="artifact-tile__doc" />;
  const lines = text.split("\n").slice(0, COVER_LINES).join("\n");
  return isCodeName(content.name) ? (
    <pre className="artifact-tile__code">
      <code>{lines}</code>
    </pre>
  ) : (
    <p className="artifact-tile__text">{lines}</p>
  );
}

/** No preview: the type's icon and its extension, quiet in the middle. */
function TypeCover({ content }: { content: ArtifactFileContent }) {
  const ext = extensionOf(content.name).toUpperCase();
  return (
    <span className="artifact-tile__type">
      <Icon name={fileIcon(content.name, content.contentType)} size={20} />
      {ext && <span>{ext}</span>}
    </span>
  );
}

/** The page drawn at `PAGE_WIDTH` and scaled to the tile's width. */
const PAGE_WIDTH = 1000;
function PageThumbnail({ html, label, title }: { html: string; label: string; title: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.25);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver !== "function") return;
    const measure = () => {
      if (el.clientWidth > 0) setScale(el.clientWidth / PAGE_WIDTH);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={box}
      className="artifact-tile__page"
      role="img"
      aria-label={label}
      style={{ "--page-scale": scale } as CSSProperties}
    >
      <HtmlFrame html={html} title={title} className="artifact-tile__page-frame" thumbnail />
    </div>
  );
}
