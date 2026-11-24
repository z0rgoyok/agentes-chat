import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { createTestServer } from "./harness";

/**
 * One process serves the API and the built web app (apps/web → WEB_DIR).
 * Client-side routes fall back to
 * index.html; /api/* never does.
 */
let dir: string;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "agentes-web-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), '<!doctype html><div id="root"></div>');
  writeFileSync(join(dir, "assets", "app.js"), "console.log(1)");
  mkdirSync(join(dir, "runner"));
  writeFileSync(join(dir, "runner", "agentes-runner.mjs"), "#!/usr/bin/env node\nconsole.log('runner')");
  writeFileSync(join(dir, "sw.js"), "self.addEventListener('push', () => {})");
  writeFileSync(join(dir, "manifest.webmanifest"), '{"name":"agentes.chat"}');
  writeFileSync(join(dir, "favicon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  writeFileSync(join(dir, "unavailable.html"), "<!doctype html><p>Unavailable</p>");
  app = createApp({ edition: "cloud", version: "test", modules: [], pingDatabase: async () => {}, webDir: dir });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("web app serving", () => {
  test("serves built assets", async () => {
    const res = await app.request("/assets/app.js");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("console.log(1)");
    // Mermaid's bundle is one of them, run by a sandboxed frame (an opaque origin) as a classic script: it must be
    // JavaScript and loadable from another origin.
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(res.headers.get("cross-origin-resource-policy")).toBeNull();
  });

  test("a script goes compressed when the build wrote it so and the browser takes it; the page never does", async () => {
    writeFileSync(join(dir, "assets", "app.js.br"), "brotli bytes");
    writeFileSync(join(dir, "assets", "app.js.gz"), "gzip bytes");
    const br = await app.request("/assets/app.js", { headers: { "accept-encoding": "gzip, deflate, br" } });
    expect(br.headers.get("content-encoding")).toBe("br");
    expect(br.headers.get("content-type")).toContain("text/javascript");
    expect(br.headers.get("vary")).toContain("Accept-Encoding");
    expect(await br.text()).toBe("brotli bytes");
    const gz = await app.request("/assets/app.js", { headers: { "accept-encoding": "gzip" } });
    expect(gz.headers.get("content-encoding")).toBe("gzip");
    const plain = await app.request("/assets/app.js");
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(await plain.text()).toBe("console.log(1)");
    const page = await app.request("/org/abc", { headers: { "accept-encoding": "br" } });
    expect(page.headers.get("content-encoding")).toBeNull();
    rmSync(join(dir, "assets", "app.js.br"));
    rmSync(join(dir, "assets", "app.js.gz"));
  });

  test("hashed assets open from disk; index.html is always revalidated", async () => {
    const asset = await app.request("/assets/app.js");
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    for (const path of ["/", "/org/abc/c/def"]) {
      const res = await app.request(path);
      expect(res.headers.get("cache-control")).toBe("no-cache");
    }
  });

  test("a build file that isn't there is a 404 nobody keeps, never index.html", async () => {
    for (const path of ["/assets/missing.js", "/assets/index-old.css"]) {
      const res = await app.request(path);
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).not.toContain('<div id="root">');
    }
  });

  test("client-side routes get index.html", async () => {
    for (const path of ["/", "/login", "/org/abc/c/def", "/invite/some-token"]) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('<div id="root">');
    }
  });

  test("a well-known file this build doesn't ship is a 404, never index.html", async () => {
    for (const path of [
      "/robots.txt",
      "/sitemap.xml",
      "/sitemap_index.xml",
      "/sitemap-index.xml",
      "/llms.txt",
      "/llms-full.txt",
      "/ads.txt",
      "/app-ads.txt",
      "/humans.txt",
      "/security.txt",
    ]) {
      const res = await app.request(path);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain('<div id="root">');
    }
  });

  test("a well-known file the build does ship is served", async () => {
    writeFileSync(join(dir, "llms.txt"), "# agentes.chat");
    try {
      const res = await app.request("/llms.txt");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("# agentes.chat");
      expect(res.headers.get("x-robots-tag")).toBeNull();
    } finally {
      rmSync(join(dir, "llms.txt"));
    }
  });

  test("an app address that ends like a file still gets index.html", async () => {
    for (const path of [
      "/org/abc/wiki/notes.md",
      "/org/abc/wiki/robots.txt",
      "/org/abc/wiki/sitemap.xml",
      "/org/acme.example/c/def",
      "/invite/a.b.c",
      "/invite/sitemap.xml",
      "/robots.txt.bak",
      "/my-sitemap.xml",
    ]) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('<div id="root">');
    }
  });

  test("every page of the app tells search engines not to index it", async () => {
    for (const path of ["/", "/login", "/org/abc/c/def", "/invite/some-token", "/index.html", "/unavailable.html"]) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toStartWith("text/html");
      expect(res.headers.get("x-robots-tag")).toBe("noindex");
    }
  });

  test("only pages say noindex: the API, build files, the service worker, the manifest and pictures don't", async () => {
    for (const path of [
      "/api/health",
      "/api/app/nothing-here",
      "/assets/app.js",
      "/assets/missing.js",
      "/sw.js",
      "/manifest.webmanifest",
      "/favicon.svg",
      "/runner/agentes-runner.mjs",
      "/robots.txt",
    ]) {
      const res = await app.request(path);
      expect(res.headers.get("content-type")).not.toStartWith("text/html");
      expect(res.headers.get("x-robots-tag")).toBeNull();
    }
  });

  test("a /.well-known answer of the server's own doesn't say noindex", async () => {
    const t = await createTestServer();
    try {
      const { db, auth, config, adapters } = t;
      const full = createApp({
        edition: "selfhost",
        version: "test",
        modules: [],
        pingDatabase: async () => {},
        services: { db, auth, config, adapters },
        webDir: dir,
      });
      for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server"]) {
        const res = await full.request(path);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toStartWith("application/json");
        expect(res.headers.get("x-robots-tag")).toBeNull();
      }
      // Not set up on this server: a 404 of its own, not the app's page.
      const links = await full.request("/.well-known/assetlinks.json");
      expect(links.status).toBe(404);
      expect(links.headers.get("x-robots-tag")).toBeNull();
      expect((await full.request("/")).headers.get("x-robots-tag")).toBe("noindex");
    } finally {
      await t.close();
    }
  });

  test("unknown API routes stay JSON 404s", async () => {
    const res = await app.request("/api/app/nothing-here");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
  });

  test("API answers are never stored, even at a path that ends like a file", async () => {
    const health = await app.request("/api/health");
    expect(health.status).toBe(200);
    expect(health.headers.get("cache-control")).toBe("no-store");
    const missing = await app.request("/api/app/x.png");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
  });

  test("every response refuses framing and pins the base URI (clickjacking defense)", async () => {
    for (const path of ["/", "/login", "/api/health"]) {
      const res = await app.request(path);
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    }
  });

  test("a frame on our pages can't navigate to another site", async () => {
    const policy = (await app.request("/")).headers.get("content-security-policy") ?? "";
    const frames = policy.split(";").find((d) => d.trim().startsWith("frame-src")) ?? "";
    expect(frames).toContain("blob:");
    expect(frames).not.toContain("*");
    expect(frames).not.toContain("https: ");
  });

  test("the runner bundle: JavaScript, revalidated, and never index.html when missing", async () => {
    const res = await app.request("/runner/agentes-runner.mjs");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.text()).toContain("runner");
    const missing = await app.request("/runner/other.mjs");
    expect(missing.status).toBe(404);
    expect(await missing.text()).not.toContain('<div id="root">');
  });
});
