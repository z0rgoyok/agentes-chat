import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Artifact, ArtifactDetail, LiveFileStatus } from "@agenteschat/client";
import { initLiveDoc, LOCAL } from "@agenteschat/live";
import type { Peer, PeerState } from "@agenteschat/live/awareness";
import { addSheet, colIds, rowIds, sheetIds } from "@agenteschat/live/spreadsheet";
import * as Y from "yjs";
import { cardPreview, cardShape, DRIVE_TYPES, driveKinds, kindKey, matchesType } from "../../src/features/drive/logic";
import { fileInfo, fileRoute, shareSource, whereKnown } from "../../src/features/files/logic";
import {
  activityKey,
  HERE_FACES,
  hereFaces,
  hereGroups,
  LIVE_ICON,
  LIVE_SCREENS,
  liveClosed,
  liveRoute,
  liveStatusWord,
  officeKindOf,
  peerWhere,
  sheetRangeLabel,
} from "../../src/features/live-files/logic";
import { createItems, mayCreate } from "../../src/features/new/logic";
import { ICONS } from "../../src/ui/icons.data";
import { MAIN, mainLayout, ownOptionsOf } from "../main-stack";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src", path), "utf8");

type Detail = Pick<ArtifactDetail, "kind" | "title" | "content">;
const sheetContent = {
  kind: "spreadsheet" as const,
  preview: { sheet: "Planilha 1", sheets: 2, rows: [["Mês", "Total"]], widths: [100, 100], bold: [[true, true]] },
};
const spreadsheet: Detail = { kind: "spreadsheet", title: "Vendas", content: sheetContent };
const slides: Detail = {
  kind: "slides",
  title: "Apresentação Acme",
  content: { kind: "slides", preview: { theme: "sky", count: 3, first: null } },
};
const canvas: Detail = {
  kind: "canvas",
  title: "Campanha",
  content: { kind: "canvas", preview: { bg: "dots", bounds: null, count: 0, shapes: [] } },
};
const upload = (name: string, contentType: string): Detail => ({
  kind: "file",
  title: name,
  content: { kind: "file", name, contentType, size: 1000, sha256: "x" },
});

describe("live files open on their own screens (ADR 0196 §9)", () => {
  test("each kind has its screen, its icon (drawn on the phone's grid) and a route file", () => {
    expect(LIVE_SCREENS).toEqual({
      spreadsheet: "/spreadsheet/[id]",
      slides: "/slides/[id]",
      canvas: "/canvas/[id]",
      document: "/document/[id]",
    });
    for (const icon of Object.values(LIVE_ICON)) expect(ICONS[icon]).toBeDefined();
    for (const name of ["frame", "note", "shape", "textTool", "follow", "present", "redo", "paste"])
      expect(Object.keys(ICONS)).toContain(name);
    expect(readFileSync(join(MAIN, "spreadsheet/[id].tsx"), "utf8")).toContain("isSafeId(id)");
    expect(readFileSync(join(MAIN, "here/[id].tsx"), "utf8")).toContain("isSafeId(id)");
    // The grid lays out below an opaque bar; who's here is a page as any other.
    expect(ownOptionsOf("spreadsheet/[id]")).toBe("solid,");
    expect(ownOptionsOf("here/[id]")).toBeNull();
    expect(mainLayout()).toContain('"spreadsheet/[id]": solid');
  });

  test("every way into a file sends a live one to its screen, as it is now (no version)", () => {
    expect(fileRoute({ id: "f1", kind: "spreadsheet", version: 4 })).toEqual(liveRoute("spreadsheet", "f1"));
    expect(fileRoute({ id: "f2", kind: "slides" })).toEqual({ pathname: "/slides/[id]", params: { id: "f2" } });
    expect(fileRoute({ id: "f3", detail: { ...canvas, shownVersion: 1, version: 2 } as ArtifactDetail })).toEqual({
      pathname: "/canvas/[id]",
      params: { id: "f3" },
    });
    // A document opens on its own screen (ADR 0200), at a message of its conversation when one is named (ADR 0199).
    expect(fileRoute({ id: "d1", kind: "document" })).toEqual({ pathname: "/document/[id]", params: { id: "d1" } });
    expect(liveRoute("canvas", "c1", "m1")).toEqual({ pathname: "/canvas/[id]", params: { id: "c1", m: "m1" } });
    // Known before its details load: no wait for them.
    expect(whereKnown({ id: "f1", kind: "spreadsheet", title: "Vendas" })).toBe(true);
    // An upload is still the file screen.
    expect(fileRoute({ id: "x", kind: "file", title: "planilha.xlsx" }).pathname).toBe("/file/[id]");
  });

  test("the file screen gives way to the live screen when a link landed there", () => {
    expect(src("features/files/DocumentViewer.tsx")).toContain('info?.view === "live"');
    expect(fileInfo(spreadsheet)).toMatchObject({ view: "live", type: "spreadsheet", ext: "XLSX" });
    expect(fileInfo(slides)).toMatchObject({ view: "live", type: "slides", ext: "PPTX" });
    expect(fileInfo(canvas)).toMatchObject({ view: "live", type: "canvas", ext: "JSON" });
  });

  test("a shared copy is the Office file other apps open, made as the file is now", () => {
    expect(shareSource(spreadsheet)).toMatchObject({ from: "export", format: "xlsx", name: "Vendas.xlsx" });
    expect(shareSource(slides)).toMatchObject({ from: "export", format: "pptx" });
    expect(shareSource(canvas)).toEqual({ from: "export", name: "Campanha.json", mime: "application/json" });
    expect(src("features/files/source.ts")).toContain("isLiveFileKind(a.kind) ? {} : { version: a.shownVersion }");
  });
});

describe("uploaded Office files draw in the app (ADR 0198)", () => {
  test("spreadsheets (CSV too), decks and Word documents, by type or by name", () => {
    expect(fileInfo(upload("vendas.xlsx", "application/octet-stream")).view).toBe("sheet");
    expect(fileInfo(upload("vendas.csv", "text/csv"))).toMatchObject({ view: "sheet", type: "table" });
    expect(fileInfo(upload("dados.ods", "application/vnd.oasis.opendocument.spreadsheet")).view).toBe("sheet");
    expect(fileInfo(upload("plano.pptx", "application/octet-stream"))).toMatchObject({ view: "deck", type: "slides" });
    expect(fileInfo(upload("contrato.docx", "application/octet-stream")).view).toBe("word");
    // Old formats stay download only.
    expect(fileInfo(upload("antigo.ppt", "application/vnd.ms-powerpoint")).view).toBe("other");
  });

  test("an old table opens in the same read-only grid", () => {
    expect(fileInfo({ kind: "table", title: "Vendas", content: { kind: "table", columns: [], rows: [] } }).view).toBe(
      "sheet",
    );
  });

  test("the words over a preview say what the file is", () => {
    expect(officeKindOf("Vendas.XLSX", "sheet")).toBe("excel");
    expect(officeKindOf("dados.ods", "sheet")).toBe("ods");
    expect(officeKindOf("lista.tsv", "sheet")).toBe("csv");
    expect(officeKindOf("plano.pptx", "deck")).toBe("powerpoint");
    expect(officeKindOf("contrato.docx", "word")).toBe("word");
  });
});

describe("the Drive and messages know the three kinds", () => {
  const item = (kind: Artifact["kind"], title: string) => ({ kind, title });

  test("chips, cards and their kind words", () => {
    expect(DRIVE_TYPES).toEqual([
      "all",
      "documents",
      "spreadsheets",
      "presentations",
      "canvases",
      "images",
      "tables",
      "diffs",
    ]);
    expect(driveKinds("spreadsheets")).toEqual(["spreadsheet"]);
    expect(driveKinds("presentations")).toEqual(["slides", "file"]);
    expect(driveKinds("canvases")).toEqual(["canvas"]);
    expect(matchesType(item("spreadsheet", "Vendas"), "spreadsheets")).toBe(true);
    expect(matchesType(item("file", "plano.pptx"), "presentations")).toBe(true);
    expect(matchesType(item("canvas", "Ideias"), "documents")).toBe(false);
    expect(cardShape(item("slides", "Deck"))).toBe("slides");
    expect(kindKey(item("canvas", "Ideias"))).toBe("canvas");
    expect(kindKey(item("file", "plano.pptx"))).toBe("slides");
    expect(cardPreview("Vendas", sheetContent)).toEqual({ kind: "live", content: sheetContent });
  });

  test("a message's live file is its own card, opening no document", () => {
    const files = src("features/files/MessageFiles.tsx");
    expect(files).toContain("if (detail && opensLive(detail.kind)) {");
    expect(files).toContain("<LiveFileCard key={d.id} detail={d} width={blockWidth} />");
    const card = src("features/live-files/LiveFileCard.tsx");
    expect(card).not.toContain("useLiveDoc");
    expect(card).toContain("useLivePresence(orgId, [detail.id])");
  });

  test("who is in a file reaches the cards from the conversation's and the workspace's events", () => {
    expect(src("features/chat/live.ts")).toContain("if (applyLiveEvent(qc, orgId, event)) return;");
    expect(src("features/shared/userEvents.ts")).toContain("applyLiveEvent(qc, orgId, event);");
  });

  test("New makes the three kinds for whoever may add files", () => {
    expect(createItems({ permissions: ["upload_files"] }, { ownsAgent: false })).toEqual([
      "spreadsheet",
      "slides",
      "canvas",
    ]);
    for (const item of ["spreadsheet", "slides", "canvas"] as const)
      expect(mayCreate({ permissions: ["read"] }, item)).toBe(false);
    expect(src("features/live-files/shared/useCreateLive.ts")).toContain("t(`live.kinds.untitled.");
  });
});

describe("a live file's bar", () => {
  const view = (
    status: LiveFileStatus,
    extra: Partial<{ mode: "edit" | "view"; unsent: boolean; loaded: boolean }>,
  ) => ({
    status,
    mode: "edit" as const,
    unsent: false,
    loaded: true,
    ...extra,
  });

  test("says how it stands: opening, saved, saving, offline (changes kept), read-only", () => {
    expect(liveStatusWord(view("connecting", { loaded: false }))).toBe("opening");
    expect(liveStatusWord(view("live", {}))).toBe("saved");
    expect(liveStatusWord(view("live", { unsent: true }))).toBe("saving");
    expect(liveStatusWord(view("offline", {}))).toBe("offline");
    expect(liveStatusWord(view("offline", { unsent: true }))).toBe("offlineKept");
    expect(liveStatusWord(view("live", { mode: "view" }))).toBe("readOnly");
  });

  test("a file that can't open says why", () => {
    expect(liveClosed({ status: "live", error: null })).toBeNull();
    expect(liveClosed({ status: "closed", error: "not_found" })).toBe("missing");
    expect(liveClosed({ status: "closed", error: "forbidden" })).toBe("missing");
    expect(liveClosed({ status: "closed", error: "unauthorized" })).toBe("signedOut");
    expect(liveClosed({ status: "closed", error: "invalid" })).toBe("broken");
  });
});

describe("who is here (ADR 0196 §5)", () => {
  const peer = (id: string, state: Partial<PeerState>, self = false, kind: "person" | "agent" = "person"): Peer => ({
    clientId: id.length + (self ? 100 : 0),
    user: { kind, id },
    self,
    state: { user: { kind, id }, mode: "viewing", ...state },
  });

  test("the bar's faces: everyone but this person, three at most, then how many more", () => {
    const peers = [peer("me", {}, true), peer("a", {}), peer("b", {}), peer("c", {}), peer("d", {}), peer("e", {})];
    const { shown, more } = hereFaces(peers);
    expect(shown.map((p) => p.user.id)).toEqual(["a", "b", "c"]);
    expect(shown.length).toBe(HERE_FACES);
    expect(more).toBe(2);
    expect(hereFaces([peer("me", {}, true)])).toEqual({ shown: [], more: 0 });
  });

  test("the list: who edits, then who looks, this person first in theirs", () => {
    const groups = hereGroups([
      peer("atlas", { mode: "editing" }, false, "agent"),
      peer("me", { mode: "editing" }, true),
      peer("ada", { mode: "viewing" }),
    ]);
    expect(groups.map((g) => [g.key, g.peers.map((p) => p.user.id)])).toEqual([
      ["editing", ["me", "atlas"]],
      ["viewing", ["ada"]],
    ]);
    expect(hereGroups([peer("me", {}, true)]).map((g) => g.key)).toEqual(["viewing"]);
  });

  test("where someone is, in a spreadsheet's words", () => {
    const doc = new Y.Doc();
    initLiveDoc(doc, "spreadsheet", { sheetName: "Vendas" });
    const sheet = sheetIds(doc)[0] as string;
    const rows = rowIds(doc, sheet);
    const cols = colIds(doc, sheet);
    const sel = { sheet, r1: rows[3] as string, c1: cols[1] as string, r2: rows[9] as string, c2: cols[2] as string };
    expect(sheetRangeLabel(doc, sel)).toBe("B4:C10");
    expect(peerWhere(doc, "spreadsheet", peer("ada", { mode: "editing", sel: { sheet: sel } }))).toEqual({
      kind: "range",
      label: "B4:C10",
      editing: true,
    });
    // With two sheets the sheet's name comes first.
    addSheet(doc, "Custos", LOCAL);
    expect(sheetRangeLabel(doc, sel)).toBe("Vendas!B4:C10");
    // A row deleted under the selection: no words for it.
    expect(sheetRangeLabel(doc, { ...sel, r1: "gone" })).toBeNull();
    expect(peerWhere(doc, "spreadsheet", peer("ada", {}))).toEqual({ kind: "viewing" });
  });

  test("an agent says what it does in words the apps translate", () => {
    const atlas = peer("atlas", { mode: "editing", activity: { key: "writingCells", params: { range: "B2:C40" } } });
    expect(peerWhere(null, "spreadsheet", atlas)).toEqual({
      kind: "activity",
      key: "writingCells",
      params: { range: "B2:C40" },
    });
    expect(activityKey("live.activity.addingRows")).toBe("addingRows");
  });

  test("on a slide, and on a canvas", () => {
    const doc = new Y.Doc();
    initLiveDoc(doc, "slides");
    const first = doc.getArray<string>("slideOrder").get(0);
    expect(peerWhere(doc, "slides", peer("ada", { at: { slide: first } }))).toEqual({
      kind: "slide",
      n: 1,
      editing: false,
    });
    expect(peerWhere(null, "canvas", peer("ada", { mode: "editing", sel: { canvas: ["a", "b"] } }))).toEqual({
      kind: "shapes",
      count: 2,
    });
  });
});

describe("the phone's connection to a live file (ADR 0196 §3)", () => {
  const hook = src("features/live-files/shared/useLiveDoc.ts");
  const kept = src("features/live-files/shared/kept.ts");

  test("its own socket with the session, bytes as base64 text, to the server the app is on", () => {
    expect(hook).toContain("createSocketFactory(lastCookie)");
    expect(hook).toContain("textFrames: true");
    expect(hook).toContain("baseUrl: server");
  });

  test("open while a screen shows it with the app in front; the background lets it go at once", () => {
    expect(hook).toContain("want(room, who, focused && active, active ? awayMs : 0)");
    expect(hook).toContain("useIsFocused()");
    expect(hook).toContain("useAppActive()");
  });

  test("changes the server hasn't stored are kept per server in the app's documents and put back next time", () => {
    expect(kept).toContain('new Directory(Paths.document, "live-files")');
    expect(kept).toContain("perServer(`unsent-");
    expect(hook).toContain("room.restoreUnsent(kept)");
    expect(hook).toContain("store.write(room.fileId, room.unsent ? room.unsentUpdate() : null)");
  });

  test("Yjs gets its randomness from expo-crypto on the phone, one copy of it in the bundle", () => {
    const metro = readFileSync(join(import.meta.dir, "../../metro.config.js"), "utf8");
    expect(metro).toContain('if (moduleName === "lib0/webcrypto")');
    expect(metro).toContain('path.join(projectRoot, "src/lib/webcrypto.ts")');
    for (const name of ['"yjs"', '"lib0"', '"y-protocols"']) expect(metro).toContain(name);
    expect(readFileSync(join(import.meta.dir, "../../src/lib/webcrypto.ts"), "utf8")).toContain(
      'import { getRandomValues as fill } from "expo-crypto";',
    );
  });
});
