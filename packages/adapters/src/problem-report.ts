/**
 * What the server and the desktop app share of a problem report (format 1), browser-safe: its size limits and the
 * cut that keeps it under them.
 */

/** The contract's limit. Senders keep their reports under `PROBLEM_REPORT_TARGET_BYTES` to leave room. */
export const PROBLEM_REPORT_MAX_BYTES = 256 * 1024;
export const PROBLEM_REPORT_TARGET_BYTES = 200 * 1024;

export type ProblemLogName = "runner" | "server" | "desktop" | "desktop_steps";

/**
 * Cuts logs until the JSON fits `PROBLEM_REPORT_TARGET_BYTES`: server lines to 150, runner and desktop lines to 150,
 * then every log to 50, then each line to 300 characters.
 */
export function capProblemReport<T extends { logs?: { name: ProblemLogName; lines: string[] }[] | undefined }>(
  report: T,
): T {
  const size = (r: T) => new TextEncoder().encode(JSON.stringify(r)).length;
  const cut = (r: T, names: ProblemLogName[], lines: number, chars = 1000): T => ({
    ...r,
    logs: r.logs?.map((l) =>
      names.includes(l.name) ? { ...l, lines: l.lines.slice(-lines).map((s) => s.slice(0, chars)) } : l,
    ),
  });
  const all: ProblemLogName[] = ["server", "runner", "desktop", "desktop_steps"];
  const steps = [
    (r: T) => cut(r, ["server"], 150),
    (r: T) => cut(r, ["runner", "desktop"], 150),
    (r: T) => cut(r, all, 50),
    (r: T) => cut(r, all, 50, 300),
  ];
  let out = report;
  for (const step of steps) {
    if (size(out) <= PROBLEM_REPORT_TARGET_BYTES) break;
    out = step(out);
  }
  return out;
}
