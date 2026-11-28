import { catalogFilePath, catalogStaticFiles, catalogWebFaces, fontsVersion } from "@agenteschat/engine";
import { catalogFont } from "@agenteschat/live";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { apiError } from "../http/errors";

/**
 * The fonts live files use (ADR 0220 §1), public like the app's own: they hold no workspace's data.
 *
 * - `GET /api/fonts/<id>.css`: the family's `@font-face` rules, pointing at its files (cached a day);
 * - `GET /api/fonts/v/<version>/<path>`: one file `catalog.json` lists (a WOFF2 face, a static TrueType instance for
 *   the phone, the license), cached for good: a new build changes `<version>`;
 * - `GET /api/fonts/<id>/static.json`: the family's static files by weight and style, for the phone.
 *
 * A file's own fonts (uploads, ADR 0220 §2) are served by the file's asset route, to whoever reads the file.
 */

const TYPES: Record<string, string> = {
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
};

const FOREVER = "public, max-age=31536000, immutable";
const A_DAY = "public, max-age=86400";

export function registerFonts(api: OpenAPIHono): void {
  api.get("/fonts/:name{[a-z0-9-]+\\.css}", (c) => {
    const id = c.req.param("name").replace(/\.css$/, "");
    const font = catalogFont(id);
    const faces = font ? catalogWebFaces(id) : [];
    if (!font || !faces.length) return apiError(c, 404, "font.not_found", "No such font on this server");
    const v = fontsVersion();
    const css = faces
      .map(
        (face) =>
          `@font-face{font-family:"${font.family}";src:url("/api/fonts/v/${v}/${face.file}") format("woff2");font-weight:${face.weight};font-style:${face.style};font-display:swap}`,
      )
      .join("\n");
    return c.body(css, 200, {
      "content-type": "text/css; charset=utf-8",
      "cache-control": A_DAY,
      "access-control-allow-origin": "*",
    });
  });

  api.get("/fonts/:id{[a-z0-9-]+}/static.json", (c) => {
    const id = c.req.param("id");
    if (!catalogFont(id)) return apiError(c, 404, "font.not_found", "No such font on this server");
    const v = fontsVersion();
    const files = Object.fromEntries(
      Object.entries(catalogStaticFiles(id)).map(([key, path]) => [key, `/api/fonts/v/${v}/${path}`]),
    );
    c.header("cache-control", A_DAY);
    return c.json({ files }, 200);
  });

  api.get("/fonts/v/:version/:id{[a-z0-9-]+}/*", async (c) => {
    const id = c.req.param("id");
    const prefix = `/api/fonts/v/${c.req.param("version")}/`;
    const relative = decodeURIComponent(new URL(c.req.url).pathname.slice(prefix.length));
    if (!relative.startsWith(`${id}/`) || relative.includes(".."))
      return apiError(c, 404, "font.not_found", "No such font file");
    const path = catalogFilePath(id, relative);
    if (!path) return apiError(c, 404, "font.not_found", "No such font file");
    const ext = relative.split(".").pop()?.toLowerCase() ?? "";
    const stale = c.req.param("version") !== fontsVersion();
    return new Response(Bun.file(path), {
      headers: {
        "content-type": TYPES[ext] ?? "application/octet-stream",
        // An old build's address still answers (with today's file), but isn't kept as if it were final.
        "cache-control": stale ? A_DAY : FOREVER,
        "access-control-allow-origin": "*",
        "x-content-type-options": "nosniff",
      },
    });
  });
}
