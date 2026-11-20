import { ValidationError } from "../errors";
import { OFFICE_PART_BYTES } from "../file-reader";

/**
 * How much of an Office file the server reads (ADR 0198): files up to 25 MB, at most 40 MB inflated out of one (the
 * same bound `file-reader.ts` keeps against zip bombs, now over all the parts read, checked before each is inflated),
 * 200,000 cells and 300 slides. Past any of them the apps offer the download instead.
 */
export const OFFICE_LIMITS = {
  inputBytes: 25 * 1024 * 1024,
  unpackedBytes: OFFICE_PART_BYTES,
  cells: 200_000,
  slides: 300,
  /** Entries a package may list: far more than any real file has, few enough to index at once. */
  parts: 20_000,
  /** Pictures inlined in a document's HTML, together (each one is a data: address). */
  inlineImageBytes: 20 * 1024 * 1024,
} as const;

/** A file that can't be read: damaged, not what its name says, or using what we don't read. */
export function officeUnreadable(why?: string) {
  const message = why ? `This file couldn't be read: ${why}` : "This file couldn't be read";
  return new ValidationError(message, "office.unreadable");
}

/** A file past `OFFICE_LIMITS`: what is over, in the English message; the apps say it in the person's words. */
export function officeTooLarge(what: string) {
  return new ValidationError(`This file is too large to open here (${what})`, "office.too_large");
}

/** A kind of file the server doesn't read (`.doc`, `.ppt`, anything else). */
export function officeUnsupported(name: string) {
  return new ValidationError(`Files like ${name} can only be downloaded`, "office.unsupported");
}

/** A file locked with a password: only its own app opens it. */
export function officeEncrypted() {
  return new ValidationError("This file is protected with a password", "office.encrypted");
}

/** A file that reads, but past what a live file holds (ADR 0196 `LIVE_LIMITS`): it can still be seen, not edited. */
export function officeTooLargeToEdit(what: string) {
  return new ValidationError(`This file is too large to edit here (${what})`, "office.too_large_to_edit");
}

/** Whether an error is one of the readers' own refusals (passed on as it is, never wrapped). */
export function isOfficeError(error: unknown): error is ValidationError {
  return error instanceof ValidationError && error.code.startsWith("office.");
}
