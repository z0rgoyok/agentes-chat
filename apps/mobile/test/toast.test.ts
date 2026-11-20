import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (path: string) => readFileSync(join(import.meta.dir, "../src", path), "utf8");

describe("toasts", () => {
  const toast = src("ui/Toast.tsx");

  test("drawn in TrueSheet's overlay, above every sheet, and only while one shows", () => {
    expect(toast).toContain('import { TrueSheetOverlay } from "@lodev09/react-native-true-sheet";');
    expect(toast).toMatch(/\{toasts\.shown \? \(\s*<ToastLayer>/);
    // A root of its own for the gestures there, as tall as the toast: a touch elsewhere goes to what is under it.
    expect(toast).toContain(
      '<GestureHandlerRootView pointerEvents="box-none" style={[styles.layer, { top: insets.top + 6 }]}>',
    );
    expect(toast).toContain('layer: { position: "absolute", left: 12, right: 12, alignItems: "center" },');
    // One host for the whole app: no sheet draws toasts of its own.
    expect(src("ui/Sheet.tsx")).not.toContain("ToastHost");
    expect(src("providers/AppProviders.tsx").match(/<ToastHost>/g)?.length).toBe(1);
  });

  test("a finger on it holds its time; lifted, the rest of it runs", () => {
    expect(toast).toMatch(/\.onBegin\(\(\) => \{\s*scheduleOnRN\(hold\);/);
    expect(toast).toMatch(/\.onFinalize\(\(\) => \{\s*scheduleOnRN\(release\);/);
    expect(toast).toContain("left.current = Math.max(0, due.current - Date.now());");
    expect(toast).toContain("arm(Math.max(RESUME_MS, left.current));");
  });

  test("a tap puts it away (on the action's word, it runs the action); the swipe goes first and keeps its rules", () => {
    expect(toast).toContain("return Gesture.Exclusive(pan, tap);");
    expect(toast).toMatch(/if \(e\.x >= actionFrom\.get\(\)\) scheduleOnRN\(act\);\s*else scheduleOnRN\(dismiss\);/);
    // Distance or a flick, the spring seeded with the finger's speed.
    expect(toast).toContain("if (y.get() < DISMISS_Y || e.velocityY < FLICK) {");
    expect(toast).toContain("y.set(withSpring(0, { ...SNAP_BACK, velocity: e.velocityY }));");
    // No pressable of React Native's in it: every touch is one of the toast's gestures.
    expect(toast).not.toContain("<Pressable");
    // Screen readers still reach the action as a button.
    expect(toast).toMatch(/accessibilityRole="button"\s*accessibilityLabel=\{item\.action\.label\}/);
    expect(toast).toContain('if (e.nativeEvent.actionName === "activate") act();');
  });

  test("a new toast waits for the one on screen to leave, then comes in", () => {
    expect(toast).toContain(
      "setToasts((now) => (now.shown ? { shown: now.shown, next: item } : { shown: item, next: null }));",
    );
    expect(toast).toContain("replaced={toasts.next !== null}");
    expect(toast).toMatch(/useEffect\(\(\) => \{\s*if \(replaced\) leave\(\);/);
    // Only the toast on screen hands over, once it has faded out.
    expect(toast).toContain("now.shown?.key === key ? { shown: now.next, next: null } : now");
    expect(toast).toContain("goneTimer.current = setTimeout(() => goneRef.current(item.key), GONE_MS);");
  });
});
