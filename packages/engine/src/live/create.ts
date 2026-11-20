import { serverText } from "@agenteschat/i18n";
import type * as Y from "yjs";
import {
  type ArtifactActor,
  type ArtifactDeps,
  type ArtifactView,
  type FileSharing,
  insertLiveArtifact,
  isLiveArtifactKind,
  type LiveArtifactKind,
  type LivePicture,
  moveToSharedDrive,
} from "../artifacts";
import { ValidationError } from "../errors";
import { lineLocale, personLocale } from "../requester";
import { liveProblems, newLiveDoc, overLimit } from "./preview";

/**
 * Makes a spreadsheet, a presentation, a canvas or a document (ADR 0196 §1, ADR 0200): placed like any Drive file (a person in the Drive or
 * a conversation they read, with `upload_files`; an agent in its run's conversation), version 1 a snapshot of its
 * first document, its live document the same, its search text, audit and events. `init` fills the document before
 * version 1 (an agent's first rows, a deck's slides); what it leaves must keep the rules of shape. An agent's
 * `shared_drive` moves it to the shared Drive when its run may (`moveToSharedDrive`); refused, it stays where it was
 * made, and the tool says where it landed (`fileReach`).
 */
export async function createLiveFile(
  deps: ArtifactDeps,
  actor: ArtifactActor,
  orgId: string,
  input: {
    kind: LiveArtifactKind;
    title: string;
    channelId?: string | null;
    threadId?: string | null;
    shared_drive?: boolean;
    init?: (doc: Y.Doc) => void;
    note?: string;
    /** The language its first sheet is named in (`Sheet 1`, `Planilha 1`); else the person's own (or the run's). */
    locale?: string | null;
    /** Pictures it starts with, under the ids `init` names them by (an imported deck's, ADR 0198). */
    pictures?: readonly LivePicture[];
    /** Who else sees it, when not where it is placed's default (a Drive file opened from a Drive upload, ADR 0157). */
    sharing?: FileSharing;
  },
): Promise<ArtifactView> {
  if (!isLiveArtifactKind(input.kind))
    throw new ValidationError("kind must be spreadsheet, slides, canvas or document");
  const sheetName = input.kind === "spreadsheet" ? await firstSheetName(deps, actor, orgId, input.locale) : undefined;
  const doc = newLiveDoc(input.kind, sheetName ? { sheetName } : {});
  try {
    input.init?.(doc);
    const over = overLimit(doc, input.kind);
    if (over) throw new ValidationError(`The file would be too large (${over})`, "live.too_large", { limit: over });
    const problems = liveProblems(doc);
    if (problems.length > 0) throw new ValidationError(`The file can't be made: ${problems[0]}`);
    const toDrive = actor.type === "person" && input.shared_drive === true;
    const made = await insertLiveArtifact(deps, actor, orgId, {
      kind: input.kind,
      title: input.title,
      channelId: toDrive ? null : (input.channelId ?? null),
      threadId: toDrive ? null : (input.threadId ?? null),
      doc,
      note: input.note ?? null,
      pictures: input.pictures,
      sharing: input.sharing,
    });
    if (actor.type === "agent" && input.shared_drive === true && made.channelId) {
      try {
        await moveToSharedDrive(deps, actor, orgId, made.id);
        return { ...made, channelId: null, threadId: null, sharing: { mode: "everyone", userIds: [], roleIds: [] } };
      } catch {
        // Saved either way: where it landed is the tool's to say.
      }
    }
    return made;
  } finally {
    doc.destroy();
  }
}

/** The first sheet's name in the language of whoever makes the file: a person's own, else the one behind the run. */
async function firstSheetName(deps: ArtifactDeps, actor: ArtifactActor, orgId: string, locale?: string | null) {
  const code =
    actor.type === "person"
      ? await personLocale(deps.db, actor.userId, locale)
      : locale
        ? await personLocale(deps.db, null, locale)
        : await lineLocale(deps.db, orgId, null, actor.runId ?? null);
  return serverText(code, "live.defaults.sheetName", { n: "1" });
}
