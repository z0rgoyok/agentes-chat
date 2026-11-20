import type { ArtifactActor, ArtifactView, LiveDeps } from "@agenteschat/engine";
import * as engine from "@agenteschat/engine";

/**
 * Engine functions the live files' routes call that come with parts of their own: reading uploaded Office files and
 * exporting live ones (ADR 0198). Each is read from the engine when a request needs it, so the routes around it work
 * on a server built without it, and typed as the engine types it once the engine exports it (else as these routes
 * expect it), so a change on either side fails the typecheck. Asking an agent from inside a file (ADR 0196 §6) is
 * the engine's own `askAgentAbout`, imported as is.
 */
export { askAgentAbout } from "@agenteschat/engine";

type Engine = typeof engine;
type Later<K extends string, Expected> = K extends keyof Engine ? Engine[K] : Expected;

function later<K extends string, Expected>(name: K): Later<K, Expected> {
  const fn = (engine as unknown as Record<string, unknown>)[name];
  if (typeof fn !== "function") throw new Error(`${name} is not built into this server`);
  return fn as Later<K, Expected>;
}

/** What a live file downloads as (ADR 0198). */
export type LiveExportFormat = "xlsx" | "csv" | "pptx" | "pdf";

type OfficePreview = (
  deps: LiveDeps,
  actor: ArtifactActor,
  orgId: string,
  fileId: string,
  version?: number,
) => Promise<unknown>;
type OpenAsLive = (deps: LiveDeps, actor: ArtifactActor, orgId: string, fileId: string) => Promise<ArtifactView>;
type ExportLive = (
  deps: LiveDeps,
  actor: ArtifactActor,
  orgId: string,
  fileId: string,
  format: LiveExportFormat,
) => Promise<{ body: Uint8Array; contentType: string; filename: string }>;

const person = (userId: string) => ({ type: "person" as const, userId });

/** An uploaded Office file as the apps draw it: a workbook, a deck or a document's HTML (ADR 0198). */
export function officePreview(deps: LiveDeps, userId: string, orgId: string, fileId: string, version?: number) {
  return later<"officePreview", OfficePreview>("officePreview")(deps, person(userId), orgId, fileId, version);
}

/** A new live file (or document) made from an uploaded Office file, beside it (ADR 0198). */
export function openAsLive(deps: LiveDeps, userId: string, orgId: string, fileId: string) {
  return later<"openAsLive", OpenAsLive>("openAsLive")(deps, person(userId), orgId, fileId);
}

/** A live file as it stands now, as an Office file, a CSV or a PDF (ADR 0198). */
export function exportLive(deps: LiveDeps, userId: string, orgId: string, fileId: string, format: LiveExportFormat) {
  return later<"exportLive", ExportLive>("exportLive")(deps, person(userId), orgId, fileId, format);
}

const built = (name: string) => typeof (engine as unknown as Record<string, unknown>)[name] === "function";

/** Whether this server's engine reads and writes Office files (tests of them wait for it). */
export const readsOffice = () => built("officePreview") && built("openAsLive") && built("exportLive");

/** Whether it writes live files' exports itself; without it `artifactFile` makes what it can of them. */
export const exportsLive = () => built("exportLive");
