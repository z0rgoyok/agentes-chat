import { EmptyState } from "@agenteschat/ui";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import { type PointerEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { pdfJs } from "@/lib/pdf";
import { DraftMark } from "./DraftMark";
import { MediaPins } from "./MediaPins";
import { type Mark, type MediaPin, markOf, type StageMarks } from "./marks";

/*
 * A PDF on its page (ADR 0208): drawn by pdf.js (`@/lib/pdf`), page under page.
 * Comments point at a page and, when marked, a point or an area of it.
 */

/** The widest a page is drawn at the zoom of 1 (pixels). */
const PAGE_MAX_W = 880;
const PAGE_GAP = 24;
const SIDE = 40;
/** A comment on a page with no mark stands at its top right corner. */
const PAGE_CORNER: Mark = { x: 1, y: 0 };

export function PdfStage({
  src,
  zoom,
  marks,
  onMark,
  onPages,
  onPage,
}: {
  src: string;
  zoom: number;
  marks: StageMarks;
  onMark: (mark: Mark, page: number, canvas: HTMLCanvasElement) => void;
  /** How many pages it has, once read. */
  onPages: (count: number) => void;
  /** The page in view as it scrolls. */
  onPage: (page: number) => void;
}) {
  const { t } = useTranslation();
  const scroller = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [failed, setFailed] = useState(false);
  // The first page's proportions stand for the pages not read yet (most PDFs have one size).
  const [aspect, setAspect] = useState(1.294);
  const pages = useRef(new Map<number, HTMLDivElement>());

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const read = () => setWidth(el.clientWidth);
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let gone = false;
    let task: { destroy(): Promise<void> } | null = null;
    setFailed(false);
    pdfJs
      .load()
      .then((lib) => {
        const loading = lib.getDocument({ url: src });
        task = loading;
        return loading.promise;
      })
      .then(async (d) => {
        if (gone) return;
        const first = await d.getPage(1).catch(() => null);
        const v = first?.getViewport({ scale: 1 });
        if (gone) return;
        if (v && v.width > 0) setAspect(v.height / v.width);
        setDoc(d);
        onPages(d.numPages);
      })
      .catch(() => !gone && setFailed(true));
    return () => {
      gone = true;
      void task?.destroy();
    };
  }, [src, onPages]);

  // A comment opened on another page: that page comes into view.
  const focus = marks.pins.find((p) => p.message.id === marks.focusId);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per comment opened
  useEffect(() => {
    const n = focus?.selection.page;
    if (n) pages.current.get(n)?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [marks.focusId, doc]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const middle = el.scrollTop + el.clientHeight / 3;
    let shown = 1;
    for (const [n, page] of pages.current) if (page.offsetTop <= middle) shown = Math.max(shown, n);
    onPage(shown);
  };

  const pageW = Math.max(200, Math.min(PAGE_MAX_W, width - SIDE * 2) * zoom);
  if (failed) {
    return (
      <div className="mf-stage mf-stage--pdf">
        <EmptyState size="panel" icon="file" title={t("files.comments.pdfFailed")} />
      </div>
    );
  }
  return (
    <div ref={scroller} className="mf-stage mf-stage--pdf" data-tool={marks.tool} onScroll={onScroll}>
      <div className="mf-pages" style={{ gap: PAGE_GAP }}>
        {doc &&
          Array.from({ length: doc.numPages }, (_, i) => i + 1).map((n) => (
            <PdfPage
              key={n}
              doc={doc}
              n={n}
              width={pageW}
              aspect={aspect}
              marks={marks}
              pins={marks.pins
                .filter((p) => p.selection.page === n)
                .map((p) => (p.selection.mark ? p : { ...p, selection: { ...p.selection, mark: PAGE_CORNER } }))}
              onMark={onMark}
              place={(el) => {
                if (el) pages.current.set(n, el);
                else pages.current.delete(n);
              }}
            />
          ))}
      </div>
    </div>
  );
}

/**
 * One page: its box at once (the first page's proportions until its own are read), read and drawn when it comes near
 * the screen, and its drawing let go when it goes far (a long PDF never holds every page's pixels).
 */
function PdfPage({
  doc,
  n,
  width,
  aspect,
  marks,
  pins,
  onMark,
  place,
}: {
  doc: PDFDocumentProxy;
  n: number;
  width: number;
  aspect: number;
  marks: StageMarks;
  pins: MediaPin[];
  onMark: (mark: Mark, page: number, canvas: HTMLCanvasElement) => void;
  place: (el: HTMLDivElement | null) => void;
}) {
  const { t } = useTranslation();
  const box = useRef<HTMLDivElement | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [page, setPage] = useState<PDFPageProxy | null>(null);
  const [near, setNear] = useState(n <= 2);
  const [drag, setDrag] = useState<{ from: { x: number; y: number }; to: { x: number; y: number } } | null>(null);

  // Read once it first comes near.
  useEffect(() => {
    if (!near || page) return;
    let gone = false;
    void doc
      .getPage(n)
      .then((p) => !gone && setPage(p))
      .catch(() => undefined);
    return () => {
      gone = true;
    };
  }, [doc, n, near, page]);

  // Near the screen (a screen's height or so around it): drawn; far: its pixels let go.
  useEffect(() => {
    const el = box.current;
    if (!el || typeof IntersectionObserver === "undefined") return setNear(true);
    const io = new IntersectionObserver((entries) => setNear(entries.some((e) => e.isIntersecting)), {
      rootMargin: "1200px 0px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const base = page?.getViewport({ scale: 1 });
  const baseW = base?.width ?? 0;
  const height = base ? (width * base.height) / base.width : width * aspect;

  useEffect(() => {
    const c = canvas.current;
    if (c && !near) {
      c.width = 0;
      c.height = 0;
      return;
    }
    if (!page || !near || !c || !baseW) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const viewport = page.getViewport({ scale: (width / baseW) * dpr });
    c.width = Math.round(viewport.width);
    c.height = Math.round(viewport.height);
    let task: RenderTask | null = null;
    try {
      task = page.render({ canvas: c, viewport });
      task.promise.catch(() => undefined);
    } catch {
      // A page pdf.js can't draw stays blank; the rest still show.
    }
    return () => task?.cancel();
  }, [page, near, width, baseW]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (marks.tool !== "comment" || e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDrag({ from: { x: e.clientX, y: e.clientY }, to: { x: e.clientX, y: e.clientY } });
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const r = box.current?.getBoundingClientRect();
    const mark = r ? markOf(drag.from, { x: e.clientX, y: e.clientY }, r) : null;
    setDrag(null);
    if (mark && canvas.current) onMark(mark, n, canvas.current);
  };
  const r = drag ? box.current?.getBoundingClientRect() : null;
  const dragging = drag && r ? markOf(drag.from, drag.to, r) : null;
  const draftHere = marks.draft && marks.draftPage === n ? marks.draft : null;

  return (
    // biome-ignore lint/a11y/useSemanticElements: a PDF's page with its pins, not a set of form fields
    <div
      ref={(el) => {
        box.current = el;
        place(el);
      }}
      className="mf-page"
      style={{ width, height }}
      role="group"
      aria-label={t("files.comments.page", { page: n })}
      onPointerDown={onPointerDown}
      onPointerMove={(e) => drag && setDrag({ from: drag.from, to: { x: e.clientX, y: e.clientY } })}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setDrag(null)}
    >
      <canvas ref={canvas} className="mf-page__canvas" />
      <MediaPins pins={pins} focusId={marks.focusId} showResolved={marks.showResolved} onOpen={marks.onOpenPin} />
      {dragging?.w !== undefined ? <DraftMark mark={dragging} /> : draftHere && <DraftMark {...draftHere} />}
    </div>
  );
}
