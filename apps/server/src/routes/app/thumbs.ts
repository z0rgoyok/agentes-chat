import { storedFileOfArtifact } from "@agenteschat/engine";
import { apiError } from "../../http/errors";
import { imageFile } from "../../http/image-file";
import { THUMB_WIDTHS, thumbnail } from "../../http/thumbnail";
import { type AppDeps, createAppRouter, requireSession } from "./context";

/**
 * A picture of the Drive made small for where it shows (`?w=480` a conversation's tile, `960` a lone picture on a
 * high-density screen, `96` a face), at the version asked: WebP, which a version never changes, so the browser keeps it
 * for good. A file that isn't such a picture answers 415, and the app shows it as before.
 */
export function thumbRoutes(deps: AppDeps) {
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  app.get("/organizations/:orgId/artifacts/:artifactId/thumb", async (c) => {
    const width = THUMB_WIDTHS.find((w) => String(w) === c.req.query("w"));
    const version = Number(c.req.query("version"));
    if (!width || !Number.isSafeInteger(version) || version < 1) {
      return apiError(c, 400, "invalid_request", "Ask for a version and a width of 96, 480 or 960");
    }
    const artifacts = deps.extras?.artifacts;
    if (!artifacts) throw new Error("artifacts are not configured on this server");
    const orgId = c.req.param("orgId");
    const actor = { type: "person" as const, userId: c.get("user").id };
    const file = await storedFileOfArtifact(artifacts, actor, orgId, c.req.param("artifactId"), version);
    const small = await thumbnail(`${file.storageConfigId ?? "platform"}/${file.blobKey}`, width, async () => {
      const object = await (await artifacts.blobs.forConfig(orgId, file.storageConfigId)).get(file.blobKey);
      if (!object) throw new Error("The stored file is missing");
      return object.body;
    });
    if (!small) return apiError(c, 415, "artifact.no_thumbnail", "This file has no small picture");
    return imageFile({ body: small, contentType: "image/webp" });
  });
  return app;
}
