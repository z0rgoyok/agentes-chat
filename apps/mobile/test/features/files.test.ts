import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactDetail } from "@agenteschat/client";
import { pictureRatio } from "@agenteschat/client/lib/files";
import { tileWidth } from "../../src/features/chat/attachment-size";
import {
  decodeFileList,
  driveWebUrl,
  encodeFileList,
  extensionOf,
  extLabel,
  fileInfo,
  fileRoute,
  isMediaFile,
  pageStep,
  resolveDownloadUrl,
  safeFileName,
  shareSource,
  singleImageBox,
  singleImageHeight,
  utf8Bytes,
  videoBox,
  videoClock,
  videoHeight,
  whereKnown,
  withExtension,
} from "../../src/features/files/logic";
import {
  awaySpeed,
  DISMISS_DISTANCE,
  DISMISS_MIN_SCALE,
  DISMISS_SHARE,
  doubleTapZoom,
  dragWithin,
  EDGE_RESISTANCE,
  fitted,
  maxZoom,
  PULL_PROJECTION,
  panRoom,
  pinchRest,
  pullCloses,
  pullDirection,
  pulledPlacement,
  pullProgress,
  pullProjection,
  resistedZoom,
  rubberBand,
  rubberClamp,
  unRubberBand,
  ZOOM_GIVE,
  zoomInAt,
  zoomInRect,
} from "../../src/features/files/zoom";
import { ICONS } from "../../src/ui/icons.data";
import { ownOptionsOf } from "../main-stack";
import { chatScreenSource } from "./chat-screen-source";

const src = (file: string) => readFileSync(join(import.meta.dir, "../../src", file), "utf8");

type Input = Pick<ArtifactDetail, "kind" | "title" | "content">;
const upload = (name: string, contentType: string, size = 1000, text?: string): Input => ({
  kind: "file",
  title: name,
  content: { kind: "file", name, contentType, size, sha256: "x", ...(text !== undefined ? { text } : {}) },
});

describe("videos", () => {
  test("MP4 and MOV play in the app, as a video; other video types stay a card", () => {
    expect(fileInfo(upload("abertura.mp4", "video/mp4"))).toMatchObject({ view: "video", type: "video", ext: "MP4" });
    expect(fileInfo(upload("story.MOV", "video/quicktime")).view).toBe("video");
    expect(fileInfo(upload("antigo.avi", "video/x-msvideo")).view).toBe("other");
  });

  test("one box in a message whatever its shape, so nothing moves once it loads; its time as a clock", () => {
    expect(videoHeight(320)).toBe(180);
    expect(videoClock(7.9)).toBe("0:07");
    expect(videoClock(725)).toBe("12:05");
    expect(videoClock(3729)).toBe("1:02:09");
    expect(videoClock(Number.NaN)).toBe("0:00");
  });

  test("a video whose size the server read has its own shape from the first frame, an upright one narrowed to fit", () => {
    expect(videoBox(320, 16 / 9)).toEqual({ width: 320, height: 180 });
    expect(videoBox(320, 9 / 16)).toEqual({ width: 225, height: 400 });
    // Not read: the 16:9 box.
    expect(videoBox(320, undefined)).toEqual({ width: 320, height: 180 });
  });
});

describe("audio", () => {
  test("audio files play in the file screen's player; their tile stays a file card", () => {
    expect(fileInfo(upload("entrevista.mp3", "audio/mpeg"))).toMatchObject({ view: "audio", type: "file", ext: "MP3" });
    expect(fileInfo(upload("nota.m4a", "audio/x-m4a")).view).toBe("audio");
    expect(fileInfo(upload("faixa.wav", "audio/wav")).view).toBe("audio");
    expect(fileInfo(upload("midi.mid", "audio/midi")).view).toBe("other");
    // Stored as plain bytes (an agent's recording with no type given): by its name.
    expect(fileInfo(upload("entrevista.m4a", "application/octet-stream")).view).toBe("audio");
    expect(fileInfo(upload("nota.opus", "application/octet-stream")).view).toBe("audio");
    expect(fileInfo(upload("faixa.flac", "application/octet-stream")).view).toBe("audio");
  });
});

describe("file kind, tile and size", () => {
  test("raster pictures are images; SVG is not", () => {
    expect(fileInfo(upload("home.png", "image/png")).view).toBe("image");
    expect(fileInfo(upload("foto.JPG", "image/jpeg; charset=binary")).view).toBe("image");
    expect(fileInfo(upload("logo.svg", "image/svg+xml")).view).toBe("other");
    expect(fileInfo(upload("logo.svg", "image/svg+xml")).type).toBe("image");
  });

  test("PDF, Markdown and text open in the document screen; a CSV in the spreadsheet's grid (ADR 0198)", () => {
    const pdf = fileInfo(upload("Relatório.pdf", "application/pdf", 2048));
    expect(pdf).toMatchObject({ view: "pdf", type: "pdf", ext: "PDF", size: 2048, name: "Relatório.pdf" });
    expect(fileInfo(upload("notes.md", "application/octet-stream")).view).toBe("markdown");
    expect(fileInfo(upload("notes.md", "text/markdown")).type).toBe("document");
    const csv = fileInfo(upload("vendas.csv", "text/csv"));
    expect(csv).toMatchObject({ view: "sheet", type: "table", ext: "CSV" });
    expect(fileInfo(upload("log.txt", "text/plain")).type).toBe("text");
  });

  test("other files are cards with their type", () => {
    expect(fileInfo(upload("backup.zip", "application/zip"))).toMatchObject({
      view: "other",
      type: "archive",
      ext: "ZIP",
    });
    expect(fileInfo(upload("sem-extensao", "application/octet-stream"))).toMatchObject({ type: "file", ext: "" });
  });

  test("a document artifact: title with .md, size from its text", () => {
    const doc = fileInfo({
      kind: "document",
      title: "Resumo da home",
      content: { kind: "document", markdown: "Olá é" },
    });
    // A document is a live file (ADR 0200): it opens on its own screen.
    expect(doc).toMatchObject({ name: "Resumo da home.md", view: "live", type: "document", ext: "MD", size: 7 });
    const table = fileInfo({ kind: "table", title: "Vendas", content: { kind: "table", columns: [], rows: [] } });
    // An old table opens read-only in the spreadsheet's grid.
    expect(table).toMatchObject({ name: "Vendas.csv", view: "sheet", type: "table", size: null });
  });

  test("helpers", () => {
    expect(extensionOf("a.tar.GZ")).toBe("gz");
    expect(extensionOf("README")).toBe("");
    expect(extLabel("jpeg")).toBe("JPEG");
    expect(extLabel("markdown")).toBe("MARK");
    expect(withExtension("x.md", "md")).toBe("x.md");
    expect(withExtension("x", "md")).toBe("x.md");
    expect(utf8Bytes("a")).toBe(1);
    expect(utf8Bytes("ç")).toBe(2);
    expect(utf8Bytes("€")).toBe(3);
    expect(utf8Bytes("😀")).toBe(4);
  });
});

describe("pictures in a message", () => {
  test("a lone picture of unknown size has one box whatever its shape, so nothing moves once it loads", () => {
    expect(singleImageHeight(300)).toBe(225);
    expect(singleImageBox(300, undefined)).toEqual({ width: 300, height: 225 });
  });

  test("one whose size the server read has its own shape from the first frame, no taller than 400", () => {
    expect(singleImageBox(300, pictureRatio({ width: 1024, height: 1024 }))).toEqual({ width: 300, height: 300 });
    expect(singleImageBox(300, pictureRatio({ width: 1536, height: 1024 }))).toEqual({ width: 300, height: 200 });
    // A portrait one narrows to stay 400 high.
    expect(singleImageBox(300, pictureRatio({ width: 1024, height: 1536 }))).toEqual({ width: 267, height: 400 });
    expect(pictureRatio({ width: 1024 })).toBeUndefined();
  });
});

describe("shared copies", () => {
  test("safe names: no folders, no refused characters, never empty, extension kept", () => {
    expect(safeFileName("../../etc/passwd")).toBe("-..-etc-passwd");
    expect(safeFileName('a:b*c?"d<e>f|g.png')).toBe("a-b-c--d-e-f-g.png");
    expect(safeFileName("  .hidden. ")).toBe("hidden");
    expect(safeFileName("line\nbreak\u0000.txt")).toBe("linebreak.txt");
    expect(safeFileName("   ")).toBe("file");
    const long = safeFileName(`${"a".repeat(300)}.pdf`);
    expect(long.length).toBe(120);
    expect(long.endsWith(".pdf")).toBe(true);
  });

  test("where the copy comes from", () => {
    expect(shareSource({ kind: "document", title: "Plano", content: { kind: "document", markdown: "# Oi" } })).toEqual({
      from: "text",
      text: "# Oi",
      name: "Plano.md",
      mime: "text/markdown",
    });
    expect(
      shareSource({ kind: "table", title: "Vendas", content: { kind: "table", columns: [], rows: [] } }),
    ).toMatchObject({ from: "export", format: "csv", name: "Vendas.csv" });
    expect(shareSource(upload("home/print.png", "image/png"))).toEqual({
      from: "download",
      name: "home-print.png",
      mime: "image/png",
    });
  });

  test("download links: signed links as they are, ours with the session", () => {
    expect(resolveDownloadUrl("https://app.agentes.chat", "https://bucket.s3/x?sig=1")).toEqual({
      uri: "https://bucket.s3/x?sig=1",
      needsSession: false,
    });
    expect(resolveDownloadUrl("https://app.agentes.chat", "https://app.agentes.chat.attacker.test/file")).toEqual({
      uri: "https://app.agentes.chat.attacker.test/file",
      needsSession: false,
    });
    expect(resolveDownloadUrl("https://app.agentes.chat", "https://app.agentes.chat/file")).toEqual({
      uri: "https://app.agentes.chat/file",
      needsSession: true,
    });
    expect(
      resolveDownloadUrl("https://app.agentes.chat/", "/api/app/organizations/o/artifacts/a/file?version=2"),
    ).toEqual({
      uri: "https://app.agentes.chat/api/app/organizations/o/artifacts/a/file?version=2",
      needsSession: true,
    });
  });

  test("the web Drive at the file", () => {
    expect(driveWebUrl("https://app.agentes.chat/", "org1", "a1")).toBe(
      "https://app.agentes.chat/org/org1/drive?artifact=a1",
    );
    expect(driveWebUrl("https://app.agentes.chat", "org1", "a1", 3)).toBe(
      "https://app.agentes.chat/org/org1/drive?artifact=a1&v=3",
    );
  });
});

describe("viewer", () => {
  test("the route's file list round-trips and drops junk", () => {
    const list = [{ id: "a-1", version: 2 }, { id: "b_2" }];
    expect(decodeFileList(encodeFileList(list))).toEqual(list);
    expect(decodeFileList("a@0,../x,b@x,c@3")).toEqual([{ id: "a" }, { id: "b" }, { id: "c", version: 3 }]);
    expect(decodeFileList(undefined)).toEqual([]);
  });

  test("‹ › go one picture at a time and never round past the first or the last", () => {
    expect(pageStep(1, 1, 4)).toBe(2);
    expect(pageStep(1, -1, 4)).toBe(0);
    expect(pageStep(0, -1, 4)).toBeNull();
    expect(pageStep(3, 1, 4)).toBeNull();
    expect(pageStep(0, 1, 1)).toBeNull();
  });

  test("several pictures: 2 de 4 in the head, ‹ › on the sides (gone while zoomed) slide the pager as a swipe", () => {
    const viewer = src("features/files/ImageViewer.tsx");
    expect(viewer).toContain(
      'files.length > 1 ? t("mobile.files.place", { index: index + 1, count: files.length }) : ""',
    );
    expect(viewer).toContain("[place, author, savedWhen(savedAt(detail))].filter(Boolean)");
    expect(viewer).toContain(
      '<Round icon="left" label={t("mobile.files.previous")} plate={SCRIM} onPress={() => turn(prev)} />',
    );
    expect(viewer).toContain(
      '<Round icon="right" label={t("mobile.files.next")} plate={SCRIM} onPress={() => turn(next)} />',
    );
    // Gone while zoomed.
    expect(viewer).toContain("visible={chrome && !zoomed}");
    expect(viewer).toContain("else pager.current?.setPage(to);");
    // The count took the dots' place: one place says where you are.
    expect(viewer).not.toContain("styles.dots");
  });

  test("‹ and › are one chevron mirrored, on a dark plate that reads on a light picture", () => {
    // `back` (7×14) is a size larger than `right` (6×12) and half a unit off center: `left` is `right` mirrored.
    expect(ICONS.left).toEqual([{ t: "path", d: "m15 6-6 6 6 6" }]);
    expect(ICONS.right).toEqual([{ t: "path", d: "m9 6 6 6-6 6" }]);
    // The close and ⋯ plates are light (they sit on the black above the picture); ‹ › sit on the picture.
    expect(src("features/files/ImageViewer.tsx")).toContain('const SCRIM = "rgba(0,0,0,0.45)";');
  });

  test("photos, videos and files go up as parts Expo's fetch sends, never React Native's { uri } part", () => {
    // Expo's fetch refuses `{ uri, name, type }` ("Unsupported FormDataPart implementation"): no upload ever left.
    const chat = chatScreenSource();
    expect(chat).toContain("api.artifacts.upload(orgId, uploadPart(file), {");
    expect(chat).not.toContain("as unknown as Parameters<typeof api.artifacts.upload>[1]");
    expect(src("features/drive/useDriveUpload.ts")).toContain(
      "api.artifacts.upload(orgId, uploadPart(file), folderId ? { folderId } : {})",
    );
    expect(src("features/files/upload-part.ts")).toContain("bytes: () => source.bytes()");
  });

  test("what waits in the field: one height, a photo or video in its own shape, a file as a wider card", () => {
    expect(tileWidth({ type: "image/jpeg", width: 4000, height: 3000 })).toBe(96);
    expect(tileWidth({ type: "image/jpeg", width: 1000, height: 4000 })).toBe(54);
    expect(tileWidth({ type: "video/mp4", width: 1920, height: 1080 })).toBe(128);
    expect(tileWidth({ type: "image/png" })).toBe(72);
    expect(tileWidth({ type: "application/pdf" })).toBe(176);
    const strip = src("features/chat/AttachmentStrip.tsx");
    // A video at its first frame with its length; nothing drawn red, no dashed tile.
    expect(strip).toContain("<VideoFirstFrame uri={f.uri} />");
    expect(strip).toContain("videoClock(f.duration)");
    expect(strip).not.toContain("dashed");
    expect(strip).not.toMatch(/rgba\(2\d\d, ?\d{1,2}, ?\d{1,2}/);
    // Inside the field, on a row of its own across it.
    expect(src("ui/Composer.tsx")).toContain(
      "{attachments ? <View style={styles.attachRow}>{attachments}</View> : null}",
    );
  });

  test("sending with files is optimistic: the message shows at once with its files, the field is free", () => {
    const chat = chatScreenSource();
    // In the conversation at once, under the clientId the real message comes back with.
    expect(chat).toContain(
      "qc.setQueryData<Message[]>(keys.messages(orgId, channelId), (list) => upsertMessage(list, local));",
    );
    expect(chat).toContain("[LOCAL_FILES]: files.map(");
    // Then up, then sent with the same clientId; a failure turns it "Não foi enviada" and retry starts over.
    expect(chat).toContain("clientId: local.clientId ?? newClientId(),");
    expect(chat).toContain('? { ...m, local: "failed" as const, sendFailure: sendFailureOf(failed.reason) }');
    // (In its turn behind other files of mine still going up: what is sent goes in the order it was sent.)
    expect(chat).toContain("behindFiles(() => deliverFilesRef.current(m));");
    // No more waiting in the field while they upload.
    expect(chat).not.toContain("sendingFiles.current");
    const row = src("features/chat/MessageRow.tsx");
    expect(row).toContain('<LocalFiles files={localFiles} align="end" sending={m.local === "pending"} />');
  });

  test("a file whose name doesn't say what it is gets its details before it opens: a video never flashes the file screen", () => {
    expect(whereKnown({ id: "a", title: "clip.mp4" })).toBe(true);
    expect(whereKnown({ id: "a", title: "notes.md" })).toBe(true);
    expect(whereKnown({ id: "a", title: "Video do lancamento" })).toBe(false);
    expect(whereKnown({ id: "a", title: "take.mkv" })).toBe(false);
    expect(whereKnown({ id: "a", title: "Plan", kind: "document" })).toBe(true);
    for (const f of ["drive/DriveCard.tsx", "search/SearchResults.tsx", "chat/FileRefText.tsx"])
      expect(src(`features/${f}`)).toContain("useOpenFile");
  });

  test("a video opens where the pictures do, from a message, the Drive or a file's link, and plays there", () => {
    expect(src("features/files/ImageViewer.tsx")).toContain("<ViewerVideo");
    const message = src("features/files/MessageFiles.tsx");
    expect(message).not.toContain('pathname: "/file/[id]"');
    expect(fileRoute({ id: "v1", version: 2, title: "abertura.mp4", kind: "file" }).pathname).toBe("/images");
    // A file's link that turns out to be one still goes on to the viewer, in the file screen's place.
    const document = src("features/files/DocumentViewer.tsx");
    // (A live file's too, on to its own screen, ADR 0196.)
    expect(document).toContain(
      'const media = info?.view === "image" || info?.view === "video" || info?.view === "live";',
    );
    expect(document).toContain("openFile({ id: detail.id, detail }, undefined, { replace: true });");
    expect(document).not.toContain("<VideoPlayer");
  });

  test("one way to open a file: a picture or a video straight in the viewer, among its neighbours; the rest in the file screen", () => {
    const png = upload("print.png", "image/png");
    const pdf = upload("Relatório.pdf", "application/pdf");
    // By its details once loaded; before, by its name (as an upload stored without a type); a document is never one.
    expect(isMediaFile({ id: "a", detail: { ...png, shownVersion: 1, version: 1 } })).toBe(true);
    expect(isMediaFile({ id: "a", detail: { ...pdf, shownVersion: 1, version: 1 } })).toBe(false);
    expect(isMediaFile({ id: "a", title: "story.MOV" })).toBe(true);
    expect(isMediaFile({ id: "a", title: "notes.png", kind: "document" })).toBe(false);
    expect(isMediaFile({ id: "a", title: "logo.svg" })).toBe(false);
    expect(isMediaFile({ id: "a" })).toBe(false);
    // A message with two pictures and a video: the tapped one is the viewer's place, the others on either side.
    const media = [
      { id: "p1", version: 1, title: "a.jpg" },
      { id: "p2", title: "b.png", detail: { ...png, shownVersion: 3, version: 3 } },
      { id: "v1", version: 2, title: "c.mp4" },
    ];
    expect(fileRoute(media[2] ?? { id: "" }, media, "deck")).toEqual({
      pathname: "/images",
      params: { files: "p1@1,p2@3,v1@2", at: "2", from: "deck" },
    });
    // Alone (or not among the neighbours given), it opens by itself; a file that isn't one goes to the file screen.
    expect(fileRoute({ id: "x", title: "y.jpg" }, media)).toEqual({
      pathname: "/images",
      params: { files: "x", at: "0" },
    });
    expect(fileRoute({ id: "d", title: "Plano", kind: "document" }, media)).toEqual({
      pathname: "/document/[id]",
      params: { id: "d" },
    });
    // The file screen at an older version only when that's the one shown.
    expect(fileRoute({ id: "d", detail: { ...pdf, shownVersion: 1, version: 3 } }).params).toEqual({ id: "d", v: "1" });
    expect(fileRoute({ id: "d", detail: { ...pdf, shownVersion: 3, version: 3 } }).params).toEqual({ id: "d" });
    expect(fileRoute({ id: "d", version: 4, title: "log.txt" }).params).toEqual({ id: "d", v: "4" });
    // Every place that opens a file goes through it: no screen pushes the viewer or the file screen by itself.
    for (const file of [
      "features/drive/DriveCard.tsx",
      "features/files/AttachmentTile.tsx",
      "features/files/MessageFiles.tsx",
      "features/files/ImageStack.tsx",
      "features/search/SearchResults.tsx",
      "features/chat/FileRefText.tsx",
      "features/issues/IssueScreen.tsx",
      "features/agents/AgentProfileScreen.tsx",
    ]) {
      const source = src(file);
      // `openFile`, or `useOpenFile` where only a name is known (its details come first when the name says nothing).
      const opens = source.includes("openFile(") || source.includes("useOpenFile(");
      expect({ file, opens }).toEqual({ file, opens: true });
      expect({ file, own: /pathname: "\/(images|file\/\[id\])"/.test(source) }).toEqual({ file, own: false });
    }
    // The Drive's grid and a message's pictures and videos are the viewer's pages, in the order they show.
    expect(src("features/drive/DriveScreen.tsx")).toContain("siblings={shownRefs}");
    expect(src("features/files/MessageFiles.tsx")).toContain(
      "(tiles.length > 0 ? [...videos, ...images] : [...pictures, ...videos])",
    );
    // The viewer tells a deck the file the person stopped at; a video beside its pictures leaves it as it was.
    expect(src("features/files/ImageViewer.tsx")).toContain("tellViewerPlace(from, currentId)");
    expect(src("features/files/ImageStack.tsx")).toContain("if (at < 0) return;");
  });

  test("the pictures page on the system's pager and zoom with the system's own zoom on iOS", () => {
    const viewer = src("features/files/ImageViewer.tsx");
    expect(viewer).toContain('import PagerView from "react-native-pager-view";');
    expect(viewer).toContain("scrollEnabled={!zoomed}");
    expect(viewer).not.toContain("zoom-toolkit");
    const zoom = src("features/files/ZoomPicture.tsx");
    // iOS: the scroll view's own pinch, bounce and momentum; a double tap zooms through it, at once with reduced motion.
    expect(zoom).toContain("maximumZoomScale={max}");
    expect(zoom).toContain("pinchGestureEnabled");
    expect(zoom).toContain("scroll.current?.scrollResponderZoomTo({ ...rect, animated: !reduced });");
    // Centered by the system's insets, worked out from the content's size: the content is the picture's own box (a
    // vertical scroll view stretches its content to its width, and a narrower picture sat at its left edge), and at
    // 1× the scroll view is put at those insets when a size changes.
    expect(zoom).toContain("centerContent");
    expect(zoom).toContain("contentContainerStyle={picture}");
    expect(zoom).toContain("scroll.current?.scrollTo({ x: -left, y: -top, animated: false })");
    // Android: a pinch of ours that gives a little past its limits and springs back, a drag that resists past the
    // edges, a fling that glides and bounces off an edge it hits; with reduced motion, no glide and no spring.
    expect(zoom).toContain('Platform.OS === "ios" ? <SystemZoom {...zoom} /> : <OwnZoom {...zoom} />');
    expect(zoom).toContain("const next = resistedZoom(from.scale * e.scale, 1, max);");
    expect(zoom).toContain(
      "settle(pinchRest(picture, screen, { scale: scale.value, x: x.value, y: y.value }, focal.value, max));",
    );
    expect(zoom).toContain("x.value = dragWithin(x.value, e.changeX, -room.x, room.x, screen.width);");
    expect(zoom).toContain("withDecay({ velocity, clamp: [-room, room], rubberBandEffect: true })");
    expect(zoom).toContain("if (reduced || room <= 0) return clamp(from, -room, room);");
    expect(zoom).toMatch(/if \(reduced\) \{\s*scale\.value = to\.scale;/);
    // The pull to close comes first, before the picture's own gestures.
    expect(zoom).toContain("useExclusiveGestures(pull, doubleTap, tap)");
    expect(zoom).toContain("useExclusiveGestures(pull, pinchAndPan, doubleTap, tap)");
  });

  test("a zoomed picture shows its own pixels, not a copy the screen's size magnified; the pages beside it stay light", () => {
    const zoom = src("features/files/ZoomPicture.tsx");
    expect(zoom).toContain("allowDownscaling={!(active && sharp)}");
    expect(zoom).toContain("if (now) setSharp(true);");
    expect(zoom).toContain("if (!active) setSharp(false);");
    expect(src("features/files/ImageViewer.tsx")).toContain("active={active}");
  });

  test("past its limits a zoom gives a little and comes back; past its edges a picture resists, never stops dead", () => {
    // The rubber band starts at its follow rate and never reaches its limit; undone, it gives the finger's travel back.
    expect(rubberBand(10, 400, EDGE_RESISTANCE)).toBeCloseTo(10 * EDGE_RESISTANCE, 0);
    expect(rubberBand(100_000, 400, EDGE_RESISTANCE)).toBeLessThan(400);
    expect(rubberBand(-100, 800, 0.8)).toBeCloseTo(-rubberBand(100, 800, 0.8));
    expect(unRubberBand(rubberBand(250, 400, EDGE_RESISTANCE), 400, EDGE_RESISTANCE)).toBeCloseTo(250);
    // Inside the edges a drag is the finger's own; past one it resists more and more; on an axis with no room, none.
    expect(rubberClamp(50, -100, 100, 400)).toBe(50);
    expect(rubberClamp(200, -100, 100, 400)).toBeGreaterThan(100);
    expect(rubberClamp(200, -100, 100, 400)).toBeLessThan(200);
    expect(rubberClamp(-200, -100, 100, 400)).toBeCloseTo(-rubberClamp(200, -100, 100, 400));
    expect(rubberClamp(30, 0, 0, 400)).toBe(0);
    expect(dragWithin(90, 5, -100, 100, 400)).toBe(95);
    expect(dragWithin(0, 30, 0, 0, 400)).toBe(0);
    // Step by step past the edge is the same as one long drag, and back in it comes out of the stretch as it went in.
    let at = 90;
    for (let i = 0; i < 10; i++) at = dragWithin(at, 10, -100, 100, 400);
    expect(at).toBeCloseTo(rubberClamp(190, -100, 100, 400));
    for (let i = 0; i < 10; i++) at = dragWithin(at, -10, -100, 100, 400);
    expect(at).toBeCloseTo(90);
    // A pinch gives at most `ZOOM_GIVE` of its limit more, under 1× or over its most.
    expect(resistedZoom(2, 1, 4)).toBe(2);
    expect(resistedZoom(8, 1, 4)).toBeGreaterThan(4);
    expect(resistedZoom(1000, 1, 4)).toBeLessThan(4 * (1 + ZOOM_GIVE));
    expect(resistedZoom(0.2, 1, 4)).toBeLessThan(1);
    expect(resistedZoom(0, 1, 4)).toBeGreaterThan(1 - ZOOM_GIVE);
    // Let go, it comes back inside its limits around the fingers, over the whole screen.
    const screen = { width: 400, height: 800 };
    const wide = { width: 400, height: 200 };
    const under = pinchRest(wide, screen, { scale: 0.8, x: 0, y: 0 }, { x: 50, y: 0 }, 4);
    expect(under.scale).toBe(1);
    expect(under.x).toBeCloseTo(0);
    expect(under.y).toBeCloseTo(0);
    const over = pinchRest(wide, screen, { scale: 5, x: 0, y: 0 }, { x: 100, y: 0 }, 4);
    expect(over.scale).toBe(4);
    // The spot between the fingers (100 from the middle) stays there: it was the picture's 20 at 5×, still at 4×.
    expect(over.x + over.scale * 20).toBeCloseTo(100);
    expect(pinchRest(wide, screen, { scale: 2, x: 900, y: 0 }, { x: 0, y: 0 }, 4).x).toBe(panRoom(wide, 2, screen).x);
  });

  test("the pull to close tracks the finger, can be caught again, and closes once", () => {
    const viewer = src("features/files/ImageViewer.tsx");
    expect(viewer).toContain("pullY.value = from.value.y + e.translationY;");
    expect(viewer).toContain("from.value = { x: pullX.value, y: pullY.value };");
    // A closing picture takes no other pull, and closing is one step back, never two (the conversation went too).
    expect(viewer).toContain("if (leaving.value) return;");
    expect(viewer).toContain("if (closed.current) return;");
    // Only the picture in sight, at 1×, while the pages are still.
    expect(viewer).toContain("enabled: active && !zoomed && !paging,");
    // It shrinks around the spot the finger took, from rest; caught mid-spring, around the one before.
    expect(viewer).toContain("if (resting)");
    expect(viewer).toContain("pulledPlacement(pullX.value, pullY.value, screen, grab.value)");
  });

  test("let go, a pull leaves or springs back from its own speed; with reduced motion it fades", () => {
    const viewer = src("features/files/ImageViewer.tsx");
    expect(viewer).toContain("if (pullCloses(travel, e.velocityY, screen.height)) {");
    expect(viewer).toContain("velocity: awaySpeed(direction, e.velocityY),");
    expect(viewer).toContain("pullX.value = withSpring(0, { ...BACK_SPRING, velocity: e.velocityX });");
    expect(viewer).toContain("pullY.value = withSpring(0, { ...BACK_SPRING, velocity: e.velocityY });");
    // A fade is an opacity change, kept with reduced motion (the system setting would skip it otherwise).
    expect(viewer).toContain("if (reducedMotion) shown.value = withTiming(0, FADE_OUT);");
    expect(viewer).toContain("const FADE_OUT = { duration: 180, reduceMotion: ReduceMotion.Never };");
  });

  test("a pull closes where it would come to rest far enough away: a flick or a long pull, never speed alone", () => {
    const tall = 800;
    const far = Math.max(DISMISS_DISTANCE, tall * DISMISS_SHARE);
    expect(far).toBe(120);
    expect(pullProjection(30, 1000)).toBeCloseTo(30 + 1000 * PULL_PROJECTION);
    // Slow: by distance, either way.
    expect(pullCloses(far + 1, 0, tall)).toBe(true);
    expect(pullCloses(-(far + 1), 0, tall)).toBe(true);
    expect(pullCloses(far - 1, 0, tall)).toBe(false);
    // A flick closes a short pull; an easy release (what used to close any outward pull) doesn't.
    expect(pullCloses(20, 2000, tall)).toBe(true);
    expect(pullCloses(-20, -2000, tall)).toBe(true);
    expect(pullCloses(20, 250, tall)).toBe(false);
    expect(pullCloses(60, 400, tall)).toBe(false);
    // Flung back toward the middle it stays; still far away when let go, it closes the way it was pulled.
    expect(pullCloses(300, -2000, tall)).toBe(false);
    expect(pullCloses(300, -500, tall)).toBe(true);
    expect(pullDirection(300, -500)).toBe(1);
    expect(pullDirection(20, -2000)).toBe(-1);
    expect(pullDirection(-150, 0)).toBe(-1);
    expect(pullDirection(150, 0)).toBe(1);
    // A closing picture leaves at its own speed, never first back toward the middle.
    expect(awaySpeed(1, 1500)).toBe(1500);
    expect(awaySpeed(1, -500)).toBe(0);
    expect(awaySpeed(-1, -1500)).toBe(-1500);
    expect(awaySpeed(-1, 300)).toBe(0);
  });

  test("a pulled picture stays under the finger up and down, follows it loosely sideways, and shrinks around it", () => {
    const screen = { width: 400, height: 800 };
    const grab = { x: 60, y: 250 };
    // At rest it stays where it is.
    expect(pulledPlacement(0, 0, screen, grab)).toEqual({ x: 0, y: 0, scale: 1 });
    // The spot the finger took, wherever it moves the picture and however small it gets: exactly the finger's travel
    // down and up, looser sideways (the spot on screen = the picture's move + its scale times the spot).
    for (const travel of [40, 180, 400, -260]) {
      const at = pulledPlacement(0, travel, screen, grab);
      expect(at.y + at.scale * grab.y).toBeCloseTo(grab.y + travel);
      expect(at.x + at.scale * grab.x).toBeCloseTo(grab.x);
    }
    const side = pulledPlacement(100, 0, screen, grab);
    expect(side.x + side.scale * grab.x - grab.x).toBeGreaterThan(0);
    expect(side.x + side.scale * grab.x - grab.x).toBeLessThan(100);
    // Half a screen away: three quarters of its size, the black gone.
    expect(pulledPlacement(0, 400, screen, grab).scale).toBeCloseTo(DISMISS_MIN_SCALE);
    expect(pullProgress(400, 800)).toBe(1);
    expect(pullProgress(-200, 800)).toBe(0.5);
  });

  test("a page still loading, or one that couldn't, is swiped away like a picture and says so, with Try again", () => {
    const viewer = src("features/files/ImageViewer.tsx");
    // The waiting page and the video's page sit in the pull too, not only a loaded picture.
    expect(viewer.match(/<GestureDetector gesture=\{pull\}>/g)?.length).toBe(2);
    expect(viewer).toContain("failed={link.isError}");
    expect(viewer).toContain("retrying={link.isFetching}");
    const zoom = src("features/files/ZoomPicture.tsx");
    expect(zoom).toContain('{t("mobile.files.loadFailed")}');
    expect(zoom).toContain(
      '<Button variant="secondary" size="sm" label={t("mobile.common.retry")} loading={retrying} onPress={onRetry} />',
    );
    // Only the button takes a touch: the rest of the page keeps the pull.
    expect(zoom).toContain('pointerEvents="box-none"');
    expect(zoom).toContain("{pixels ? null : <PageWait failed={failed} onRetry={retry} />}");
  });

  test("a video and a PDF read their file once: the app coming back or a new link never starts them over", () => {
    const source = src("features/files/source.ts");
    expect(source).toContain('staleTime: "static" as const,');
    expect(source).toContain("refetchOnWindowFocus: false,");
    expect(source).toContain("refetchOnReconnect: false,");
    expect(source).toContain('queryKey: once ? [...shared, "once", view] : shared,');
    const viewer = src("features/files/ImageViewer.tsx");
    expect(viewer).toContain("useRemoteFile(orgId, id, version, { once: true })");
    expect(viewer).toMatch(/key=\{`\$\{id\}@\$\{version \?\? "latest"\}`\}/);
    const message = src("features/files/MessageFiles.tsx");
    expect(message).toContain("useRemoteFile(orgId, file.id, file.version, { once: true })");
    expect(message).toMatch(/key=\{`\$\{file\.id\}@\$\{file\.version \?\? "latest"\}`\}/);
    // A PDF: a copy in the cache per version, drawn from there (ADR 0208), read once while the screen stays; the same
    // copy its cards' first page is drawn from (`usePdfCopy`).
    expect(src("features/files/PdfPages.tsx")).toContain("const copy = usePdfCopy(detail);");
    const pdf = src("features/files/pdf-preview.tsx");
    expect(pdf).toContain("const path = await pdfCopy(api, orgId, detail);");
    expect(pdf).toContain("staleTime: Number.POSITIVE_INFINITY,");
    expect(source).toContain("if (file.exists && (file.size ?? 0) > 0) return file.uri;");
    // Never keyed on the link itself, which changes every few minutes.
    for (const file of ["features/files/ImageViewer.tsx", "features/files/MessageFiles.tsx"])
      expect({ file, uri: /key=\{(video)?[sS]ource\.uri\}/.test(src(file)) }).toEqual({ file, uri: false });
  });

  test("on Android a video draws with the views around it, inside rounded corners and under a pull", () => {
    const player = src("features/files/VideoPlayer.tsx");
    expect(player).toContain('const SURFACE = "textureView";');
    expect(player.match(/surfaceType=\{SURFACE\}/g)?.length).toBe(3);
  });

  test("a picture fits whole, zooms up to twice its own pixels, and a double tap zooms in at the spot", () => {
    const screen = { width: 400, height: 800 };
    // A wide picture is as wide as the screen; a tall one as tall.
    expect(fitted(2, screen)).toEqual({ width: 400, height: 200 });
    expect(fitted(0.25, screen)).toEqual({ width: 200, height: 800 });
    expect(fitted(null, screen)).toEqual(screen);
    expect(maxZoom(undefined, 400)).toBe(2);
    expect(maxZoom(1200, 400)).toBe(6);
    expect(maxZoom(100_000, 400)).toBe(10);
    // A wide picture zooms in enough to fill the screen's height.
    const wide = { width: 400, height: 200 };
    expect(doubleTapZoom(wide, screen, 10)).toBe(4);
    expect(doubleTapZoom(wide, screen, 3)).toBe(3);
    // iOS: the part to show keeps the tapped spot under the finger, inside the picture.
    const rect = zoomInRect(wide, screen, { x: 100, y: 400 }, 10);
    expect(rect.width).toBe(100);
    expect(rect.height).toBe(200);
    expect(rect.x).toBe(75);
    expect(rect.y).toBe(0);
    // Android: the same spot stays under the finger, the picture over the whole screen.
    const at = zoomInAt(wide, screen, { x: -100, y: 0 }, 10);
    expect(at.scale).toBe(4);
    expect(at.x).toBe(300);
    expect(at.y).toBeCloseTo(0);
    expect(panRoom(wide, 4, screen)).toEqual({ x: 600, y: 0 });
    expect(panRoom(wide, 1, screen)).toEqual({ x: 0, y: 0 });
  });

  test("a video plays in the system's player with its controls, never controls of ours over it", () => {
    const player = src("features/files/VideoPlayer.tsx");
    // In full screen the platform's controls are the only way back out: they are always on where it plays.
    expect(player).toContain("nativeControls\n");
    expect(player).not.toContain("enterFullscreen");
    expect(player).not.toContain("<Glass");
  });
});

describe("a document's head", () => {
  test("a file is a pushed screen: the native bar holds its name and its line, Send a copy and the ⋯", () => {
    // Pushed, never a full-screen modal: the app's sheets, menus and toasts live at the root, under a modal.
    expect(ownOptionsOf("file/[id]")).toBe("solid,");
    const viewer = src("features/files/DocumentViewer.tsx");
    expect(viewer).toContain("<PushedHeader");
    expect(viewer).toContain('title={info?.name ?? ""}');
    expect(viewer).toContain("subtitle={info && detail ? line(info, [dir.nameOf(detail.createdBy)]) : undefined}");
    expect(viewer).toContain("actions={bar}");
    // The system's share sheet says what it does; the ⋯ is the system's menu on iOS and the app's list on Android.
    expect(viewer).toContain('label: t("mobile.files.sendCopy")');
    expect(viewer).toContain("menu: choices,");
    expect(viewer).toContain('onPress: () => chooseAction(info?.name ?? "", choices, t("mobile.common.cancel"))');
    // No bar drawn by the screen, no toast host of its own, no buttons docked under the file.
    for (const gone of ["ToastHost", "styles.top", "styles.bar", "insets.top", 'icon="x"'])
      expect({ gone, there: viewer.includes(gone) }).toEqual({ gone, there: false });
  });

  test("Copiar texto says it copied, with a tap; it's in the ⋯ once the text is read", () => {
    const viewer = src("features/files/DocumentViewer.tsx");
    const copy = viewer.slice(viewer.indexOf("const copy = () => {"), viewer.indexOf("const inDrive ="));
    expect(copy).toContain("if (ok) successHaptic();");
    expect(copy).toContain('{ title: t("contextMenu.textCopied"), icon: "copy" }');
    expect(copy).toContain('{ title: t("mobile.app.failed"), icon: "x" }');
    expect(viewer).toContain("...(textual && text.data !== undefined");
  });

  test("a picture's head: × on the left, the name and its line centred beside it, a space as wide on the right", () => {
    const viewer = readFileSync(join(import.meta.dir, "../../src/features/files/ImageViewer.tsx"), "utf8");
    const top = viewer.slice(viewer.indexOf("style={[styles.top,"), viewer.indexOf("</Chrome>"));
    expect(top.indexOf('icon="x"')).toBeGreaterThan(-1);
    expect(top.indexOf('icon="x"')).toBeLessThan(top.indexOf("{info?.name"));
    // One line each, a long name shortened in its middle so the kind of file stays.
    expect(top).toContain('numberOfLines={1} ellipsizeMode="middle"');
    expect(top.indexOf("{info?.name")).toBeLessThan(top.indexOf('<View pointerEvents="none" style={styles.round} />'));
    expect(viewer).toContain('title: { flex: 1, minWidth: 0, alignItems: "center" },');
    expect(viewer).not.toContain('flexBasis: "100%"');
  });

  test("a picture's actions are the row at the bottom, never repeated in a ⋯, and Share has one icon", () => {
    const viewer = src("features/files/ImageViewer.tsx");
    expect(viewer).not.toContain('icon="more"');
    expect(viewer).not.toContain("actions.more");
    expect(viewer).toContain('<Action icon="person" label={t("share.button")}');
    // A document's ⋯ draws Share with the same icon, and both say Enviar cópia for the system's share sheet.
    const document = src("features/files/DocumentViewer.tsx");
    expect(document).toMatch(
      /icon: "person" as const,\s+sf: "person\.badge\.plus" as const,\s+label: t\("share\.button"\)/,
    );
    expect(document).not.toContain('"members"');
    expect(viewer).toContain('label={t("mobile.files.sendCopy")}');
  });

  test("a file on its way into the Drive holds a card's place, its name and a spinner, until it's there", () => {
    const upload = src("features/drive/useDriveUpload.ts");
    expect(upload).toContain("setUploading(a.name);");
    expect(upload).toContain("return { busy: uploading !== null, uploading, pick: () => void pick() };");
    const screen = src("features/drive/DriveScreen.tsx");
    expect(screen).toContain("<UploadingCard name={uploader.uploading} />");
    const card = src("features/drive/DriveCard.tsx");
    expect(card).toContain('{t("mobile.chat.uploading")}');
    expect(card).toContain("<ActivityIndicator color={c.faint} />");
  });

  test("among files a picture is only the picture, two to a row; a file takes the row, its name whole", () => {
    const tile = src("features/files/AttachmentTile.tsx");
    // The foot (icon, name, kind and size) only under a file; a picture's name and size are what VoiceOver says.
    expect(tile).toMatch(/\{picture \? null : \(\s*<View style=\{styles\.foot\}>/);
    expect(tile).toMatch(/accessibilityLabel=\{`\$\{name\}, \$\{meta\}`\}/);
    // Known to be a picture by its name before it loads, so it never sheds a foot once it does.
    expect(tile).toContain('const picture = info ? info.view === "image" : seen;');
    const foot = tile.slice(tile.indexOf("<View style={styles.foot}>"), tile.indexOf("function fileIconOf("));
    expect(foot).not.toContain("numberOfLines");
    expect(foot).toContain('<LineIcon name={icon} size={14} color={c.faint} variant="footnote" />');
    const files = src("features/files/MessageFiles.tsx");
    expect(files).toContain("width={picture ? halfWidth : blockWidth}");
    expect(files).toContain("...images.map((i) => ({ ...i, failed: false, picture: true }))");
  });

  test("the line under a file's name breaks between its facts, never inside one", () => {
    const files = readFileSync(join(import.meta.dir, "../../src/features/files/MessageFiles.tsx"), "utf8");
    expect(files.slice(files.indexOf("export function useFileLine("))).toMatch(
      /\]\s*\.map\(keepWhole\)\s*\.join\(" · "\)/,
    );
    const image = readFileSync(join(import.meta.dir, "../../src/features/files/ImageViewer.tsx"), "utf8");
    expect(image).toContain('[place, author, savedWhen(savedAt(detail))].filter(Boolean).map(keepWhole).join(" · ")');
  });

  test("a chart opened whole: × alone on the bar, its title on a row of its own under it, never cut", () => {
    const chart = readFileSync(join(import.meta.dir, "../../src/features/chat/ChartCard.tsx"), "utf8");
    // The task sheets' bar with no title: × alone (the chart's own bar, not the one over "nothing to show").
    const shown = chart.indexOf("stickyHeaderIndices={[0]}");
    const bar = chart.slice(chart.indexOf("<SheetBar", shown), chart.indexOf("{chart.spec.title}", shown));
    expect(bar).toStartWith("<SheetBar onClose={() => router.back()} />");
    expect(bar).not.toContain("title=");
    expect(bar).not.toContain("numberOfLines");
    expect(chart).not.toContain("sheetSpacer");
    // The scroll view is the sheet's first child, the bar pinned in it: a form sheet sizes its first scroll view to
    // the whole sheet, and a bar standing before it was drawn over the chart.
    const sheet = chart.slice(
      chart.indexOf("export function ChartSheet()"),
      chart.indexOf("export function ChartView("),
    );
    expect(sheet.slice(sheet.lastIndexOf("return (")).trimStart()).toMatch(/^return \(\s*<ScrollView\b/);
    expect(sheet).toContain("stickyHeaderIndices={[0]}");
  });

  test("a browser profile's sign-in screen keeps its line whole: the bar says the title, the line wraps under it", () => {
    const screen = readFileSync(join(import.meta.dir, "../../src/features/browser/ProfileLoginScreen.tsx"), "utf8");
    // The native bar's title, and no drawn bar of its own.
    expect(screen).toContain("<PushedHeader");
    expect(screen).not.toContain("styles.top");
    // Where it runs and who waits: a line in the page, never the bar's one cut line.
    const line = screen.slice(screen.indexOf('<Text variant="footnote"'), screen.indexOf("<BrowserCard"));
    expect(line).toContain("browser.profiles.controlSubOn");
    expect(line).not.toContain("numberOfLines");
  });
});
