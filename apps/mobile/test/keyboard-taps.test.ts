import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = (file: string) => readFileSync(join(import.meta.dir, "../src", file), "utf8");
/** The props of each scroll view in a file (`<ScrollView …>` or the keyboard library's `<KeyboardAwareScrollView …>`). */
const scrollViews = (text: string) =>
  [...text.matchAll(/<(?:KeyboardAware)?ScrollView\b([^>]*)>/g)].map((m) => m[1] ?? "");

test("a field in a scrolling screen: the button beside it takes the first tap with the keyboard up", () => {
  // The default budget (its Salvar) and an inbox reply on the island (its send).
  for (const file of ["features/usage/UsageScreen.tsx", "features/island/NoticeIsland.tsx"]) {
    const views = scrollViews(source(file));
    expect(views.length).toBeGreaterThan(0);
    for (const props of views) expect(props).toContain('keyboardShouldPersistTaps="handled"');
  }
});

test("a field low on a page scrolls clear of the keyboard on Android too, never by an iOS-only inset", () => {
  // With the keyboard library's provider at the root, Android no longer resizes the window: the shared pages, the
  // budget's screen and deleting the account scroll the focused field into view themselves, on both systems.
  for (const file of [
    "features/settings/parts.tsx",
    "features/me/parts.tsx",
    "features/usage/UsageScreen.tsx",
    "features/me/DeleteAccountScreen.tsx",
    "ui/auth/AuthScaffold.tsx",
  ]) {
    const text = source(file);
    expect({ file, aware: text.includes("<KeyboardAwareScrollView") }).toEqual({ file, aware: true });
    expect({ file, iosOnly: text.includes("automaticallyAdjustKeyboardInsets") }).toEqual({ file, iosOnly: false });
    for (const props of scrollViews(text))
      expect({ file, offset: props.includes("bottomOffset=") }).toEqual({
        file,
        offset: true,
      });
  }
  // The sign-in's steps: every step scrolls to its field (no opt-in left), clear of the bar over the keyboard, and the
  // footer still rides over the keyboard ("layout" grows a spacer the flexible gap gives way to).
  const auth = source("ui/auth/AuthScaffold.tsx");
  expect(auth).not.toContain("scrollToFocus");
  expect(auth).toContain('mode="layout"');
  expect(auth).toContain("bottomOffset={bar + FIELD_CLEARANCE}");
  expect(auth).toContain("extraKeyboardSpace={bar}");
  // A drag down the sign-in's screens takes the keyboard with the finger; no back circle drawn on its sky.
  expect(auth).toContain('keyboardDismissMode="interactive"');
  expect(auth).not.toContain("onBack");
  expect(source("features/onboarding/OnboardingFlow.tsx")).not.toContain("scrollToFocus");
  // A form of several fields gets the bar over the keyboard (‹ › and Done), and the page keeps clear of it.
  const page = source("features/settings/parts.tsx");
  expect(page).toContain("bottomOffset={bar + FIELD_CLEARANCE}");
  expect(page).toContain("{toolbar ? <KeyboardBar /> : null}");
  for (const file of [
    "features/settings/StorageScreen.tsx",
    "features/vault/VaultNewScreen.tsx",
    "features/vault/VaultItemScreen.tsx",
  ])
    expect({ file, bar: /<SettingsPage[^>]*\btoolbar\b/.test(source(file)) }).toEqual({ file, bar: true });
});

test("the budget's number pad: Done over it, and Salvar puts the keyboard away and spins while it saves", () => {
  const usage = source("features/usage/UsageScreen.tsx");
  expect(usage).toContain("<KeyboardBar arrows={false} />");
  const card = usage.slice(usage.indexOf("function DefaultBudgetCard("));
  expect(card).toContain("Keyboard.dismiss();");
  expect(card).toContain("loading={update.isPending}");
  // What was typed stays after a refusal: only a save that worked goes back to the saved amount.
  expect(card).toContain('const value = typed ?? (saved === undefined ? "" : number.format(saved));');
  expect(card.indexOf("setTyped(null);")).toBeGreaterThan(card.indexOf("onSuccess: () => {"));
});

test("deleting the account or the workspace: the password field waits, so the keyboard doesn't hide what goes", () => {
  for (const file of ["features/me/DeleteAccountScreen.tsx", "features/settings/DeleteWorkspaceScreen.tsx"]) {
    const field = source(file).match(/<PasswordField[\s\S]*?\/>/)?.[0] ?? "";
    expect({ file, waits: field.includes("autoFocus={false}") }).toEqual({ file, waits: true });
  }
});
