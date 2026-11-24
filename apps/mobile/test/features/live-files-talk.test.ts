import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LiveRef } from "@agenteschat/client";
import type { DocBlock } from "@agenteschat/live/document";
import { tapOnPlaced, tapOnZoomed } from "../../src/features/files/zoom";
import { appLinkFromUrl } from "../../src/features/links/app-links";
import { fileHref, hrefForPush, hrefFromUrl, notificationHref } from "../../src/features/links/logic";
import {
  canvasSelection,
  clampCrop,
  croppedPicture,
  isInk,
  STROKE_MAX,
  strokeOf,
  strokeShape,
  thinPoints,
} from "../../src/features/live-files/canvas/logic";
import {
  askSelection,
  blockStyle,
  editable,
  listNumbers,
  restyled,
  toggledList,
  toggledQuote,
} from "../../src/features/live-files/document/logic";
import { talkIcon } from "../../src/features/live-files/routes";
import {
  aboutParts,
  aboutWords,
  askText,
  commentSelection,
  DRAFT_PIN,
  draftPin,
  fileAgentId,
  fileUnder,
  lastWords,
  mediaPins,
  oneLine,
  pagePins,
  picturePins,
  pinAnchor,
  pinUnder,
  pointMark,
  sheetParts,
  talkKindOf,
  talkLine,
  talkPins,
  withSending,
} from "../../src/features/live-files/talk/logic";

/**
 * A live file's own conversation on the phone (ADR 0199) and the tools around it: the line under the file, the quote
 * over the composer and the line over a message, the file's agent, the canvas's comment pins and pen, the document's
 * blocks edited one at a time (ADR 0200), the links and notices that open a file at a message, and the comments
 * pinned on a picture, a video or a PDF (ADR 0208).
 */

/** The words' keys with what they were given, so a test reads which words and values were picked. */
const t = (key: string, o?: Record<string, unknown>) => (o ? `${key} ${JSON.stringify(o)}` : key);

const src = (file: string) => readFileSync(join(import.meta.dir, "../../src", file), "utf8");

describe("the quote and the line about the file", () => {
  test("each kind words its quote: cells in a sheet, a slide, canvas items or a spot, a document's passage", () => {
    expect(sheetParts("Custos!C2:D6")).toEqual({ sheet: "Custos", range: "C2:D6" });
    expect(sheetParts("Planilha 1!B2")).toEqual({ sheet: "Planilha 1", range: "B2" });
    expect(sheetParts("!B2")).toBeNull();
    expect(aboutWords(t, "spreadsheet", { label: "Custos!C2:D6", sheet: "s1", range: "C2:D6" })).toBe(
      'live.conversation.about.range {"sheet":"Custos","range":"C2:D6"}',
    );
    expect(aboutWords(t, "slides", { label: "Slide 3", slide: "x" })).toBe('live.conversation.about.slide {"n":"3"}');
    expect(aboutWords(t, "canvas", { label: "1 imagem", shapes: ["a"] })).toBe(
      'live.conversation.about.canvas {"label":"1 imagem"}',
    );
    expect(aboutWords(t, "canvas", { label: "Comentário", point: { x: 1, y: 2 } })).toBe("mobile.live.talk.aboutPoint");
    expect(aboutWords(t, "document", { label: "“Oi”", block: "b1", text: "Oi" })).toBe("live.conversation.about.text");
  });

  test("a message's line: what in bold, where quietly; the file alone with nothing chosen", () => {
    const ref = (r: Partial<LiveRef>): LiveRef => ({ artifactId: "f1", kind: "spreadsheet", title: "Orçamento", ...r });
    expect(aboutParts(t, ref({ selection: { label: "Custos!C2:D6" } }))).toEqual({ what: "C2:D6", where: "Custos" });
    expect(aboutParts(t, ref({ kind: "canvas", title: "Banner", selection: { label: "1 imagem" } }))).toEqual({
      what: "1 imagem",
      where: "Banner",
    });
    expect(aboutParts(t, ref({ kind: "slides" }))).toEqual({ what: "Orçamento", where: "live.kinds.slides" });
    expect(aboutParts(t, ref({ title: "" }))).toEqual({
      what: "live.conversation.untitled",
      where: "live.kinds.spreadsheet",
    });
  });
});

describe("the line under the file", () => {
  test("an agent at work wins, then the last message, then the invitation", () => {
    expect(talkLine({ count: 4, working: { agentId: "a1", text: "Atlas está criando…" }, last: null })).toEqual({
      state: "working",
      agentId: "a1",
      text: "Atlas está criando…",
      count: 4,
    });
    const last = { name: "Atlas", text: "Pronto, **somei** por situação." };
    expect(talkLine({ count: 3, working: null, last })).toEqual({
      state: "last",
      text: "Atlas: Pronto, somei por situação.",
      count: 3,
    });
    expect(talkLine({ count: 0, working: null, last: null })).toEqual({ state: "start", count: 0 });
    // Its messages not loaded yet: the count alone.
    expect(talkLine({ count: 2, working: null, last: null })).toEqual({ state: "last", text: "", count: 2 });
  });

  test("the last message on one line, Markdown's marks out", () => {
    expect(oneLine("Veja [o plano](https://x.y)\n\n- *um*\n- `dois`")).toBe("Veja o plano - um - dois");
    expect(oneLine("```\ncode\n```\nfim")).toBe("fim");
    expect(lastWords("Ada", "")).toBe("Ada");
    expect(lastWords("", "oi")).toBe("oi");
  });
});

describe("the file's agent", () => {
  const askable = (id: string) => id !== "no";
  const base = {
    spoke: [] as { type: string; id: string | null }[],
    participants: [] as { type: string; id: string | null }[],
    rightHandId: "rh",
    agentIds: ["first", "rh"],
    askable,
  };
  test("its maker, else the last agent that spoke, else one who took part, else the right hand", () => {
    expect(fileAgentId({ ...base, createdBy: { type: "agent", id: "atlas" } })).toBe("atlas");
    const spoke = [
      { type: "agent", id: "iris" },
      { type: "person", id: "ada" },
      { type: "agent", id: "theo" },
      { type: "agent", id: "no" },
    ];
    expect(fileAgentId({ ...base, createdBy: { type: "person", id: "ada" }, spoke })).toBe("theo");
    expect(
      fileAgentId({ ...base, createdBy: { type: "agent", id: "no" }, participants: [{ type: "agent", id: "iris" }] }),
    ).toBe("iris");
    expect(fileAgentId({ ...base, createdBy: { type: "person", id: "ada" } })).toBe("rh");
    expect(fileAgentId({ ...base, rightHandId: null, createdBy: { type: "person", id: "ada" } })).toBe("first");
    expect(fileAgentId({ ...base, agentIds: ["no"], rightHandId: "no", createdBy: { type: "person", id: "a" } })).toBe(
      null,
    );
  });

  test("Ask Atlas writes its handle, and the words when there are some", () => {
    expect(askText("atlas")).toBe("@atlas ");
    expect(askText("atlas", "faz variações desta imagem")).toBe("@atlas faz variações desta imagem");
  });
});

describe("comment pins and the way back to the file", () => {
  test("the conversation's messages about this file with a spot, numbered in order", () => {
    const at = (x: number, y: number) => ({ label: "Comentário", point: { x, y } });
    const msg = (id: string, ref: LiveRef | null) => ({ id, author: { type: "person", id: "ada" }, liveRef: ref });
    const pins = talkPins("f1", [
      msg("m1", { artifactId: "f1", kind: "canvas", title: "B", selection: at(10, 20) }),
      msg("m2", { artifactId: "f1", kind: "canvas", title: "B", selection: { label: "1 imagem", shapes: ["s"] } }),
      msg("m3", null),
      msg("m4", { artifactId: "other", kind: "canvas", title: "B", selection: at(1, 1) }),
      msg("m5", { artifactId: "f1", kind: "canvas", title: "B", selection: at(-5, 7) }),
    ]);
    expect(pins.map((p) => [p.messageId, p.n, p.at])).toEqual([
      ["m1", 1, { x: 10, y: 20 }],
      ["m5", 2, { x: -5, y: 7 }],
    ]);
  });

  test("a message's line goes back when the file is right under the conversation, else opens it", () => {
    const routes = [
      { name: "(tabs)" },
      { name: "canvas/[id]", params: { id: "f1" } },
      { name: "chat/[channelId]", params: { channelId: "c1" } },
    ];
    expect(fileUnder(routes, "f1")).toBe(true);
    expect(fileUnder(routes, "f2")).toBe(false);
    expect(fileUnder([{ name: "chat/[channelId]" }], "f1")).toBe(false);
    expect(fileUnder(undefined, "f1")).toBe(false);
    // A PDF's screen under its conversation (ADR 0208) is gone back to as well.
    expect(fileUnder([{ name: "file/[id]", params: { id: "p1" } }, { name: "chat/[channelId]" }], "p1")).toBe(true);
    // The picture viewer, when the page it is on is that file.
    const viewer = (at: string) => [{ name: "images", params: { files: "i1@2,i2", at } }, { name: "chat/[channelId]" }];
    expect(fileUnder(viewer("1"), "i2")).toBe(true);
    expect(fileUnder(viewer("0"), "i2")).toBe(false);
    expect(fileUnder(viewer("0"), "i1")).toBe(true);
  });
});

describe("a picture's, a video's and a PDF's conversation (ADR 0208)", () => {
  test("which files have one: a live file by its kind, a picture, a video or a PDF by its type", () => {
    expect(talkKindOf({ kind: "canvas" })).toBe("canvas");
    expect(talkKindOf({ kind: "file", content: { kind: "file", contentType: "image/png" } })).toBe("image");
    expect(talkKindOf({ kind: "file", content: { kind: "file", contentType: "video/mp4" } })).toBe("video");
    expect(talkKindOf({ kind: "file", content: { kind: "file", contentType: "application/pdf" } })).toBe("pdf");
    expect(talkKindOf({ kind: "file", content: { kind: "file", contentType: "text/plain" } })).toBeNull();
    expect(talkKindOf(undefined)).toBeNull();
    expect([talkIcon("image"), talkIcon("video"), talkIcon("pdf"), talkIcon("canvas")]).toEqual([
      "image",
      "play",
      "file",
      "canvas",
    ]);
  });

  test("the quote over the composer says the pin's number, the moment or the page", () => {
    expect(aboutWords(t, "image", { label: "4", mark: { x: 0.1, y: 0.2 } })).toBe(
      'live.conversation.about.imagePoint {"n":"4"}',
    );
    expect(aboutWords(t, "image", { label: "2", mark: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 } })).toBe(
      'live.conversation.about.imageArea {"n":"2"}',
    );
    expect(aboutWords(t, "video", { label: "1", time: 42.4 })).toBe('live.conversation.about.videoAt {"time":"0:42"}');
    expect(aboutWords(t, "pdf", { label: "1", page: 3 })).toBe('live.conversation.about.pdfPage {"page":3}');
    expect(aboutWords(t, "image", { label: "Foto" })).toBe("live.conversation.about.image");
  });

  test("a comment's line: what it points at in bold, on what quietly; the file alone with nothing marked", () => {
    const ref = (r: Partial<LiveRef>): LiveRef => ({ artifactId: "f1", kind: "image", title: "Banner.png", ...r });
    expect(aboutParts(t, ref({ selection: { label: "1", mark: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } } }))).toEqual({
      what: 'live.conversation.what.area {"n":"1"}',
      where: "live.conversation.where.image",
    });
    const moment = ref({ kind: "video", selection: { label: "2", time: 65, mark: { x: 0.5, y: 0.5 } } });
    expect(aboutParts(t, moment)).toEqual({
      what: '1:05 · live.conversation.what.point {"n":"2"}',
      where: "live.conversation.where.video",
    });
    expect(aboutParts(t, ref({ kind: "pdf", selection: { label: "3", page: 2 } }))).toEqual({
      what: 'live.conversation.what.page {"page":2}',
      where: "live.conversation.where.pdf",
    });
    expect(aboutParts(t, ref({}))).toEqual({ what: "Banner.png", where: "live.conversation.where.image" });
  });

  test("its comments with a pin, numbered oldest first; a resolved one keeps its number and leaves the picture", () => {
    const by = { type: "person", id: "p1" };
    const on = (id: string, selection: LiveRef["selection"], meta?: Record<string, unknown>) => ({
      id,
      author: by,
      liveRef: { artifactId: id === "m4" ? "other" : "f1", kind: "image" as const, title: "B", selection },
      ...(meta ? { meta } : {}),
    });
    const resolved = { resolved: { by: { type: "agent", id: "a1" }, at: "2026-01-02T10:00:00.000Z" } };
    const pins = mediaPins(
      "f1",
      [
        on("m1", { label: "1", mark: { x: 0.2, y: 0.3 }, version: 1 }),
        on("m2", { label: "Banner" }),
        on("m3", { label: "2", mark: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, version: 2 }, resolved),
        on("m4", { label: "1", mark: { x: 0.5, y: 0.5 } }),
        on("m5", { label: "3", time: 12 }),
        on("m6", { label: "4", mark: { x: 0.6, y: 0.7 }, version: 2 }),
      ],
      2,
    );
    expect(pins.map((p) => [p.messageId, p.n, p.old, p.resolved !== null])).toEqual([
      ["m1", 1, true, false],
      ["m3", 2, false, true],
      ["m5", 3, false, false],
      ["m6", 4, false, false],
    ]);
    expect(picturePins(pins).map((p) => p.messageId)).toEqual(["m1", "m6"]);
    // The next comment takes the next number, on the version shown; a video's moment to the tenth of a second.
    expect(commentSelection(pins, { mark: { x: 0.25, y: 0.5 } }, 2)).toEqual({
      label: "5",
      mark: { x: 0.25, y: 0.5 },
      version: 2,
    });
    expect(commentSelection([], { time: 12.345 }, 1)).toEqual({ label: "1", time: 12.3, version: 1 });
    // A video's tap: its moment and the point on its frame; a PDF's: its page (from 1) and the point on it.
    expect(commentSelection(pins, { time: 7.46, mark: { x: 0.6, y: 0.3 } }, 2)).toEqual({
      label: "5",
      mark: { x: 0.6, y: 0.3 },
      time: 7.5,
      version: 2,
    });
    expect(commentSelection([], { page: 3, mark: { x: 0.1, y: 0.4 } }, 1)).toEqual({
      label: "1",
      mark: { x: 0.1, y: 0.4 },
      page: 3,
      version: 1,
    });
  });

  test("the comment being written stands on the file as the person's pin, numbered as it will be", () => {
    const me = { type: "user", id: "u1" };
    const about = (selection: LiveRef["selection"], artifactId = "f1"): LiveRef => ({
      artifactId,
      kind: "image",
      title: "Banner",
      ...(selection ? { selection } : {}),
    });
    expect(draftPin(about({ label: "4", mark: { x: 0.62, y: 0.22 }, version: 1 }), "f1", me)).toEqual({
      messageId: DRAFT_PIN,
      author: me,
      n: 4,
      selection: { label: "4", mark: { x: 0.62, y: 0.22 }, version: 1 },
      resolved: null,
      old: false,
    });
    // About the file as a whole, about another file, or nobody signed in: no draft on it.
    expect(draftPin(about({ label: "Banner" }), "f1", me)).toBeNull();
    expect(draftPin(about({ label: "4", mark: { x: 0.5, y: 0.5 } }, "f2"), "f1", me)).toBeNull();
    expect(draftPin(about({ label: "4", mark: { x: 0.5, y: 0.5 } }), "f1", null)).toBeNull();
    expect(draftPin(null, "f1", me)).toBeNull();
  });

  test("a PDF's page shows its own pins", () => {
    const at = (messageId: string, selection: LiveRef["selection"]) => ({
      id: messageId,
      author: { type: "user", id: "u1" },
      liveRef: { artifactId: "f1", kind: "pdf" as const, title: "Contrato", ...(selection ? { selection } : {}) },
    });
    const pins = mediaPins(
      "f1",
      [
        at("p1", { label: "1", page: 1, mark: { x: 0.8, y: 0.4 } }),
        at("p2", { label: "2", page: 2, mark: { x: 0.1, y: 0.1 } }),
        at("p3", { label: "3", page: 1 }),
        at("v1", { label: "4", time: 4, mark: { x: 0.3, y: 0.3 } }),
        at("v2", { label: "5", time: 7.5, mark: { x: 0.6, y: 0.3 } }),
        at("v3", { label: "6", time: 8 }),
      ],
      1,
    );
    expect(pagePins(pins, 1).map((p) => p.messageId)).toEqual(["p1"]);
    expect(pagePins(pins, 2).map((p) => p.messageId)).toEqual(["p2"]);
  });

  test("a tap finds the pin under it at any zoom, the newest on top; a held touch, a point on the picture", () => {
    const pin = (messageId: string, mark: { x: number; y: number; w?: number; h?: number }) => ({
      messageId,
      author: { type: "person", id: "p1" },
      n: 1,
      selection: { label: "1", mark },
      resolved: null,
      old: false,
    });
    // An area's pin stands at its top right corner.
    expect(pinAnchor({ x: 0.1, y: 0.1, w: 0.2, h: 0.3 })).toEqual({ x: 0.30000000000000004, y: 0.1 });
    const pins = [pin("a", { x: 0.5, y: 0.5 }), pin("b", { x: 0.5, y: 0.5 }), pin("c", { x: 0.1, y: 0.9 })];
    // Shown 200 wide: 20 points right of the spot and 5 over it is on the pin; 80 points off is not.
    expect(pinUnder(pins, { x: 0.6, y: 0.45, width: 200, height: 100 })?.messageId).toBe("b");
    expect(pinUnder(pins, { x: 0.9, y: 0.45, width: 200, height: 100 })).toBeNull();
    // Zoomed in four times the same fractions are farther apart on screen.
    expect(pinUnder(pins, { x: 0.6, y: 0.45, width: 800, height: 400 })).toBeNull();
    expect(pointMark({ x: 0.123456, y: 1 })).toEqual({ x: 0.1235, y: 1 });
    expect(pointMark({ x: -0.1, y: 0.5 })).toBeNull();
  });

  test("a tap on the screen lands on the picture where it shows, iOS's zoom and Android's", () => {
    const picture = { width: 300, height: 200 };
    const screen = { width: 400, height: 800 };
    // At 1× the picture sits in the middle of the screen.
    expect(tapOnZoomed({ x: 200, y: 400 }, picture, screen, 1, { x: -50, y: -300 })).toEqual({
      x: 0.5,
      y: 0.5,
      width: 300,
      height: 200,
    });
    // Zoomed four times and scrolled: where it is scrolled to, the axis it still fits on centered.
    expect(tapOnZoomed({ x: 200, y: 400 }, picture, screen, 4, { x: 400, y: 0 })).toEqual({
      x: 0.5,
      y: 0.5,
      width: 1200,
      height: 800,
    });
    expect(tapOnPlaced({ x: 200, y: 400 }, picture, screen, { scale: 1, x: 0, y: 0 })).toEqual({
      x: 0.5,
      y: 0.5,
      width: 300,
      height: 200,
    });
    expect(tapOnPlaced({ x: 200, y: 400 }, picture, screen, { scale: 2, x: -120, y: 0 }).x).toBeCloseTo(0.7);
  });

  test("a pin's corners follow its face, the corner on its spot cut sharp", () => {
    const pins = src("features/live-files/talk/PicturePins.tsx");
    expect(pins).toContain("borderRadius: 8,");
    expect(pins).toContain("borderBottomLeftRadius: 3,");
    expect(pins).not.toContain("MEDIA_PIN_H / 2");
    // The canvas's pins, the same shape.
    const plane = src("features/live-files/canvas/CanvasPlane.tsx");
    expect(plane).toContain("borderRadius: 8,");
    expect(plane).not.toContain("PIN_H / 2");
  });

  test("the viewer and the PDF's screen push the conversation; a held touch marks a point; a link opens it", () => {
    const viewer = src("features/files/ImageViewer.tsx");
    // One way in, the line; no Comment at the top. A played video's line opens it about that moment.
    expect(viewer).toContain("{talkFile ? <FileTalkLine file={talkFile} bare onOpen={openLine} /> : null}");
    expect(viewer).not.toContain('icon="comment"');
    expect(viewer).toContain("if (talkFile && time > PLAYED_S) openTalk({ selection: commentSelection(pins, { time }");
    // A touch held on the picture marks the point and opens the conversation about it; the draft's pin stays on it.
    expect(viewer).toContain("onLongPress={active ? held : undefined}");
    expect(viewer).toContain("openTalk({ selection: commentSelection(pins, where, talkFile.shownVersion) });");
    expect(viewer).toContain("<PicturePins pins={shownPins} zoom={zoom} draft={draft} />");
    expect(viewer).toContain('const about = useTalkAbout(talkFile?.conversation?.channelId ?? "");');
    expect(viewer).toMatch(/<ZoomPicture\s+source=\{link\.data\}\s+cacheKey=\{key\}\s+screen=\{screen\}/);
    // The held touch races the pull and the taps: a finger that moves first is the pull.
    const zoom = src("features/files/ZoomPicture.tsx");
    expect(zoom).toContain("const gesture = useCompetingGestures(hold, taps);");
    expect(zoom).toContain("const gesture = useCompetingGestures(hold, rest);");
    const document = src("features/files/DocumentViewer.tsx");
    expect(document).toContain("useTalkFocus(pdfTalk, focusId);");
    expect(document).toContain("{pdfTalk ? <FileTalkLine file={pdfTalk} /> : null}");
    expect(document).toContain("router.replace({ ...route, params: { ...route.params, m: focusId } });");
    // A PDF drawn by the system's renderer on both platforms, a held touch marking its page and point.
    expect(document).toContain('const pdf = info?.view === "pdf";');
    const pdf = src("features/files/PdfPages.tsx");
    expect(pdf).toContain('from "react-native-pdf-light"');
    expect(pdf).toContain("onLongPress={(e) => hold(e.nativeEvent.locationX, e.nativeEvent.locationY)}");
    expect(pdf).toContain("openTalk({ selection: commentSelection(pins, { mark, page }, detail.shownVersion) });");
  });

  test("Resolve and Reopen are in a comment's menu, and a resolved comment's pin and line follow the server", () => {
    const sheets = src("features/chat/sheets.tsx");
    expect(sheets).toContain("const resolvable = !m.local && isPinnedSelection(messageLiveRef(m)?.selection);");
    expect(sheets).toContain('key: "resolve",');
    expect(sheets).toContain('label: resolved ? t("files.comments.reopen") : t("files.comments.resolve"),');
    // The system's menu on iOS writes through the same hand.
    expect(src("features/chat/MessageMenu.tsx")).toContain(
      "resolve: (input, options) => writes.current?.resolve(input, options),",
    );
    // `message.resolved` in the conversation and on the file's screen.
    expect(src("features/chat/live.ts")).toContain('case "message.resolved":');
    expect(src("features/live-files/talk/hooks.ts")).toContain('if (event.type === "message.resolved") {');
    // Under a resolved comment, who resolved it.
    expect(src("features/chat/MessageRow.tsx")).toContain(
      "{resolved ? <ResolvedLine resolved={resolved} end={onRight} /> : null}",
    );
  });
});

describe("the conversation pushed over the file (ADR 0208)", () => {
  test("every file pushes its conversation, its back coming back to the file; no sheet over it", () => {
    const hooks = src("features/live-files/talk/hooks.ts");
    expect(hooks).toContain("router.push(chatHref(at.channelId, at.rootId, open.messageId ?? null));");
    expect(hooks).not.toContain("TalkSheet");
    const layout = readFileSync(join(import.meta.dir, "../../app/(app)/_layout.tsx"), "utf8");
    expect(layout).not.toContain("file-talk");
    // The viewer is a screen of the stack, so the conversation pushed from it shows over it, not hidden under it.
    const main = readFileSync(join(import.meta.dir, "../../app/(app)/(main)/_layout.tsx"), "utf8");
    expect(main).not.toContain('presentation: "transparentModal"');
    expect(src("features/files/ImageViewer.tsx")).toContain("navigation.setParams({ at: String(index) } as never);");
    // The conversation is the one every other is: no sheet mode, its bar the stack's.
    expect(src("features/chat/ChatScreen.tsx")).not.toContain("ChatSheet");
    expect(src("features/live-files/talk/TalkLine.tsx")).not.toContain("sheet");
  });

  test("a sent comment's pin stays while it is on its way", () => {
    // A comment on its way keeps its pin: its local copy counts until the server's copy (same clientId) takes its place.
    const a = { id: "m1", clientId: null };
    const echoed = { id: "m2", clientId: "c2" };
    const waiting = { id: "local-c2", clientId: "c2" };
    const fresh = { id: "local-c3", clientId: "c3" };
    expect(withSending([a], [])).toEqual([a]);
    expect(withSending([a], [fresh])).toEqual([a, fresh]);
    expect(withSending([a, echoed], [waiting, fresh])).toEqual([a, echoed, fresh]);
    expect(withSending([a], [a])).toEqual([a]);
    expect(src("features/live-files/talk/hooks.ts")).toContain("withSending(messages, sending).map((m) => ({");
  });
});

describe("the canvas's pen and its selection's words", () => {
  test("a stroke keeps the points far enough apart, always its last one, and fits the canvas's limit", () => {
    expect(thinPoints([0, 0, 1, 0, 2, 0, 10, 0, 10.5, 0], 2)).toEqual([0, 0, 2, 0, 10.5, 0]);
    expect(thinPoints([5, 5], 2)).toEqual([5, 5]);
    expect(thinPoints([], 2)).toEqual([]);
    const long = Array.from({ length: 3000 }, (_, i) => [i * 3, Math.sin(i) * 50]).flat();
    const thin = thinPoints(long, 1);
    expect(thin.length).toBeLessThanOrEqual(STROKE_MAX);
    expect(thin.slice(-2)).toEqual(long.slice(-2));
  });

  test("a stroke as a pen shape: its box, its points from the box's corner", () => {
    expect(strokeShape([10, 20, 30, 25, 15, 40])).toEqual({ x: 10, y: 20, w: 20, h: 20, points: [0, 0, 20, 5, 5, 20] });
    // A dot still has a box to stand in.
    expect(strokeShape([4, 4])).toEqual({ x: 4, y: 4, w: 1, h: 1, points: [0, 0] });
    expect(strokeShape([])).toBeNull();
  });

  test("what is chosen, in words for the quote: one kind counted, a mix as items", () => {
    expect(canvasSelection(t, [{ id: "a", type: "image" }])).toEqual({
      label: 'live.canvas.count.image {"count":1}',
      shapes: ["a"],
    });
    expect(
      canvasSelection(t, [
        { id: "a", type: "image" },
        { id: "b", type: "pending" },
      ])?.label,
    ).toBe('live.canvas.count.image {"count":2}');
    expect(
      canvasSelection(t, [
        { id: "a", type: "note" },
        { id: "b", type: "draw" },
      ])?.label,
    ).toBe('live.canvas.count.items {"count":2}');
    expect(canvasSelection(t, [])).toBeNull();
  });
});

describe("the canvas's pen bar and crop", () => {
  test("a stroke takes the bar's color and size; the highlighter is wide and says so", () => {
    expect(strokeOf({ tool: "pen", color: "#e5484d", size: "s" })).toEqual({ stroke: "#e5484d", strokeWidth: 2 });
    expect(strokeOf({ tool: "marker", color: "#f2a33a", size: "l" })).toEqual({
      stroke: "#f2a33a",
      strokeWidth: 24,
      tool: "marker",
    });
    expect(isInk("#151514")).toBe(true);
    expect(isInk("#000")).toBe(true);
    expect(isInk("#0063d1")).toBe(false);
    expect(isInk("nope")).toBe(false);
  });

  test("a crop keeps the part chosen of what shows, where it was, at its size", () => {
    const picture = { x: 100, y: 50, w: 400, h: 200 };
    expect(croppedPicture(picture, { x: 0.25, y: 0, w: 0.5, h: 0.5 })).toEqual({
      crop: { x: 0.25, y: 0, w: 0.5, h: 0.5 },
      x: 200,
      y: 50,
      w: 200,
      h: 100,
    });
    // Cropped again: inside the crop it had.
    const again = croppedPicture(
      { ...picture, crop: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 } },
      { x: 0.5, y: 0, w: 0.5, h: 1 },
    );
    expect(again.crop).toEqual({ x: 0.75, y: 0.5, w: 0.25, h: 0.5 });
    expect(clampCrop({ x: -1, y: 0.9, w: 3, h: 0.5 })).toEqual({ x: 0, y: 0.9, w: 1, h: 0.09999999999999998 });
  });
});

describe("a document's blocks on the phone", () => {
  const p = (text: string, more: Partial<Extract<DocBlock, { type: "paragraph" }>> = {}): DocBlock => ({
    type: "paragraph",
    id: "b1",
    runs: [{ text }],
    ...more,
  });

  test("which blocks the phone edits: words, not pictures or a quote of many parts", () => {
    expect(editable(p("x"))).toBe(true);
    expect(editable({ type: "code_block", id: "c", text: "a\nb" })).toBe(true);
    expect(editable({ type: "image", id: "i", asset: "a" })).toBe(false);
    expect(editable({ type: "blockquote", id: "q", blocks: [p("um"), p("dois")] })).toBe(false);
    expect(editable({ type: "blockquote", id: "q", blocks: [p("um")] })).toBe(true);
  });

  test("its style changes, its words kept; a list and a quote toggle", () => {
    expect(restyled(p("Título"), "h2")).toEqual({ type: "heading", id: "b1", level: 2, runs: [{ text: "Título" }] });
    expect(blockStyle(restyled(p("x"), "h1"))).toBe("h1");
    expect(restyled(p("x"), "code")).toEqual({ type: "code_block", id: "b1", text: "x" });
    expect(toggledList(p("x"), "ordered")).toEqual({ ...p("x"), list: "ordered" });
    expect(toggledList(p("x", { list: "ordered", level: 1 }), "ordered")).toEqual(p("x"));
    expect(toggledQuote(p("x"))).toEqual({
      type: "blockquote",
      id: "b1",
      blocks: [{ type: "paragraph", runs: [{ text: "x" }] }],
    });
    expect(toggledQuote(toggledQuote(p("x")))).toEqual(p("x"));
  });

  test("a numbered list counts along its items, starting again after anything else", () => {
    const blocks: DocBlock[] = [
      p("a", { id: "1", list: "ordered" }),
      p("b", { id: "2", list: "ordered" }),
      p("c", { id: "3", list: "ordered", level: 1 }),
      p("d", { id: "4", list: "ordered" }),
      p("x", { id: "5" }),
      p("e", { id: "6", list: "ordered" }),
    ];
    expect([...listNumbers(blocks)]).toEqual([
      ["1", 1],
      ["2", 2],
      ["3", 1],
      ["4", 3],
      ["6", 1],
    ]);
  });

  test("Ask Atlas quotes the block (or the words chosen), its id with it", () => {
    expect(askSelection(p("O verão chegou mais cedo"))).toEqual({
      label: "“O verão chegou mais cedo”",
      block: "b1",
      text: "O verão chegou mais cedo",
    });
    expect(askSelection(p("O verão chegou"), "verão")?.text).toBe("verão");
    expect(askSelection(p("x".repeat(300)))?.text?.length).toBe(200);
    expect(askSelection(p("x".repeat(300)))?.label.length).toBeLessThanOrEqual(62);
    expect(askSelection({ type: "paragraph", runs: [] })).toBeNull();
  });
});

describe("links and notices open a file at its conversation's message", () => {
  test("a file's link, with or without the message", () => {
    expect(fileHref("f1")).toBe("/file/f1");
    expect(fileHref("f1", "m1")).toBe("/file/f1?m=m1");
    expect(fileHref("f1", "../x")).toBe("/file/f1");
    expect(hrefFromUrl("agenteschat://drive/f1?m=m1")).toBe("/file/f1?m=m1");
    expect(hrefFromUrl("agenteschat://drive/f1")).toBe("/file/f1");
    expect(hrefFromUrl("agenteschat://drive")).toBeNull();
    expect(appLinkFromUrl("https://app.agentes.chat/org/o1/drive/f1?m=m1", "o1")).toEqual({ href: "/file/f1?m=m1" });
    expect(appLinkFromUrl("https://app.agentes.chat/org/o1/drive/f1", "o1")).toEqual({ href: "/file/f1" });
  });

  test("a notice about a message in a file's conversation opens the file at it, its push too", () => {
    const source = { artifactId: "f1", channelId: "c1", threadId: "r1", messageId: "m1" };
    expect(notificationHref({ kind: "mention", source })).toBe("/file/f1?m=m1");
    expect(notificationHref({ kind: "thread_reply", source: { artifactId: "f1" } })).toBe("/file/f1");
    expect(hrefForPush({ kind: "mention", ...source })).toBe("/file/f1?m=m1");
  });
});
