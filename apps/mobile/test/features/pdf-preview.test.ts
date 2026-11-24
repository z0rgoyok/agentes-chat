import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactDetail } from "@agenteschat/client";
import {
  isLocalPdf,
  localPdfPath,
  PDF_PREVIEW_MAX_BYTES,
  pdfCopyKey,
  pdfPreviewable,
} from "../../src/features/files/logic";

const src = (file: string) => readFileSync(join(import.meta.dir, "../../src", file), "utf8");

type Input = Pick<ArtifactDetail, "kind" | "title" | "content">;
const upload = (name: string, contentType: string, size: number): Input => ({
  kind: "file",
  title: name,
  content: { kind: "file", name, contentType, size, sha256: "x" },
});

describe("a PDF's first page on its cards", () => {
  test("a PDF up to the cap draws its first page; a heavier one, another file, an unknown size keep their tile", () => {
    expect(pdfPreviewable(upload("report.pdf", "application/pdf", 2 * 1024 * 1024))).toBe(true);
    // Stored as plain bytes, it goes by its name.
    expect(pdfPreviewable(upload("report.pdf", "application/octet-stream", 1000))).toBe(true);
    expect(pdfPreviewable(upload("big.pdf", "application/pdf", PDF_PREVIEW_MAX_BYTES + 1))).toBe(false);
    expect(pdfPreviewable(upload("report.pdf", "application/pdf", PDF_PREVIEW_MAX_BYTES))).toBe(true);
    expect(pdfPreviewable(upload("empty.pdf", "application/pdf", 0))).toBe(false);
    expect(pdfPreviewable(upload("notes.txt", "text/plain", 1000))).toBe(false);
    expect(pdfPreviewable(undefined)).toBe(false);
  });

  test("a card's page and the PDF's screen read one copy: the same query, the same download", () => {
    expect(pdfCopyKey("org-1", "file-1", 3)).toEqual(["org", "org-1", "artifacts", "pdf", "file-1", 3]);
    const preview = src("features/files/pdf-preview.tsx");
    expect(preview).toContain('queryKey: pdfCopyKey(orgId, detail?.id ?? "", detail?.shownVersion ?? 0)');
    expect(preview).toContain("const path = await pdfCopy(api, orgId, detail);");
    expect(preview).toContain("staleTime: Number.POSITIVE_INFINITY");
  });

  test("a file picked on the phone is read from its own path, its escaped name as the renderer needs it", () => {
    expect(isLocalPdf({ type: "application/pdf", name: "x" })).toBe(true);
    expect(isLocalPdf({ type: "", name: "Contract.PDF" })).toBe(true);
    expect(isLocalPdf({ type: "image/png", name: "photo.png" })).toBe(false);
    expect(localPdfPath("file:///tmp/My%20Report%20%C3%A9.pdf")).toBe("/tmp/My Report é.pdf");
    expect(localPdfPath("/already/a/path.pdf")).toBe("/already/a/path.pdf");
    // A link that doesn't decode stays as it is rather than breaking the composer.
    expect(localPdfPath("file:///bad%E0.pdf")).toBe("/bad%E0.pdf");
  });

  test("the page is drawn top first into the tile's own box, over today's tile until it is drawn", () => {
    const preview = src("features/files/pdf-preview.tsx");
    expect(preview).toContain('resizeMode="fitWidth"');
    expect(preview).toContain("page={0}");
    // Shown once drawn (a fade the first time this run draws it), the tile under it until then and if it fails.
    expect(preview).toContain("pictureDrawn(drawnKey);");
    expect(preview).toContain("onError={onFailed}");
    expect(preview).toContain("{drawnBefore ? <View style={[StyleSheet.absoluteFill, styles.paper]} /> : children}");
    // A message's tile: the first page over its type's cover.
    const tile = src("features/files/AttachmentTile.tsx");
    expect(tile).toContain(
      'if (info.view === "pdf") return <PdfCover detail={detail}>{fileCover(info, content.text)}</PdfCover>;',
    );
    // The composer: read from the phone's file, in the type tile's box.
    const strip = src("features/chat/AttachmentStrip.tsx");
    expect(strip).toContain("<LocalPdfPage uri={f.uri} />");
    // And on its message while it uploads, from the same file on the phone.
    expect(src("features/files/MessageFiles.tsx")).toContain("<LocalPdfPage uri={file.uri} />");
    expect(strip).toContain("isLocalPdf(f)");
  });

  test("the Drive's grid draws every card at once: a PDF's card downloads only once it comes in sight", () => {
    const card = src("features/drive/DriveCard.tsx");
    expect(card).toMatch(/<PdfCover detail=\{detail\.data\} waitForSight>\s*<ContentPreview preview=\{p\} \/>/);
    expect(src("features/drive/DriveScreen.tsx")).toContain("onScrollEnd={noteCardsScrolled}");
    const preview = src("features/files/pdf-preview.tsx");
    expect(preview).toContain("const copy = usePdfCopy(detail, allowed && sight.seen);");
    expect(preview).toContain("if (h > 0 && y < height * 2 && y + h > -height) setSeen(true);");
    // The large title's scroll says when it comes to rest, on both platforms.
    const title = src("features/shared/PushedLargeTitle.tsx");
    expect(title).toContain("onMomentumScrollEnd={onScrollEnd}");
    expect(title).toContain("onScrollEnd?.();");
  });
});
