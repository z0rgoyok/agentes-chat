import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, render } from "@testing-library/react";
import { PdfCover } from "@/components/artifacts/PdfCover";
import { type PdfLib, pdfJs } from "@/lib/pdf";

const realLoad = pdfJs.load;
const realObserver = globalThis.IntersectionObserver;
/** Tiles the test scrolls near: each observed one is on screen at once, unless `far`. */
let far = false;
globalThis.IntersectionObserver = class {
  constructor(private readonly seen: IntersectionObserverCallback) {}
  observe(el: Element) {
    if (!far) this.seen([{ isIntersecting: true, target: el } as IntersectionObserverEntry], this as never);
  }
  disconnect() {}
  unobserve() {}
  takeRecords() {
    return [];
  }
} as unknown as typeof IntersectionObserver;
afterEach(() => {
  cleanup();
  far = false;
});
afterAll(() => {
  pdfJs.load = realLoad;
  globalThis.IntersectionObserver = realObserver;
});

/** A pdf.js that reads a one-page PDF (or fails to open it), recording what it was asked. */
function fakePdfJs(open: "ok" | "fails") {
  const asked: { url?: string; disableAutoFetch?: boolean; disableStream?: boolean }[] = [];
  let destroyed = 0;
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
    render: () => ({ promise: Promise.resolve(), cancel() {} }),
  };
  const lib = {
    getDocument(options: (typeof asked)[number]) {
      asked.push(options);
      return {
        promise: open === "ok" ? Promise.resolve({ getPage: async () => page }) : Promise.reject(new Error("password")),
        destroy: async () => {
          destroyed++;
        },
      };
    },
  };
  pdfJs.load = async () => lib as unknown as PdfLib;
  return { asked, destroyed: () => destroyed };
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));

describe("a PDF's first page on its cover", () => {
  test("drawn from the file's download, reading only the ranges the page needs; the type's cover gives way", async () => {
    const pdf = fakePdfJs("ok");
    const view = render(<PdfCover src="/files/a.pdf" label="PDF: Proposta" fallback={<span>PDF</span>} />);
    await settle();
    expect(pdf.asked).toEqual([{ url: "/files/a.pdf", disableAutoFetch: true, disableStream: true }]);
    const cover = view.container.querySelector(".pdf-cover");
    expect(cover?.hasAttribute("data-drawn")).toBe(true);
    expect(view.getByRole("img", { name: "PDF: Proposta" })).toBeTruthy();
    expect(view.queryByText("PDF")).toBeNull();
    // Let go once drawn: a chat of PDFs holds no documents open.
    expect(pdf.destroyed()).toBeGreaterThan(0);
  });

  test("far from the screen nothing loads", async () => {
    const pdf = fakePdfJs("ok");
    far = true;
    const view = render(<PdfCover src="/files/c.pdf" label="PDF: Anexo" fallback={<span>PDF</span>} />);
    await settle();
    expect(pdf.asked).toEqual([]);
    expect(view.getByText("PDF")).toBeTruthy();
  });

  test("a PDF pdf.js can't open (a password, a damaged file) keeps the type's cover", async () => {
    fakePdfJs("fails");
    const view = render(<PdfCover src="/files/b.pdf" label="PDF: Contrato" fallback={<span>PDF</span>} />);
    await settle();
    expect(view.getByText("PDF")).toBeTruthy();
    expect(view.queryByRole("img")).toBeNull();
    expect(view.container.querySelector(".pdf-cover")?.hasAttribute("data-drawn")).toBe(false);
  });
});
