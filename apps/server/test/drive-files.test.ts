import { afterEach, beforeEach, expect, test } from "bun:test";
import { ARTIFACT_LIMITS } from "@agenteschat/engine";
import { type Browser, browser, createTestServer, ORIGIN, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer();
});
afterEach(() => t.close());

const PDF = new TextEncoder().encode("%PDF-1.7 not really");

/** A multipart POST with the browser's session cookie and our Origin. */
function upload(b: Browser, path: string, fields: Record<string, string | File>, origin: string = ORIGIN) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return t.app.request(path, { method: "POST", headers: { cookie: b.cookie(), origin }, body: form });
}

test("people upload files as is: download with the real name and type, versions, no JSON shortcut", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const base = `/api/app/organizations/${orgId}`;
  const api = (path: string, init?: Parameters<typeof owner>[1]) => owner(`${base}${path}`, init);

  const created = await upload(owner, `${base}/artifacts/files`, {
    file: new File([PDF], "relatório.pdf", { type: "application/pdf" }),
    title: "Relatório",
  });
  expect(created.status).toBe(201);
  const a = (await created.json()) as { id: string; kind: string; untrusted: boolean; canEdit: boolean };
  expect(a).toMatchObject({
    kind: "file",
    title: "Relatório",
    untrusted: true,
    canEdit: true,
    versioned: true,
    content: { kind: "file", name: "relatório.pdf", contentType: "application/pdf", size: PDF.byteLength },
  });

  const file = await api(`/artifacts/${a.id}/file`);
  expect(file.status).toBe(200);
  expect(file.headers.get("content-type")).toBe("application/pdf");
  expect(file.headers.get("content-disposition")).toBe(
    `attachment; filename="relat_rio.pdf"; filename*=UTF-8''relat%C3%B3rio.pdf`,
  );
  expect(file.headers.get("x-content-type-options")).toBe("nosniff");
  expect(file.headers.get("content-security-policy")).toBe("sandbox");
  expect(file.headers.get("cache-control")).toBe("private, no-cache, no-transform");
  expect(file.headers.get("accept-ranges")).toBe("bytes");
  expect(new Uint8Array(await file.arrayBuffer())).toEqual(PDF);
  expect((await api(`/artifacts/${a.id}/file?format=pdf`)).status).toBe(400);

  // In parts, as a video player asks: the same safe headers on every part.
  const part = await api(`/artifacts/${a.id}/file`, { headers: { range: "bytes=1-4" } });
  expect(part.status).toBe(206);
  expect(part.headers.get("content-range")).toBe(`bytes 1-4/${PDF.byteLength}`);
  expect(part.headers.get("content-length")).toBe("4");
  expect(part.headers.get("content-disposition")).toStartWith("attachment;");
  expect(part.headers.get("content-security-policy")).toBe("sandbox");
  expect(new Uint8Array(await part.arrayBuffer())).toEqual(PDF.subarray(1, 5));
  const past = await api(`/artifacts/${a.id}/file`, { headers: { range: `bytes=${PDF.byteLength}-` } });
  expect(past.status).toBe(416);
  expect(past.headers.get("content-range")).toBe(`bytes */${PDF.byteLength}`);

  // A new version, by upload only.
  const v2 = await upload(owner, `${base}/artifacts/${a.id}/files`, {
    file: new File(["a,b\n1,2\n"], "dados.csv", { type: "text/csv" }),
    note: "agora em CSV",
  });
  expect(v2.status).toBe(200);
  expect(await v2.json()).toMatchObject({
    version: 2,
    content: { name: "dados.csv", contentType: "text/csv; charset=utf-8", text: "a,b\n1,2\n" },
  });
  const versions = (await (await api(`/artifacts/${a.id}/versions`)).json()) as { versions: { note: string | null }[] };
  expect(versions.versions.map((v) => v.note)).toEqual(["agora em CSV", null]);
  const viaJson = await api(`/artifacts/${a.id}/versions`, {
    json: { content: { kind: "document", markdown: "x" }, baseVersion: 2 },
  });
  expect(viaJson.status).toBe(400);
  const fileJson = await api("/artifacts", {
    json: {
      title: "Falso",
      content: { kind: "file", name: "x.pdf", contentType: "application/pdf", size: 1, sha256: "0" },
    },
  });
  expect(fileJson.status).toBe(400);

  // Versions of uploads only go to files.
  const doc = (await (
    await api("/artifacts", { json: { title: "Plano", content: { kind: "document", markdown: "# Plano" } } })
  ).json()) as { id: string };
  expect((await upload(owner, `${base}/artifacts/${doc.id}/files`, { file: new File([PDF], "x.pdf") })).status).toBe(
    400,
  );

  const list = (await (await api("/artifacts?kind=file")).json()) as { artifacts: { id: string }[] };
  expect(list.artifacts.map((x) => x.id)).toEqual([a.id]);
});

test("a file's bytes: a version cached for good, the newest checked again; only a download goes to the store", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const base = `/api/app/organizations/${orgId}`;
  const api = (path: string, headers: Record<string, string> = {}) => owner(`${base}${path}`, { headers });
  const made = await upload(owner, `${base}/artifacts/files`, { file: new File([PDF], "a.pdf") });
  const { id } = (await made.json()) as { id: string };
  const etag = `"${new Bun.CryptoHasher("sha256").update(PDF).digest("hex")}"`;

  // A script's fetch (the previews) gets the bytes from us.
  const pinned = await api(`/artifacts/${id}/file?version=1`, { "sec-fetch-mode": "cors" });
  expect(pinned.status).toBe(200);
  expect(pinned.headers.get("cache-control")).toBe("private, max-age=31536000, immutable, no-transform");
  expect(pinned.headers.get("etag")).toBe(etag);
  expect(new Uint8Array(await pinned.arrayBuffer())).toEqual(PDF);
  expect((await api(`/artifacts/${id}/file`)).headers.get("cache-control")).toBe("private, no-cache, no-transform");
  const unchanged = await api(`/artifacts/${id}/file`, { "if-none-match": `W/${etag}` });
  expect(unchanged.status).toBe(304);
  expect(await unchanged.text()).toBe("");
  // A part of a file the client no longer holds would mix two files: the whole of this one.
  const stale = await api(`/artifacts/${id}/file`, { range: "bytes=1-4", "if-range": '"older"' });
  expect(stale.status).toBe(200);
  expect((await api(`/artifacts/${id}/file`, { range: "bytes=1-4", "if-range": etag })).status).toBe(206);

  // A video or a sound in the page plays from us, in parts: the store's own address may be out of a network's reach
  // where ours is not.
  const played = await api(`/artifacts/${id}/file?version=1`, { "sec-fetch-mode": "no-cors", range: "bytes=1-4" });
  expect(played.status).toBe(206);
  expect(played.headers.get("location")).toBeNull();
  expect(new Uint8Array(await played.arrayBuffer())).toEqual(PDF.slice(1, 5));
  // A download goes to the store's short-lived link, never cached.
  const sent = await api(`/artifacts/${id}/file?version=1`, { "sec-fetch-mode": "navigate" });
  expect(sent.status).toBe(302);
  expect(sent.headers.get("location")).toStartWith("memory://");
  expect(sent.headers.get("cache-control")).toBe("private, no-store");
  // Only after the reader's check: a file in the trash gets no link.
  expect((await owner(`${base}/artifacts/${id}`, { method: "DELETE" })).status).toBe(204);
  expect((await api(`/artifacts/${id}/file?version=1`, { "sec-fetch-mode": "navigate" })).status).toBe(404);

  // A store that signs no links (a folder on disk) sends the bytes itself.
  const plain = await createTestServer({ signedBlobs: false });
  try {
    const someone = browser(plain);
    await signUp(someone, "owner@example.com");
    const other = await seedOrg(someone);
    const at = `/api/app/organizations/${other.orgId}`;
    const form = new FormData();
    form.set("file", new File([PDF], "a.pdf"));
    const sent = await plain.app.request(`${at}/artifacts/files`, {
      method: "POST",
      headers: { cookie: someone.cookie(), origin: ORIGIN },
      body: form,
    });
    const own = (await sent.json()) as { id: string };
    const res = await someone(`${at}/artifacts/${own.id}/file?version=1`, { headers: { "sec-fetch-mode": "no-cors" } });
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PDF);
  } finally {
    await plain.close();
  }
});

test("uploads: a file is required, other origins are refused, multipart only where it uploads, 50 MB at most", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const base = `/api/app/organizations/${orgId}`;

  const noFile = await upload(owner, `${base}/artifacts/files`, { title: "Nada" });
  expect(noFile.status).toBe(400);
  const crossSite = await upload(
    owner,
    `${base}/artifacts/files`,
    { file: new File([PDF], "a.pdf") },
    "https://evil.example.com",
  );
  expect(crossSite.status).toBe(403);
  // Other routes still take JSON only.
  expect((await upload(owner, `${base}/artifacts`, { title: "x" })).status).toBe(415);

  const big = await upload(owner, `${base}/artifacts/files`, {
    file: new File([new Uint8Array(ARTIFACT_LIMITS.fileBytes + 1)], "big.bin"),
  });
  // Refused from Content-Length (413) or after reading (400); either way nothing is stored.
  expect([400, 413]).toContain(big.status);
  expect(((await big.json()) as { error: { code: string } }).error.code).toBe("artifact.file_too_large");
  const list = (await (await owner(`${base}/artifacts`)).json()) as { artifacts: unknown[] };
  expect(list.artifacts).toEqual([]);
});

test("a picture is a snapshot: no versions, so a new one is refused in words the app shows", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const base = `/api/app/organizations/${orgId}`;
  const shot = await upload(owner, `${base}/artifacts/files`, {
    file: new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "tela.png", { type: "image/png" }),
    title: "Tela",
  });
  const shotView = (await shot.json()) as { id: string; versioned: boolean };
  expect(shotView.versioned).toBe(false);
  const shotV2 = await upload(owner, `${base}/artifacts/${shotView.id}/files`, {
    file: new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0])], "tela.png", { type: "image/png" }),
  });
  expect(shotV2.status).toBe(400);
  expect(((await shotV2.json()) as { error: { code: string } }).error.code).toBe("artifact.not_versioned");
});

test("an audio file keeps the wave the first app measured, and a sound stored untyped reads as audio by its name", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const base = `/api/app/organizations/${orgId}`;
  const api = (path: string, init?: Parameters<typeof owner>[1]) => owner(`${base}${path}`, init);
  const sound = (name: string, type: string) =>
    upload(owner, `${base}/artifacts/files`, { file: new File([new Uint8Array(64)], name, { type }) });

  const m4a = (await (await sound("entrevista.m4a", "application/octet-stream")).json()) as {
    id: string;
    content: { contentType: string };
  };
  expect(m4a.content.contentType).toBe("audio/mp4");
  for (const [name, type] of [
    ["faixa.flac", "audio/flac"],
    ["nota.opus", "audio/ogg"],
  ]) {
    const a = (await (await sound(name ?? "", "application/octet-stream")).json()) as {
      content: { contentType: string };
    };
    expect(a.content.contentType).toBe(type ?? "");
  }

  const put = (id: string, json: unknown) => api(`/artifacts/${id}/wave?version=1`, { method: "PUT", json });
  const first = await put(m4a.id, { peaks: [0.2, 0.9, 0.4], durationMs: 61_500 });
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ peaks: [0.2, 0.9, 0.4], durationMs: 61_500 });
  // Measured once: a second app's measure doesn't replace it.
  expect(await (await put(m4a.id, { peaks: [1, 1], durationMs: 2_000 })).json()).toEqual({
    peaks: [0.2, 0.9, 0.4],
    durationMs: 61_500,
  });
  expect(((await (await api(`/artifacts/${m4a.id}`)).json()) as { content: unknown }).content).toMatchObject({
    wave: { peaks: [0.2, 0.9, 0.4], durationMs: 61_500 },
  });

  const pdf = (await (
    await upload(owner, `${base}/artifacts/files`, { file: new File([PDF], "a.pdf", { type: "application/pdf" }) })
  ).json()) as { id: string };
  expect((await put(pdf.id, { peaks: [0.5], durationMs: 1_000 })).status).toBe(400);
  expect((await put(m4a.id, { peaks: [2], durationMs: 1_000 })).status).toBe(400);
});
