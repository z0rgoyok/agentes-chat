import { join } from "node:path";
import type { OpenAPIHono } from "@hono/zod-openapi";

/** The operator publishes this signed artifact atomically in the persistent files volume. */
export function registerManagedDownloads(app: OpenAPIHono, filesDir: string | undefined) {
  app.get("/downloads/tich-rooms.apk", async (c) => {
    if (!filesDir) return c.text("Release unavailable", 404);
    const apk = Bun.file(join(filesDir, "managed-releases", "tich-rooms.apk"));
    if (!(await apk.exists())) return c.text("Release unavailable", 404);
    return new Response(apk, {
      headers: {
        "Content-Type": "application/vnd.android.package-archive",
        "Content-Disposition": 'attachment; filename="tich-rooms.apk"',
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
