import { describe, expect, test } from "bun:test";

/**
 * As on the web: a list a tab or a filter refetches keeps what it held while the next one loads, dimmed under a bar
 * (`Refreshing` on the query's `isPlaceholderData`), never the old rows with no sign.
 */
const LISTS: [file: string, busy: string][] = [
  ["features/settings/AuditScreen.tsx", "audit.isPlaceholderData"],
  ["features/activity/ActivityScreen.tsx", "list.isPlaceholderData"],
  ["features/drive/DriveScreen.tsx", "list.isPlaceholderData"],
  ["features/issues/IssuesScreen.tsx", "issues.isPlaceholderData"],
  ["features/search/SearchFilters.tsx", "hits.isPlaceholderData"],
];

describe("tabbed and filtered lists", () => {
  for (const [file, busy] of LISTS)
    test(`${file} keeps its list dimmed under a bar while the next one loads`, async () => {
      const src = await Bun.file(new URL(`../src/${file}`, import.meta.url).pathname).text();
      expect(src).toContain(`<Refreshing busy={${busy}} label={t("common.loading")}>`);
    });

  test("the kit's Refreshing waits as the web's does, then dims and shows a bar read out as loading", async () => {
    const src = await Bun.file(new URL("../src/ui/Skeleton.tsx", import.meta.url).pathname).text();
    expect(src).toContain("const REFRESH_DELAY_MS = 150;");
    expect(src).toMatch(/const to = shown \? 0\.5 : 1;/);
    expect(src).toContain('accessibilityRole="progressbar"');
  });
});
