/*
 * pdf.js, loaded only when a PDF is drawn (the viewer's pages, a chat tile's first page), never in the app's first load.
 */

export type PdfLib = typeof import("pdfjs-dist");
let loading: Promise<PdfLib> | null = null;

/** pdf.js and its worker, once. Swappable: tests draw no PDF. */
export const pdfJs = {
  load(): Promise<PdfLib> {
    loading ??= Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]).then(
      ([lib, worker]) => {
        lib.GlobalWorkerOptions.workerSrc = (worker as { default: string }).default;
        return lib;
      },
    );
    // A chunk that failed to load (offline) is asked for again next time.
    loading.catch(() => {
      loading = null;
    });
    return loading;
  },
};
