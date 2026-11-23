import { describe, expect, test } from "bun:test";
import { toBase64 } from "@agenteschat/live";
import {
  createHttpApi,
  createLiveApi,
  imageRequestOf,
  isLiveFileKind,
  LIVE_PRESENCE_BATCH,
  liveRefOf,
  liveSelectionOf,
  loadLiveState,
  officePreviewOf,
  type RequestOptions,
} from "../src/index";
import { ARTIFACT_KINDS, artifactRefs, fileName, isArtifactKind, KIND_ICON } from "../src/lib/artifacts";
import { fileIcon, isOfficePreview, previewKind, previewKindOfName } from "../src/lib/files";

/** The live files' routes (ADR 0196, 0197, 0198) as the client calls them, and the lists that learned the new kinds. */

type Call = { path: string; options: RequestOptions };

/** A requester that records each call and answers with `answer(path)`. */
function recorder(answer: (path: string, options: RequestOptions) => unknown = () => ({})) {
  const calls: Call[] = [];
  const request = (async (path: string, options: RequestOptions = {}) => {
    calls.push({ path, options });
    return answer(path, options);
  }) as Parameters<typeof createLiveApi>[0];
  return { calls, request };
}

const ORG = "o1";
const BASE = "/api/app/organizations/o1";

describe("live API", () => {
  test("makes a file with only what was given", async () => {
    const { calls, request } = recorder(() => ({ id: "f1" }));
    const api = createLiveApi(request);
    await api.create(ORG, { kind: "spreadsheet", title: "Budget" });
    await api.create(ORG, { kind: "canvas", title: "Ideas", channelId: "c1", threadId: "t1" });
    expect(calls.map((c) => [c.path, c.options.json])).toEqual([
      [`${BASE}/live-files`, { kind: "spreadsheet", title: "Budget" }],
      [`${BASE}/live-files`, { kind: "canvas", title: "Ideas", channelId: "c1", threadId: "t1" }],
    ]);
  });

  test("state, versions, restore, ask, open as, copy: their routes and bodies", async () => {
    const { calls, request } = recorder();
    const api = createLiveApi(request);
    await api.state(ORG, "f 1");
    await api.saveVersion(ORG, "f1", "  Before the review  ");
    await api.saveVersion(ORG, "f1", "   ");
    await api.restoreVersion(ORG, "f1", 3);
    await api.ask(ORG, "f1", { agentId: "a1", text: "Fill column C", selection: { label: "Sheet 1!B2:E9" } });
    await api.openAs(ORG, "f1");
    await api.copyAsset(ORG, "f1", { artifactId: "f2", version: 2 });
    expect(calls.map((c) => [c.path, c.options.json])).toEqual([
      [`${BASE}/artifacts/f%201/live`, undefined],
      [`${BASE}/artifacts/f1/live/versions`, { note: "Before the review" }],
      [`${BASE}/artifacts/f1/live/versions`, {}],
      [`${BASE}/artifacts/f1/live/restore`, { version: 3 }],
      [
        `${BASE}/artifacts/f1/live/ask`,
        { agentId: "a1", text: "Fill column C", selection: { label: "Sheet 1!B2:E9" } },
      ],
      [`${BASE}/artifacts/f1/open-as`, {}],
      [`${BASE}/artifacts/f1/assets/copy`, { artifactId: "f2", version: 2 }],
    ]);
  });

  test("presence: asked in batches the route takes, merged, and only entries that read right", async () => {
    const { calls, request } = recorder((_path, options) => {
      const ids = String(options.query?.ids ?? "").split(",");
      const presence: Record<string, unknown[]> = {};
      for (const id of ids) {
        presence[id] = [
          { kind: "person", id: "ada", mode: "editing" },
          { kind: "robot", id: "x", mode: "editing" },
          { kind: "agent", id: "atlas", mode: "dancing" },
        ];
      }
      return { presence };
    });
    const api = createLiveApi(request);
    expect(await api.presence(ORG, [])).toEqual({});
    expect(calls).toHaveLength(0);
    const ids = Array.from({ length: LIVE_PRESENCE_BATCH + 5 }, (_, i) => `f${i}`);
    const summary = await api.presence(ORG, [...ids, "f0", ""]);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.path).toBe(`${BASE}/live/presence`);
    expect(String(calls[0]?.options.query?.ids).split(",")).toHaveLength(LIVE_PRESENCE_BATCH);
    expect(Object.keys(summary)).toHaveLength(ids.length);
    expect(summary.f3).toEqual([{ kind: "person", id: "ada", mode: "editing" }]);
  });

  test("pictures: the upload's form, and addresses on this origin or the phone's server", async () => {
    const sent: { path: string; form: FormData }[] = [];
    const upload = async <T>(path: string, form: FormData) => {
      sent.push({ path, form });
      return { id: "p1" } as T;
    };
    const api = createLiveApi(recorder().request, { upload, base: "https://agentes.example.com/" });
    const picture = new File([new Uint8Array([137, 80, 78, 71])], "photo.png", { type: "image/png" });
    await api.uploadAsset(ORG, "f1", picture);
    expect(sent[0]?.path).toBe(`${BASE}/artifacts/f1/assets`);
    const part = sent[0]?.form.get("file") as File | null | undefined;
    expect(part?.name).toBe("photo.png");
    expect(api.assetUrl(ORG, "f1", "a/1")).toBe(`https://agentes.example.com${BASE}/artifacts/f1/assets/a%2F1`);
    expect(api.previewMediaUrl(ORG, "f1", "image 1.png", 4)).toBe(
      `https://agentes.example.com${BASE}/artifacts/f1/preview/media/image%201.png?version=4`,
    );
    const web = createLiveApi(recorder().request);
    expect(web.assetUrl(ORG, "f1", "a1")).toBe(`${BASE}/artifacts/f1/assets/a1`);
    await expect(web.uploadAsset(ORG, "f1", picture)).rejects.toThrow();
  });

  test("the HTTP client has them, uploading with its own requester", async () => {
    const seen: string[] = [];
    const api = createHttpApi({
      baseUrl: "https://agentes.example.com",
      fetch: async (url) => {
        seen.push(url);
        return new Response(JSON.stringify({ id: "x" }), { status: 201 });
      },
    });
    expect(api.live.assetUrl(ORG, "f1", "a1")).toBe(`https://agentes.example.com${BASE}/artifacts/f1/assets/a1`);
    await api.live.uploadAsset(ORG, "f1", new File(["x"], "a.png", { type: "image/png" }));
    expect(seen).toEqual([`https://agentes.example.com${BASE}/artifacts/f1/assets`]);
  });

  test("image models and requests are read leniently", async () => {
    const answers: Record<string, unknown> = {
      [`${BASE}/images/models`]: { models: [{ id: "m1", label: "Model 1" }] },
      [`${BASE}/artifacts/f1/images/r1/retry`]: { id: "r1", status: "queued", shapeIds: ["s1", 2], frameId: "fr" },
    };
    const { calls, request } = recorder((path) => answers[path]);
    const api = createLiveApi(request);
    expect(await api.imageModels(ORG)).toEqual([{ id: "m1", label: "Model 1" }] as never);
    expect(await api.retryImages(ORG, "f1", "r1")).toEqual({
      requestId: "r1",
      status: "queued",
      shapeIds: ["s1"],
      frameId: "fr",
    });
    expect(calls[1]?.options.json).toEqual({});
    expect(imageRequestOf({ requestId: "r1", status: "bogus" })).toEqual({
      requestId: "r1",
      status: "queued",
      shapeIds: [],
      frameId: null,
    });
    expect(imageRequestOf(null)).toEqual({ requestId: "", status: "queued", shapeIds: [], frameId: null });
    const bare = createLiveApi(recorder(() => [{ id: "m2" }]).request);
    expect(await bare.imageModels(ORG)).toEqual([{ id: "m2" }] as never);
    const none = createLiveApi(recorder(() => ({})).request);
    expect(await none.imageModels(ORG)).toEqual([]);
  });

  test("Office previews: workbook, deck (pictures on the phone's server) and document", async () => {
    const workbook = { sheets: [{ name: "Sheet 1", rows: 1, cols: 1, cells: [] }] };
    expect(officePreviewOf({ kind: "workbook", workbook })).toEqual({ kind: "workbook", workbook } as never);
    expect(officePreviewOf(workbook)).toEqual({ kind: "workbook", workbook } as never);
    const deck = {
      w: 1920,
      h: 1080,
      slides: [],
      media: {
        "image1.png": { type: "image/png", url: "/api/app/organizations/o1/artifacts/f1/preview/media/image1.png" },
        "image2.png": { type: "image/png", url: "https://cdn.example.com/x.png" },
        bad: null,
      },
    };
    const read = officePreviewOf({ kind: "deck", deck }, "https://agentes.example.com");
    expect(read.kind).toBe("deck");
    if (read.kind !== "deck") throw new Error("not a deck");
    expect(read.deck.media).toEqual({
      "image1.png": {
        type: "image/png",
        url: "https://agentes.example.com/api/app/organizations/o1/artifacts/f1/preview/media/image1.png",
      },
      "image2.png": { type: "image/png", url: "https://cdn.example.com/x.png" },
    });
    expect(officePreviewOf({ kind: "document", html: "<p>Hi</p>" })).toEqual({ kind: "document", html: "<p>Hi</p>" });
    expect(() => officePreviewOf({ kind: "mystery" })).toThrow();
    const { calls, request } = recorder(() => ({ kind: "document", html: "<p/>" }));
    await createLiveApi(request).officePreview(ORG, "f1", 2);
    expect(calls[0]?.path).toBe(`${BASE}/artifacts/f1/preview`);
    expect(calls[0]?.options.query).toEqual({ version: 2 });
  });

  test("loadLiveState decodes the state and reads the rest safely", async () => {
    const bytes = new Uint8Array([1, 2, 3, 250]);
    const ok = await loadLiveState(
      { state: async () => ({ state: toBase64(bytes), seq: 7, mode: "edit", kind: "slides" }) },
      ORG,
      "f1",
    );
    expect(ok).toEqual({ state: bytes, seq: 7, mode: "edit", kind: "slides" });
    const odd = await loadLiveState(
      { state: async () => ({ state: "", seq: -1, mode: "other", kind: "poster" }) as never },
      ORG,
      "f1",
    );
    expect(odd).toEqual({ state: new Uint8Array(0), seq: 0, mode: "view", kind: null });
  });
});

describe("live file kinds in the shared lists", () => {
  test("the Drive knows the new kinds, their icons and their downloads' names", () => {
    for (const kind of ["spreadsheet", "slides", "canvas"] as const) {
      expect(ARTIFACT_KINDS).toContain(kind);
      expect(isArtifactKind(kind)).toBe(true);
    }
    expect(isArtifactKind("block")).toBe(false);
    expect([KIND_ICON.spreadsheet, KIND_ICON.slides, KIND_ICON.canvas]).toEqual(["spreadsheet", "slides", "canvas"]);
    expect(fileName("Orçamento 2027", { kind: "spreadsheet" })).toBe("orcamento-2027.xlsx");
    expect(fileName("Pitch", { kind: "slides" })).toBe("pitch.pptx");
    expect(fileName("Ideas", { kind: "canvas" })).toBe("ideas.json");
  });

  test("a message's live file may come without a version", () => {
    const refs = artifactRefs({
      artifacts: [{ id: "a", version: 1 }, { id: "live", kind: "canvas" }, { id: "nothing" }, { id: "a", version: 2 }],
    });
    expect(refs.map((r) => r.id)).toEqual(["a", "live"]);
    expect(refs[0]?.version).toBe(2);
  });

  test("Office files preview from the server's reading; presentations have their own icon", () => {
    expect(previewKind("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe("office-sheet");
    expect(previewKind("text/csv; charset=utf-8")).toBe("office-sheet");
    expect(previewKind("text/tab-separated-values; charset=utf-8")).toBe("office-sheet");
    expect(previewKind("application/vnd.ms-excel")).toBe("office-sheet");
    expect(previewKind("application/vnd.oasis.opendocument.spreadsheet")).toBe("office-sheet");
    expect(previewKind("application/vnd.openxmlformats-officedocument.presentationml.presentation")).toBe(
      "office-slides",
    );
    expect(previewKind("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("office-doc");
    expect(previewKind("application/octet-stream", "deck.pptx")).toBe("office-slides");
    expect(previewKind("application/octet-stream", "photo.png")).toBeNull();
    expect(previewKind("application/vnd.ms-powerpoint")).toBeNull();
    expect(previewKind("image/png")).toBe("image");
    expect(previewKindOfName("Plano.XLSX")).toBe("office-sheet");
    expect(previewKindOfName("notes.docx")).toBe("office-doc");
    expect(previewKindOfName("old.doc")).toBeNull();
    expect(isOfficePreview("office-doc")).toBe(true);
    expect(isOfficePreview("pdf")).toBe(false);
    expect(isOfficePreview(null)).toBe(false);
    for (const name of ["deck.pptx", "old.ppt", "talk.odp", "keynote.key"]) expect(fileIcon(name)).toBe("slides");
    expect(fileIcon("x", "application/vnd.oasis.opendocument.presentation")).toBe("slides");
    expect(fileIcon("dados.xlsx")).toBe("table");
  });

  test("a message's live file reference and selection are read safely", () => {
    expect(isLiveFileKind("slides")).toBe(true);
    expect(isLiveFileKind("table")).toBe(false);
    expect(isLiveFileKind(3)).toBe(false);
    expect(
      liveRefOf({
        liveRef: {
          artifactId: "f1",
          kind: "spreadsheet",
          title: "Budget",
          selection: { label: "Sheet 1!B2:E9", sheet: "s1", range: "B2:E9", shapes: ["x", 1, ""], extra: true },
        },
      }),
    ).toEqual({
      artifactId: "f1",
      kind: "spreadsheet",
      title: "Budget",
      selection: { label: "Sheet 1!B2:E9", sheet: "s1", range: "B2:E9", shapes: ["x"] },
    });
    expect(liveRefOf({ liveRef: { artifactId: "f1", kind: "poster" } })).toBeNull();
    expect(liveRefOf({})).toBeNull();
    expect(liveRefOf(null)).toBeNull();
    expect(liveSelectionOf({ label: "" })).toBeUndefined();
    expect(liveSelectionOf({ label: "slide 3", slide: "sl1" })).toEqual({ label: "slide 3", slide: "sl1" });
  });
});
