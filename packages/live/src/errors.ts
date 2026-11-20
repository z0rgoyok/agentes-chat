/**
 * Why an edit to a live document was refused (ADR 0196 §2): the thing it names isn't there, the document would pass
 * `LIVE_LIMITS`, or the input isn't something the document can hold. The engine turns these into its own coded
 * errors; the apps check the same limits before they write.
 */
export type LiveEditCode = "not_found" | "too_many" | "too_large" | "invalid";

export class LiveEditError extends Error {
  readonly code: LiveEditCode;
  constructor(code: LiveEditCode, message: string) {
    super(message);
    this.name = "LiveEditError";
    this.code = code;
  }
}
