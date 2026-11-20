import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * A pushed screen's title and its line (the step, the board, the plan, who sent a file) stand together in the bar,
 * centred: the navigator's bar has no subtitle, so `PushedHeader` draws both as its title (the navigator's own
 * `headerTitle`), kept clear of the wider side so the bar never pushes them against the back button.
 */
const APP = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(APP, path), "utf8");

test("PushedHeader puts nothing in the screen, only its options", () => {
  // The navigator finds a screen's list through the screen's first children (to fold a large title, to turn the bar
  // to glass as the list scrolls under it): a view of the header placed there hid the list from it, and large titles
  // stayed open over the lists.
  const parts = read("src/features/shared/parts.tsx");
  const header = parts.slice(parts.indexOf("export function PushedHeader({"), parts.indexOf("const titleSide ="));
  expect(header).toContain("  return <Stack.Screen options={options} />;\n}");
  expect(header.match(/return /g)?.length).toBe(1);
  expect(existsSync(join(APP, "modules/nav-subtitle"))).toBe(false);
});

test("a title's line is drawn with it, kept clear of the wider side so the bar centres both", () => {
  const parts = read("src/features/shared/parts.tsx");
  expect(parts).toContain('const custom = (title != null && typeof title !== "string") || line !== undefined;');
  expect(parts).toContain("side={line !== undefined ? titleSide(word, rightCount) : word !== null ? 100 : 75}");
});

test("the screens hand their line to the bar", () => {
  expect(read("src/features/settings/parts.tsx")).toMatch(/<PushedHeader\s+title=\{title\}\s+subtitle=\{subtitle\}/);
  expect(read("src/features/ai/KeyForAllScreen.tsx")).toContain("subtitle={plan?.label}");
  expect(read("src/features/dashboards/ShareScreen.tsx")).toContain("subtitle={board.title}");
  expect(read("src/features/dashboards/OrganizeScreen.tsx")).toContain(
    'subtitle={home ? t("dashboards.home") : board.title}',
  );
  expect(read("src/features/usage/UsageAccountScreen.tsx")).toContain("subtitle={subtitle || undefined}");
  // A live file: "Read-only", or a lasting dropped connection, in the warning's colour where the app draws it.
  const live = read("src/features/live-files/shared/LiveBar.tsx");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the bar's source
  expect(live).toContain("subtitle={status ? t(`mobile.live.status.${status}`) : undefined}");
  expect(live).toContain('subtitleColor={status === "readOnly" ? c.faint : c.warn}');
});

test("General saves as a control moves, as the system's settings do: no Saved flashing under the title", () => {
  const general = read("src/features/settings/GeneralScreen.tsx");
  expect(general).not.toContain("subtitle=");
  expect(general).not.toContain("SAVED_MS");
  // A screen reader still hears that the change stuck.
  expect(general).toContain('onSuccess: () => AccessibilityInfo.announceForAccessibility(t("settings.savedShort")),');
});
