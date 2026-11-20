import { SECRET_FILE } from "./agent-import";
import { ValidationError } from "./errors";
import { can, requirePermission } from "./organizations";
import { type GithubReadDeps, linkedRepository } from "./skills";
import { inflateZipEntry, zip } from "./zip";

/**
 * Notes for the wiki from a GitHub link (a repository, a folder or one Markdown file): what the app's own import
 * reads from a folder, as one zip. Notes always; the files they may embed while they fit.
 */
export const WIKI_GITHUB_LIMITS = { bytes: 100 * 1024 * 1024, fileBytes: 50 * 1024 * 1024, notes: 5000 };

const NOTE = /\.(md|markdown)$/i;
/** What a note may embed (the Drive's kinds the import sends). */
const ATTACHMENT = /\.(png|jpe?g|gif|webp|svg|avif|bmp|pdf|mp4|mov|webm|mp3|wav|m4a|ogg|xlsx?|csv|docx?|pptx?|txt)$/i;
/**
 * Hidden folders and files (`.git`, `.github`, `.obsidian`, `.env`) and installed packages: never read. Nor are the
 * files where apps keep keys and sign-ins (`SECRET_FILE`: `credentials.csv`, `secrets.txt`), whatever names them.
 */
const LEFT_OUT = /(^|\/)(\.[^/]*|node_modules)(\/|$)/;

const tooLarge = () =>
  new ValidationError(
    "That repository holds too many notes to read from a link. Upload it as a .zip instead.",
    "wiki.github_too_large",
  );

/**
 * The Markdown notes at or below a GitHub link, and the files a note names (an image, a PDF), as a zip with paths
 * relative to the link: a file no note mentions never leaves the server. Nothing is saved: the app reviews it as it reviews a folder, then imports. A private
 * repository is read through the workspace's GitHub (the GitHub App's token for it, else the connection's) for who
 * edits any agent (`manage_agents`, as installing a skill from one asks); tokens never leave the server.
 */
export async function readGithubNotes(deps: GithubReadDeps, actorId: string, orgId: string, url: string) {
  const membership = await requirePermission(deps.db, actorId, orgId, "edit_wiki");
  const through = can(membership, "manage_agents") ? deps : { ...deps, github: undefined };
  const { target, zip: archive, files } = await linkedRepository(through, orgId, url);
  if (target.kind === "file") {
    const entry = files.get(target.path);
    if (!entry || !NOTE.test(target.path)) throw new ValidationError("Link a Markdown file, a folder or a repository");
    if (entry.size > WIKI_GITHUB_LIMITS.fileBytes) throw tooLarge();
    return zip([[target.path.split("/").pop() ?? target.path, inflateZipEntry(archive, entry)]]);
  }
  const base = target.path.replace(/^\/+|\/+$/g, "");
  const prefix = base ? `${base}/` : "";
  const nameOf = (path: string) => path.split("/").pop() ?? path;
  const inside = [...files]
    .filter(([path]) => path.startsWith(prefix) && !LEFT_OUT.test(path.slice(prefix.length)))
    .filter(([path]) => !SECRET_FILE.test(nameOf(path)))
    .map(([path, entry]) => ({ path: path.slice(prefix.length), entry }));
  const notes = inside.filter((f) => NOTE.test(f.path));
  if (notes.length === 0) {
    throw new ValidationError("No Markdown notes in that link", "wiki.github_no_notes");
  }
  let total = notes.reduce((n, f) => n + f.entry.size, 0);
  if (notes.length > WIKI_GITHUB_LIMITS.notes || total > WIKI_GITHUB_LIMITS.bytes) throw tooLarge();
  const read = notes.map((f) => ({ path: f.path, data: inflateZipEntry(archive, f.entry) }));
  const text = read.map((f) => new TextDecoder().decode(f.data)).join("\n");
  /** A note names the file, as written or as a link encodes it. */
  const named = (path: string) => text.includes(nameOf(path)) || text.includes(encodeURIComponent(nameOf(path)));
  // Only what a note names, while it fits, the smallest first: a note keeps its text without them.
  const attachments = inside
    .filter((f) => ATTACHMENT.test(f.path) && f.entry.size <= WIKI_GITHUB_LIMITS.fileBytes && named(f.path))
    .sort((a, b) => a.entry.size - b.entry.size)
    .filter((f) => {
      if (total + f.entry.size > WIKI_GITHUB_LIMITS.bytes) return false;
      total += f.entry.size;
      return true;
    });
  return zip([
    ...read.map((f): [string, Uint8Array] => [f.path, f.data]),
    ...attachments.map((f): [string, Uint8Array] => [f.path, inflateZipEntry(archive, f.entry)]),
  ]);
}
