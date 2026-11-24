import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { liveActivityLinkHref } from "../src/features/links/app-links";
import { facePath, liveActivityTargetOf } from "../src/features/live-activity/props";

const src = (file: string) => readFileSync(join(import.meta.dir, "..", file), "utf8");

describe("the agents' Live Activity (ADR 0210)", () => {
  test("a tap opens the conversation it shows, straight away in the workspace on screen, else through /link", () => {
    const url = "agenteschat://island?org=o1&channel=c1&thread=t1&message=m1";
    expect(liveActivityTargetOf(url)).toEqual({ orgId: "o1", channelId: "c1", threadId: "t1", messageId: "m1" });
    expect(liveActivityTargetOf("island?org=o1&channel=c1")).toEqual({
      orgId: "o1",
      channelId: "c1",
      threadId: null,
      messageId: null,
    });
    // Anything else, or one without its workspace or conversation, is not the island's.
    expect(liveActivityTargetOf("agenteschat://dataUrl=x")).toBeNull();
    expect(liveActivityTargetOf("agenteschat://island?org=o1")).toBeNull();
    const here = liveActivityLinkHref(url, "o1");
    expect(here?.startsWith("/link?")).toBe(false);
    expect(liveActivityLinkHref(url, "o2")).toStartWith("/link?org=o1&to=");
    expect(liveActivityLinkHref("https://example.com", "o1")).toBeNull();
    expect(src("app/+native-intent.tsx")).toContain("const island = liveActivityLinkHref(path, workspaceOnScreen());");
  });

  test("the faces are where the server points: <widgets directory>/faces/<agent id>.png", () => {
    expect(facePath("file:///group/widgets/", "a1")).toBe("file:///group/widgets/faces/a1.png");
    expect(facePath("file:///group/widgets", "a1")).toBe("file:///group/widgets/faces/a1.png");
  });

  test("iOS only: Android never loads expo-widgets, and the switch has nothing native", () => {
    expect(src("src/features/live-activity/useLiveActivity.ts")).not.toContain('from "expo-widgets"');
    expect(src("src/features/live-activity/switch.ts")).not.toContain('from "expo-widgets"');
    expect(src("src/features/me/PreferencePages.tsx")).toContain(
      'import { setLiveActivityOn, useLiveActivityOn } from "@/features/live-activity/switch";',
    );
    expect(src("src/features/live-activity/useLiveActivity.ios.ts")).toContain("addPushToStartTokenListener");
  });

  test("the extension is the widgets plugin's, with the Live Activity's pushes", () => {
    expect(src("app.config.ts")).toContain(
      '["expo-widgets", { enablePushNotifications: true, frequentUpdates: true }],',
    );
    const layout = src("src/features/live-activity/AgentsActivity.tsx");
    expect(layout).toContain('"widget";');
    expect(layout).toContain('export const AGENTS_ACTIVITY = "AgentsActivity";');
    for (const region of [
      "banner:",
      "compactLeading:",
      "compactTrailing:",
      "minimal:",
      "expandedLeading:",
      "expandedBottom:",
    ])
      expect([region, layout.includes(region)]).toEqual([region, true]);
  });

  test("the app registers its push-to-start token and every running activity's token, and stops when off", () => {
    const hook = src("src/features/live-activity/useLiveActivity.ios.ts");
    expect(hook).toContain("void api.push.liveActivityOff(id).catch(() => undefined);");
    expect(hook).toContain('activity.end("immediate")');
    expect(hook).toContain("activity.addPushTokenListener(");
    expect(hook).toContain("const token = await activity.getPushToken().catch(() => null);");
    expect(src("app/(app)/_layout.tsx")).toContain("<LiveActivityWork />");
  });
});
