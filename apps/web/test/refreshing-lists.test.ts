import { describe, expect, test } from "bun:test";

/**
 * Every list a tab or a filter refetches keeps what it held on screen while the next one loads (`placeholderData`), so
 * it says so the one shared way: `Refreshing` on the query's `isPlaceholderData`, never the old rows with no sign.
 */
const LISTS: [file: string, busy: string][] = [
  ["components/Audit.tsx", "audit.isPlaceholderData"],
  ["pages/NotificationsPage.tsx", "list.isPlaceholderData"],
  ["pages/ThreadsPage.tsx", "list.isPlaceholderData"],
  ["components/missions/MissionList.tsx", "busy"],
  ["pages/DrivePage.tsx", "list.isPlaceholderData"],
  ["pages/agent/FilesTab.tsx", "files.isPlaceholderData"],
  ["pages/IssuesPage.tsx", "issues.isPlaceholderData"],
  ["components/PeopleUsage.tsx", "usage.isPlaceholderData"],
  ["pages/SearchPage.tsx", "active && search.isPlaceholderData"],
  ["components/search/SearchResultsPanel.tsx", "ws.active && search.isPlaceholderData"],
];

describe("tabbed and filtered lists", () => {
  for (const [file, busy] of LISTS)
    test(`${file} keeps its list dimmed under a running bar while the next one loads`, async () => {
      const src = await Bun.file(new URL(`../src/${file}`, import.meta.url).pathname).text();
      expect(src).toContain(`<Refreshing busy={${busy}} label={t("common.loading")}>`);
    });
});
