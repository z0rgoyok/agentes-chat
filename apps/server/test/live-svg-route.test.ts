import { afterEach, beforeEach, expect, test } from "bun:test";
import { type Browser, browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

/**
 * An SVG picture of a live file (ADR 0196 §8) is stored as the sanitizer rebuilt it and served as a picture only: its
 * own type, `nosniff`, and a CSP that runs and loads nothing, also when opened on its own in a tab.
 */

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
});
afterEach(async () => {
  await t.close();
});

const upload = (bytes: Uint8Array, name: string, type: string) => {
  const form = new FormData();
  form.append("file", new File([bytes as Uint8Array<ArrayBuffer>], name, { type }));
  return form;
};

test("an SVG added to a canvas is cleaned when stored and served with a CSP that allows nothing", async () => {
  const owner: Browser = browser(t);
  await signUp(owner, "owner@example.com");
  const org = await seedOrg(owner);
  const api = (path: string, init?: Parameters<Browser>[1]) =>
    owner(`/api/app/organizations/${org.orgId}${path}`, init);
  const made = await api("/live-files", { json: { kind: "canvas", title: "Ícones" } });
  expect(made.status).toBe(201);
  const canvas = (await made.json()) as { id: string };

  const svg = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" onload="alert(1)"><script>alert(1)</script>' +
      '<rect width="24" height="24" fill="#0063d1"/></svg>',
  );
  const added = await api(`/artifacts/${canvas.id}/assets`, {
    method: "POST",
    body: upload(svg, "icon.svg", "image/svg+xml"),
  });
  expect(added.status).toBe(201);
  const asset = (await added.json()) as { id: string; contentType: string; width: number; height: number };
  expect(asset).toMatchObject({ contentType: "image/svg+xml", width: 512, height: 512 });

  const got = await api(`/artifacts/${canvas.id}/assets/${asset.id}`);
  expect(got.status).toBe(200);
  expect(got.headers.get("content-type")).toBe("image/svg+xml");
  expect(got.headers.get("x-content-type-options")).toBe("nosniff");
  expect(got.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
  const text = await got.text();
  expect(text).toBe(
    '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 24 24"><rect width="24" height="24" fill="#0063d1"/></svg>',
  );

  // An SVG that can't be read is refused with its reason.
  const bad = new TextEncoder().encode('<!DOCTYPE svg [<!ENTITY a "b">]><svg viewBox="0 0 1 1"/>');
  const refused = await api(`/artifacts/${canvas.id}/assets`, {
    method: "POST",
    body: upload(bad, "x.svg", "image/svg+xml"),
  });
  expect(refused.status).toBe(400);
  expect(await refused.json()).toMatchObject({ error: { code: "live.svg_invalid" } });
});
