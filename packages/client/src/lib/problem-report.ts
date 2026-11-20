import { ApiError } from "../api/http";

/** A browser's family and major version from its User-Agent (`chrome 142`), never the whole string. */
export function browserFamily(userAgent: string): string | undefined {
  const rules: [RegExp, string][] = [
    [/Edg\/(\d+)/, "edge"],
    [/OPR\/(\d+)/, "opera"],
    [/Firefox\/(\d+)/, "firefox"],
    [/Chrome\/(\d+)/, "chrome"],
    [/Version\/(\d+)[^ ]* (?:Mobile\/\S+ )?Safari\//, "safari"],
  ];
  for (const [rule, name] of rules) {
    const major = rule.exec(userAgent)?.[1];
    if (major) return `${name} ${major}`;
  }
  return undefined;
}

/** An email the report may carry as the reply address: empty is fine, it's optional. */
export const replyAddressOk = (email: string) =>
  email.trim() === "" || (email.trim().length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()));

/** The words for a failed send: the cause and one way out, as `problemReport.*` keys. */
export function problemReportError(error: unknown): { key: string; params?: Record<string, string | number> } {
  if (error instanceof ApiError) {
    if (error.code === "rate_limited") {
      const seconds = Number(error.params?.retryAfterS) || 60;
      return { key: "problemReport.errorRate", params: { minutes: Math.max(1, Math.ceil(seconds / 60)) } };
    }
    if (error.code === "refused" || error.code === "too_large" || error.status === 400)
      return { key: "problemReport.errorRefused" };
  }
  return { key: "problemReport.errorUnreachable" };
}

/** The report as Copy report gives it: what's sent, with the note and address as typed. */
export function problemReportCopy(text: string, note: string, replyTo: string) {
  return [text, note.trim() && `\nnote: ${note.trim()}`, replyTo.trim() && `replyTo: ${replyTo.trim()}`]
    .filter(Boolean)
    .join("\n");
}
