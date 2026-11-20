import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { initLiveDoc, LOCAL } from "@agenteschat/live";
import type { Peer, PeerState } from "@agenteschat/live/awareness";
import { editParagraphTexts, type RichDoc, readRich } from "@agenteschat/live/rich";
import {
  addElement,
  elementTextFragment,
  readSlide,
  SLIDE_LAYOUTS,
  slideIdsOf,
  updateElement,
} from "@agenteschat/live/slides";
import * as Y from "yjs";
import {
  drawnParagraphs,
  editorText,
  elementFrame,
  fitSlide,
  LINE_BREAK,
  layoutKey,
  listNumbers,
  moveTarget,
  paragraphTexts,
  partOf,
  peerSelections,
  peersBySlide,
  placeholderOf,
  presenterOf,
  runLook,
  shownSlides,
  showStart,
  slideHeight,
  slideScale,
  touchSlop,
} from "../../src/features/live-files/slides/logic";
import { slideLayoutRoute, slideRoute, slideShowRoute, textRoute } from "../../src/features/live-files/slides/routes";
import { MAIN, mainLayout, ownOptionsOf } from "../main-stack";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src", path), "utf8");
const en = readFileSync(join(import.meta.dir, "../../../../packages/i18n/src/en.ts"), "utf8");

const peer = (clientId: number, id: string, state: Partial<PeerState>, self = false): Peer => ({
  clientId,
  self,
  user: { kind: "person", id },
  state: { user: { kind: "person", id }, mode: "viewing", ...state },
});

describe("a slide drawn on the phone, in its own units scaled to the screen (ADR 0196 §9)", () => {
  test("its scale and height follow the width, 16:9", () => {
    expect(slideScale(384)).toBeCloseTo(0.2, 6);
    expect(slideHeight(384)).toBeCloseTo(216, 6);
    expect(slideScale(0)).toBe(0);
    expect(slideHeight(-5)).toBe(0);
    // An uploaded deck in 4:3 keeps its own shape.
    expect(slideHeight(400, { w: 1024, h: 768 })).toBeCloseTo(300, 6);
  });

  test("presenting fits the whole slide in the screen, centered, lying down or standing up", () => {
    const wide = fitSlide({ width: 844, height: 390 });
    expect(wide.height).toBeCloseTo(390, 6);
    expect(wide.width).toBeCloseTo((390 * 16) / 9, 6);
    expect(wide.left).toBeCloseTo((844 - wide.width) / 2, 6);
    expect(wide.top).toBe(0);
    const tall = fitSlide({ width: 390, height: 844 });
    expect(tall.width).toBe(390);
    expect(tall.top).toBeCloseTo((844 - (390 * 9) / 16) / 2, 6);
    expect(fitSlide({ width: 0, height: 100 })).toEqual({ width: 0, height: 0, left: 0, top: 0 });
  });

  test("an element's place in points; a line's from both of its ends", () => {
    expect(elementFrame({ type: "text", x: 120, y: 80, w: 1680, h: 176 }, 0.5)).toEqual({
      left: 60,
      top: 40,
      width: 840,
      height: 88,
      rot: 0,
    });
    // A line drawn up and to the left: its box starts at its far end.
    expect(elementFrame({ type: "line", x: 500, y: 400, w: -200, h: -100, rot: 15 }, 1)).toEqual({
      left: 300,
      top: 300,
      width: 200,
      height: 100,
      rot: 15,
    });
  });

  test("a small element answers to a finger-sized box around it", () => {
    expect(touchSlop({ width: 10, height: 100 })).toEqual({ top: 0, bottom: 0, left: 17, right: 17 });
    expect(touchSlop({ width: 200, height: 0 })).toEqual({ top: 22, bottom: 22, left: 0, right: 0 });
    expect(touchSlop({ width: 60, height: 60 })).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
  });

  test("an empty box says what it holds only while it can be edited, and only text boxes do", () => {
    expect(placeholderOf({ type: "text", role: "title", text: [] })).toBe("title");
    expect(placeholderOf({ type: "text", role: "quote", text: [{ runs: [] }] })).toBe("title");
    expect(placeholderOf({ type: "text", role: "body", text: [] })).toBe("text");
    expect(placeholderOf({ type: "text", text: [{ runs: [{ text: "Olá" }] }] })).toBeNull();
    expect(placeholderOf({ type: "shape", text: [] })).toBeNull();
    expect(partOf({ type: "text", role: "body2" })).toBe("body");
    expect(partOf({ type: "shape", role: "title" })).toBe("shape");
    expect(partOf({ type: "text" })).toBe("text");
  });
});

describe("texts as the web draws them", () => {
  test("ordered lists count per level and start again after a break, as the web's", () => {
    const doc: RichDoc = [
      { list: "ordered", runs: [{ text: "a" }] },
      { list: "ordered", runs: [{ text: "b" }] },
      { list: "ordered", level: 1, runs: [{ text: "b.1" }] },
      { list: "ordered", runs: [{ text: "c" }] },
      { runs: [{ text: "break" }] },
      { list: "ordered", runs: [{ text: "again" }] },
    ];
    expect(listNumbers(doc)).toEqual([1, 2, 1, 3, null, 1]);
    const drawn = drawnParagraphs(doc);
    expect(drawn.map((p) => p.marker)).toEqual(["1.", "2.", "1.", "3.", null, "1."]);
    expect(drawn[2]).toMatchObject({ markerAt: 1.4, indent: 2.8 });
    expect(drawn[4]).toMatchObject({ markerAt: 0, indent: 0 });
  });

  test("bullets change with the level", () => {
    const drawn = drawnParagraphs([0, 1, 2].map((level) => ({ list: "bullet" as const, level, runs: [] })));
    expect(drawn.map((p) => p.marker)).toEqual(["•", "◦", "▪"]);
  });

  test("a run's marks as React Native's styles", () => {
    expect(runLook({ text: "x", bold: true, italic: true })).toEqual({ fontWeight: "700", fontStyle: "italic" });
    expect(runLook({ text: "x", underline: true, strike: true, color: "#c00" })).toEqual({
      textDecorationLine: "underline line-through",
      color: "#c00",
    });
    expect(runLook({ text: "x" })).toEqual({});
  });
});

describe("the phone's text editor: one paragraph a line (editParagraphTexts)", () => {
  test("a break inside a paragraph travels through the field and comes back", () => {
    const rich: RichDoc = [{ runs: [{ text: "Linha 1\nainda 1" }] }, { runs: [{ text: "Linha 2" }] }];
    const text = editorText(rich);
    expect(text).toBe(`Linha 1${LINE_BREAK}ainda 1\nLinha 2`);
    expect(paragraphTexts(text)).toEqual(["Linha 1\nainda 1", "Linha 2"]);
    expect(paragraphTexts("a\r\nb")).toEqual(["a", "b"]);
    expect(editorText(undefined)).toBe("");
  });

  test("typing in one paragraph keeps the others' look, and Undo takes it back", () => {
    const doc = new Y.Doc();
    initLiveDoc(doc, "slides");
    const slide = slideIdsOf(doc)[0] ?? "";
    const el = addElement(doc, slide, { type: "text", text: "**Receita** em alta\n- Custos estáveis" }, LOCAL);
    const fragment = elementTextFragment(doc, slide, el);
    if (!fragment) throw new Error("no text");
    const undo = new Y.UndoManager(fragment, { trackedOrigins: new Set([LOCAL]) });
    const before = readRich(fragment);
    const typed = paragraphTexts(`${editorText(before).split("\n")[0]}\nCustos estáveis e menores`);
    editParagraphTexts(fragment, typed, LOCAL);
    const after = readRich(fragment);
    expect(after[0]).toEqual(before[0] as (typeof after)[number]);
    expect(after[0]?.runs[0]).toMatchObject({ text: "Receita", bold: true });
    expect(after[1]).toMatchObject({ list: "bullet" });
    expect(after[1]?.runs.map((r) => r.text).join("")).toBe("Custos estáveis e menores");
    undo.stopCapturing();
    undo.undo();
    expect(readRich(fragment)).toEqual(before);
  });

  test("a box with no words yet gets them through the element's own change", () => {
    const doc = new Y.Doc();
    initLiveDoc(doc, "slides");
    const slide = slideIdsOf(doc)[0] ?? "";
    const el = addElement(doc, slide, { type: "shape" }, LOCAL);
    updateElement(doc, slide, el, { text: [{ runs: [{ text: "Etapa 1" }] }] }, LOCAL);
    const shape = readSlide(doc, slide)?.elements.find((e) => e.id === el);
    expect(editorText(shape?.text)).toBe("Etapa 1");
  });
});

describe("who is on which slide, and who presents", () => {
  test("everyone else by the slide they are at (presenting counts as being there)", () => {
    const peers = [
      peer(1, "me", { at: { slide: "s1" } }, true),
      peer(2, "ada", { at: { slide: "s1" } }),
      peer(3, "theo", { at: { slide: "s1" }, presenting: { slide: "s2", since: 5 } }),
      peer(4, "lia", {}),
    ];
    const by = peersBySlide(peers);
    expect(by.get("s1")?.map((p) => p.user.id)).toEqual(["ada"]);
    expect(by.get("s2")?.map((p) => p.user.id)).toEqual(["theo"]);
    expect(by.size).toBe(2);
  });

  test("the latest to start presenting is the one followed; this person never", () => {
    const peers = [
      peer(1, "me", { presenting: { slide: "s1", since: 99 } }, true),
      peer(2, "ada", { presenting: { slide: "s1", since: 10 } }),
      peer(3, "theo", { presenting: { slide: "s3", since: 20 } }),
    ];
    expect(presenterOf(peers)?.user.id).toBe("theo");
    expect(presenterOf([peer(1, "me", {}, true)])).toBeNull();
  });

  test("others' chosen elements on this slide, with who", () => {
    const peers = [
      peer(2, "ada", { at: { slide: "s1" }, sel: { slide: ["e1", "e2"] } }),
      peer(3, "theo", { at: { slide: "s2" }, sel: { slide: ["e9"] } }),
      peer(1, "me", { at: { slide: "s1" }, sel: { slide: ["e3"] } }, true),
    ];
    expect(peerSelections(peers, "s1").map((p) => [p.peer.user.id, p.ids])).toEqual([["ada", ["e1", "e2"]]]);
  });

  test("presenting skips hidden slides and starts at the next shown one", () => {
    const slides = [{ id: "a", hidden: false }, { id: "b", hidden: true }, { id: "c" }, { id: "d", hidden: true }];
    expect(shownSlides(slides).map((s) => s.id)).toEqual(["a", "c"]);
    expect(showStart(slides, "c")).toBe(1);
    expect(showStart(slides, "b")).toBe(1);
    // Nothing shown after it: the first one.
    expect(showStart(slides, "d")).toBe(0);
    expect(showStart(slides, null)).toBe(0);
    expect(showStart([{ id: "x", hidden: true }], "x")).toBe(0);
  });

  test("moving a slide one place up or down stays inside the deck", () => {
    expect(moveTarget(0, 3, -1)).toBeNull();
    expect(moveTarget(0, 3, 1)).toBe(1);
    expect(moveTarget(2, 3, 1)).toBeNull();
  });
});

describe("layouts, routes and screens", () => {
  test("every layout has its words in the shared strings", () => {
    for (const layout of SLIDE_LAYOUTS) expect(en).toContain(`${layoutKey(layout)}: "`);
    expect(layoutKey("title-body")).toBe("titleBody");
    expect(layoutKey("big-number")).toBe("bigNumber");
  });

  test("each screen is its own push with the system's back", () => {
    expect(slideRoute("f1", "s2")).toEqual({ pathname: "/slides/[id]", params: { id: "f1", slide: "s2" } });
    expect(slideShowRoute("f1")).toEqual({ pathname: "/slides-show/[id]", params: { id: "f1" } });
    expect(slideShowRoute("f1", { follow: 0 }).params).toEqual({ id: "f1", follow: "0" });
    expect(textRoute("f1", { shape: "n1" }).params).toEqual({ id: "f1", shape: "n1" });
    expect(slideLayoutRoute("f1", { at: 0 }).params).toEqual({ id: "f1", at: "0" });
    expect(slideLayoutRoute("f1", { slide: "s1" }).params).toEqual({ id: "f1", slide: "s1" });
    for (const name of ["slides/[id]", "slides-show/[id]", "slide-text/[id]", "slide-layout/[id]"]) {
      const file = join(MAIN, `${name}.tsx`);
      expect({ name, exists: existsSync(file) }).toEqual({ name, exists: true });
      expect(readFileSync(file, "utf8")).toContain("isSafeId(id)");
    }
    // The slides and a text box's words lay out below an opaque bar; presenting has none, on black, and fades in.
    expect(ownOptionsOf("slides/[id]")).toBe("solid,");
    expect(ownOptionsOf("slide-text/[id]")).toBe("solid,");
    expect(mainLayout()).toContain('"slides-show/[id]": {');
    expect(mainLayout()).toMatch(
      /"slides-show\/\[id\]": \{\s+\.\.\.base,\s+animation: "fade",\s+gestureEnabled: false/,
    );
    // The layouts lay out below the bar too (their loading shape included).
    expect(ownOptionsOf("slide-layout/[id]")).toBe("solid,");
  });

  test("a slide is a picture with words: never scaled by the person's text size", () => {
    const view = src("features/live-files/slides/SlideView.tsx");
    const texts = view.match(/<RNText\b/g)?.length ?? 0;
    const fixed = view.match(/<RNText\s+allowFontScaling=\{false\}/g)?.length ?? 0;
    // Runs nest inside their paragraph's text and take its setting.
    expect(fixed).toBe(texts - 1);
  });

  test("the slides' screens follow the app's rules", () => {
    const list = src("features/live-files/slides/SlidesScreen.tsx");
    // Opening a slide is navigation: no haptic.
    expect(list).toMatch(/<PressScale\s+haptic=\{false\}/);
    const focus = src("features/live-files/slides/SlideFocus.tsx");
    expect(focus).toContain("<TextArea");
    expect(focus).not.toContain("<TextInput");
    const text = src("features/live-files/slides/SlideTextScreen.tsx");
    expect(text).toContain("editParagraphTexts(fragment, texts, LOCAL)");
    // Photos go up as parts with their bytes (Expo's fetch refuses `{ uri }` parts).
    expect(src("features/live-files/slides/photos.ts")).toContain("uploadPart(file)");
    // An uploaded deck (ADR 0198) is drawn by the same slide view, at its own size (a 4:3 deck stays 4:3).
    const office = src("features/live-files/office/OfficePages.tsx");
    expect(office).toMatch(/<SlideView[^>]*deck=\{deck\}[^>]*mode="thumb"/);
    // Presenting lies the phone down, through the app's one way to landscape.
    expect(src("features/live-files/slides/ShowScreen.tsx")).toContain("useSideways(true)");
  });
});
