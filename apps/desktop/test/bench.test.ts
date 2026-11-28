import { describe, expect, test } from "bun:test";
import { idleCpu, type Run, report, type Sample, summarize } from "../scripts/bench";

const MB = 2 ** 20;
const sample = (ms: number, appMb: number, webMb: number, appCpu: number, webCpu: number): Sample => ({
  ms,
  app: { bytes: appMb * MB, cpuMs: appCpu, processes: 1 },
  webview: { bytes: webMb * MB, cpuMs: webCpu, processes: 4 },
});

/** An opening as the app writes it (bench.rs), painted at `ready` ms. */
const opening = (kind: Run["kind"], ready: number, extra: Partial<Run> = {}): Run => ({
  kind,
  spawnedAtMs: 1_000,
  version: "0.9.0",
  startedAtMs: 1_040,
  setupMs: 120,
  windowMs: 180,
  pageReadyMs: ready,
  coverGoneMs: ready + 300,
  paints: [["/org/o/c/c", ready]],
  // 30 s shown: 300 ms of CPU, 1 %; 30 s hidden: 60 ms, 0.2 %.
  shown: [sample(ready + 20_000, 80, 300, 1_000, 2_000), sample(ready + 50_000, 82, 310, 1_100, 2_200)],
  hidden: [sample(ready + 80_000, 81, 250, 1_120, 2_230), sample(ready + 110_000, 81, 240, 1_140, 2_270)],
  error: null,
  ...extra,
});

describe("the bench's summary", () => {
  test("idle CPU is the app's and its web view's CPU over the stretch, in % of a core", () => {
    expect(idleCpu(opening("warm", 2_000).shown)).toBeCloseTo(1);
    expect(idleCpu(opening("warm", 2_000).hidden)).toBeCloseTo(0.2);
    expect(idleCpu([])).toBeNull();
    const unreadable = sample(10_000, 1, 1, 0, 0);
    unreadable.webview.cpuMs = null;
    expect(idleCpu([sample(0, 1, 1, 0, 0), unreadable])).toBeNull();
  });

  test("the first opening apart, the warm ones' median and p95, the floor beside them; failed ones left out", () => {
    const runs = [
      opening("first", 4_100, {
        paints: [
          ["/desktop/handover", 2_900],
          ["/org/o/c/c", 4_100],
        ],
      }),
      ...[2_300, 2_100, 2_500, 2_200, 2_900].map((ms) => opening("warm", ms)),
      opening("warm", 9_999, { failed: "it opened on /login instead of /org/o/c/c" }),
      opening("floor", 600, {
        paints: [
          ["/", 600],
          ["/", 12_900],
        ],
        shown: [sample(20_600, 40, 90, 100, 200), sample(50_600, 40, 92, 103, 203)],
        hidden: [],
      }),
    ];
    const row = (label: string) => summarize(runs).find((r) => r.label.includes(label));
    expect(row("Opening")).toMatchObject({ first: 4_100, median: 2_300, p95: 2_900, floor: 600 });
    expect(row("The system starts")).toMatchObject({ first: 40, median: 40 });
    expect(row("Memory shown: total")).toMatchObject({ first: 392 * MB, floor: 132 * MB });
    expect(row("Memory hidden: web view")).toMatchObject({ median: 240 * MB, floor: null });
    expect(row("Idle CPU shown")?.floor).toBeCloseTo(0.02);

    const text = report(runs, "**A runner**");
    expect(text).toContain("| **Opening**: the site's first screen | 4100 ms | 2300 ms | 2900 ms | 600 ms |");
    expect(text).toContain("| **Memory shown: total** | 392 MB | 392 MB | 392 MB | 132 MB |");
    expect(text).toContain("| **Idle CPU hidden** | 0.2 % | 0.2 % | 0.2 % | – |");
    expect(text).toContain("| Web view processes | 4 | 4 | 4 | 4 |");
    expect(text).toContain("6 warm openings.");
    expect(text).toContain("- A warm opening failed: it opened on /login instead of /org/o/c/c");
    // Only a paint after the one that ended the opening is a page loaded again, never the sign-in on the way.
    expect(text.match(/loaded again/g)).toHaveLength(1);
    expect(text).toContain("- A floor opening's page loaded again: `/` painted at 12900 ms");
  });
});
