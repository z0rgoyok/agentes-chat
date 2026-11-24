import type { PDFDocumentLoadingTask, RenderTask } from "pdfjs-dist";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { pdfJs } from "@/lib/pdf";

/** Drawn this far before it scrolls into view, so it is there when it arrives. */
const NEAR = "600px 0px";

/**
 * A PDF's first page on its chat tile or Drive card, drawn by pdf.js from the file's download once it comes near the
 * screen. Only the parts of the file that page needs are read (ranges, no fetching ahead), and pdf.js lets the
 * document go once the page is drawn. `fallback` (the type's cover) shows until then, and stays when the PDF can't be
 * drawn (a password, a damaged file).
 */
export function PdfCover({ src, label, fallback }: { src: string; label: string; fallback: ReactNode }) {
  const box = useRef<HTMLSpanElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);
  const [drawn, setDrawn] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = box.current;
    if (!el || typeof IntersectionObserver === "undefined") return setNear(true);
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        setNear(true);
        io.disconnect();
      },
      { rootMargin: NEAR },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!near) return;
    let gone = false;
    let doc: PDFDocumentLoadingTask | null = null;
    let task: RenderTask | null = null;
    setDrawn(false);
    setFailed(false);
    void (async () => {
      const lib = await pdfJs.load();
      if (gone) return;
      doc = lib.getDocument({ url: src, disableAutoFetch: true, disableStream: true });
      const page = await (await doc.promise).getPage(1);
      const c = canvas.current;
      if (gone || !c) return;
      const base = page.getViewport({ scale: 1 });
      const width = box.current?.clientWidth || 240;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const viewport = page.getViewport({ scale: (width / base.width) * dpr });
      c.width = Math.round(viewport.width);
      c.height = Math.round(viewport.height);
      task = page.render({ canvas: c, viewport });
      await task.promise;
      if (gone) return;
      setDrawn(true);
      void doc.destroy();
    })().catch(() => !gone && setFailed(true));
    return () => {
      gone = true;
      task?.cancel();
      void doc?.destroy();
    };
  }, [near, src]);

  return (
    <span ref={box} className="pdf-cover" data-drawn={drawn || undefined}>
      {!drawn && fallback}
      {!failed && <canvas ref={canvas} role="img" aria-label={label} />}
    </span>
  );
}
