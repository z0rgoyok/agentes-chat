import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { addTargets, channelMembersHrefs } from "../../src/features/chat/members";
import { newMissionHref } from "../../src/features/chat/new-mission";
import { pushedByDefault } from "../main-stack";
import { chatScreenSource } from "./chat-screen-source";

const src = (file: string) => readFileSync(join(import.meta.dir, "../../src", file), "utf8");
const route = (file: string) => readFileSync(join(import.meta.dir, "../../app/(app)/(main)", file), "utf8");

describe("managing a channel's members is screens, not sheet steps", () => {
  test("the list, adding and one agent each have their address, by the channel's id", () => {
    expect(channelMembersHrefs.list("c1")).toBe("/channel-members?channelId=c1");
    expect(channelMembersHrefs.add("c1")).toBe("/channel-members-add?channelId=c1");
    expect(channelMembersHrefs.agent("c1", "a1")).toBe("/channel-agent?channelId=c1&agentId=a1");
    expect(addTargets(["agent:a1", "person:u1"])).toEqual([{ agentId: "a1" }, { userId: "u1" }]);
  });

  test("each is pushed with the stack's bar and back, and an address without a channel lands on the home", () => {
    for (const name of ["channel-members", "channel-members-add", "channel-agent", "mission-new"]) {
      expect({ name, pushed: pushedByDefault(name) }).toEqual({ name, pushed: true });
      expect(route(`${name}.tsx`)).toContain('<LandOn href="/" />');
    }
  });

  test("the conversation pushes the list, keeping its place for the way back; its options' sheet goes first", () => {
    const chat = chatScreenSource();
    expect(chat).toMatch(
      /const openMembers = \(\) => \{\s*if \(!channel\) return;\s*leavePlace\(\);\s*router\.push\(channelMembersHrefs\.list\(channelId\)\);/,
    );
    expect(chat).toMatch(/\(\) => \{\s*sheet\.close\(\);\s*openMembers\(\);\s*\}/);
    // The channel's pill says what a tap does: it shows who is here (the "…" holds the options).
    expect(chat).toContain("const pressMembers = useLatest(openMembers);");
    expect(chat).toMatch(/onPress=\{pressMembers\}[\s\S]{0,300}label=\{t\("mobile\.chat\.headerMembers"/);
  });

  test("on the grouped page: grouped rows, the rows' shape while loading, a retry when it failed, a clear for a search", () => {
    const members = src("features/chat/ChannelMembers.tsx");
    expect(members).toContain("<SettingsPage");
    expect(members).not.toMatch(/<Card>|<Row\b|ActivityIndicator|Alert\.alert/);
    expect(members).toContain("<SkeletonList rows={4} />");
    expect(members).toContain("<LoadFailed onRetry={() => void roster.refetch()} />");
    expect(members).toMatch(/label=\{t\("filters\.clearSearch"\)\}\s*onPress=\{\(\) => setQ\(""\)\}/);
    // Removing someone asks first and says it's done; adding says how many went in.
    expect(members).toContain('t("mobile.chat.memberRemoved", { name: w.name, channel: channelName })');
    expect(members).toContain('t("mobile.chat.membersAdded", { count: selected.size, channel: channelName })');
    // The agent's screen goes back once, whether its own removal or a refreshed roster says it's out.
    expect(members).toContain("if (left.current) return;");
  });
});

describe("a new mission is a form on its own screen", () => {
  test("its start travels in the address", () => {
    expect(newMissionHref({ channelId: "c1" })).toBe("/mission-new?channelId=c1");
    expect(
      newMissionHref({ channelId: "c1", threadId: "t1", goal: "Ship it", agentId: "a1", currentThreadId: "t1" }),
    ).toBe("/mission-new?channelId=c1&threadId=t1&goal=Ship+it&agentId=a1&current=t1");
    expect(newMissionHref({ channelId: "c1", goal: "  " })).toBe("/mission-new?channelId=c1");
  });

  test("the conversation pushes it from every way in, closing whatever sheet asked", () => {
    const chat = chatScreenSource();
    expect(chat).toMatch(/const openNewMission = [^{]*\{\s*sheet\.close\(\);\s*leavePlace\(\);\s*router\.push\(/);
    expect(chat).not.toContain("NewMissionForm");
    expect(src("features/chat/sheets.tsx")).not.toContain("NewMissionForm");
  });

  test("the bar's word asks for the plan; who does it is a grouped choice; leaving with a goal typed asks first", () => {
    const screen = src("features/chat/NewMissionScreen.tsx");
    expect(screen).toMatch(/label: t\("mobile\.newMission\.submit"\),\s*disabled: !ready,\s*onPress: submit/);
    expect(screen).toContain("checked={a.agentId === chosen}");
    expect(screen).toContain("useUnsavedGuard(");
    expect(screen).toContain("<LoadFailed onRetry={() => void eligible.refetch()} />");
    expect(screen).not.toContain("ActivityIndicator");
  });
});

describe("the conversation's sheets", () => {
  test("Fixadas are the sheets' grouped rows, with the rows' shape while loading and an empty state", () => {
    const pins = src("features/chat/PinsSheet.tsx");
    expect(pins).not.toMatch(/<Card>|<Row\b|ActivityIndicator/);
    expect(pins).toContain("<SkeletonList rows={3} />");
    expect(pins).toContain('<EmptyState size="inline" title={t("mobile.pins.empty")} />');
    // The pulled-down lines are a finger's 44 tall.
    expect(pins).toContain("height: TOUCH");
  });

  test("the search's results run exactly to the sheet's edges", () => {
    const search = src("features/search/ConversationSearch.tsx");
    expect(search).toContain("marginHorizontal: -SHEET_X");
    expect(search).not.toContain("marginHorizontal: -18");
  });

  test("the switcher and the GIFs and stickers say when nothing matches, with a way to clear the search", () => {
    expect(src("features/chat/ConversationSwitcher.tsx")).toMatch(
      /label=\{t\("filters\.clearSearch"\)\}\s*onPress=\{\(\) => setQ\(""\)\}/,
    );
    const media = src("features/chat/MediaPickerSheet.tsx");
    expect(media.match(/label=\{t\("filters\.clearSearch"\)\}/g)).toHaveLength(2);
    // Loading GIFs shows the masonry's bones, not a bare spinner; a failure says why and offers to try again.
    expect(media).toContain("<GifBones />");
    expect(media).toContain('title={why ?? t("media.gifs.error")}');
  });

  test("a mission's summary: one fact a row, the rows' shape while loading, a retry when it failed", () => {
    const sheets = src("features/chat/sheets.tsx");
    expect(sheets).toContain("<LoadFailed onRetry={() => void summary.refetch()} />");
    expect(sheets).not.toContain("ActivityIndicator");
  });

  test("the reactions in a message's sheet and the ×s in the field press as every control does", () => {
    const sheets = src("features/chat/sheets.tsx");
    expect(sheets).not.toContain("emoPressed");
    expect(sheets).toMatch(/<PressScale\s+key=\{e\}/);
    const strip = src("features/chat/AttachmentStrip.tsx");
    expect(strip).not.toContain("<Pressable");
    expect(strip).toContain("<PressScale");
  });
});

describe("the header's pill moves on the motion table", () => {
  test("no finger drives it, so it is timed (ease-in-out to morph, ease-out to enter and leave), never sprung", () => {
    const pill = src("features/chat/HeaderPill.tsx");
    expect(pill).not.toContain("withSpring");
    expect(pill).toContain("const WIDTH = { duration: 260, easing: motion.easeInOut };");
    expect(pill).toContain("const LINE_IN = { duration: 220, easing: motion.easeOut };");
    // The marquee is constant motion: linear.
    expect(pill).toContain("const ease = Easing.linear;");
  });
});
