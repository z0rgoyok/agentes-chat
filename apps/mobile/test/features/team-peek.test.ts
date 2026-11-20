import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PEEK_AT, PEEK_RISE, PEEK_SIZE } from "../../src/features/chat/peek";
import { TEAM_PEEK_MAX, TEAM_PEEK_STEP, teamFacePose, teamPeekers, teamRow } from "../../src/features/chats/team-peek";

const src = (file: string) => readFileSync(join(import.meta.dir, "../../src", file), "utf8");

const dm = (id: string, type = "agent") => ({ kind: "dm", with: { type, id } });
const channel = { kind: "channel" };

describe("who peeks at the end of Conversas", () => {
  test("the right hand first, then the agents of the latest conversations, each once", () => {
    const rows = [dm("ada"), channel, dm("ana", "person"), dm("bia"), dm("ada"), dm("cris")];
    expect(teamPeekers("rh", rows, new Set())).toEqual(["rh", "ada", "bia", "cris"]);
  });

  test("never a hidden agent, at most five, nobody without agents", () => {
    const rows = ["a", "b", "c", "d", "e", "f", "g"].map((id) => dm(id));
    expect(teamPeekers(null, rows, new Set(["b"]))).toEqual(["a", "c", "d", "e", "f"]);
    expect(teamPeekers(null, rows, new Set())).toHaveLength(TEAM_PEEK_MAX);
    expect(teamPeekers(null, [channel, dm("ana", "person")], new Set())).toEqual([]);
  });
});

describe("the row", () => {
  test("the first face in the middle, the next ones out from it, the left side first", () => {
    expect(teamRow(["rh", "a", "b", "c", "d"])).toEqual([
      { id: "c", rank: 2 },
      { id: "a", rank: 1 },
      { id: "rh", rank: 0 },
      { id: "b", rank: 1 },
      { id: "d", rank: 2 },
    ]);
    expect(teamRow(["rh", "a", "b", "c"]).map((f) => f.id)).toEqual(["b", "rh", "a", "c"]);
    expect(teamRow(["rh"])).toEqual([{ id: "rh", rank: 0 }]);
    expect(teamRow([])).toEqual([]);
  });
});

describe("where each face stands", () => {
  const down = PEEK_SIZE;
  const up = PEEK_SIZE - PEEK_RISE;

  test("out of sight at rest; the middle starts first, each step out later", () => {
    expect(teamFacePose(0, 0, 2, false)).toEqual({ y: down, opacity: 0 });
    expect(teamFacePose(TEAM_PEEK_STEP, 0, 2, false).y).toBeLessThan(down);
    expect(teamFacePose(TEAM_PEEK_STEP, 1, 2, false).y).toBe(down);
  });

  test("the outermost arrives exactly as the pull reaches the tap's line, whatever the row's size", () => {
    for (const last of [0, 1, 2]) {
      expect(teamFacePose(PEEK_AT, last, last, false).y).toBe(up);
      expect(teamFacePose(PEEK_AT - 1, last, last, false).y).toBeGreaterThan(up);
    }
    // Past the line it stays up.
    expect(teamFacePose(PEEK_AT + 40, 2, 2, false)).toEqual({ y: up, opacity: 1 });
  });

  test("reduced motion: none moves, each only fades in where it arrives", () => {
    expect(teamFacePose(0, 0, 2, true)).toEqual({ y: up, opacity: 0 });
    expect(teamFacePose(PEEK_AT, 2, 2, true)).toEqual({ y: up, opacity: 1 });
  });
});

describe("the wiring", () => {
  const home = src("features/chats/ChatsScreen.tsx");
  const peek = src("features/chats/TeamPeek.tsx");
  const math = src("features/chats/team-peek.ts");

  test("iOS only, never under the work-along accessory, and no archived link left at the list's end", () => {
    expect(home).toContain('const PEEK = Platform.OS === "ios";');
    expect(home).toContain("PEEK && !(ACCESSORY && along) && !list.loading && !failed");
    expect(home).toContain("pastEnd: (scroll) => <TeamPeek scroll={scroll} agents={peekers} />");
    expect(home).not.toContain("archivedCount");
  });

  test("the conversation's pull and tap, transform and opacity only, still faces taking no touch", () => {
    expect(peek).toContain("const pull = usePullPastEnd(scroll, row.length > 0);");
    expect(peek).toContain("const next = armedAfter(was, now);");
    expect(peek).toContain("if (next) scheduleOnRN(tap);");
    expect(peek).not.toMatch(/withSpring|withTiming|entering=|layout=|useState/);
    expect(peek).toContain("return { opacity: pose.opacity, transform: [{ translateY: pose.y }] };");
    expect(peek).toContain('<AgentFace agentId={agentId} size={PEEK_SIZE} live={false} framed={false} gaze="up" />');
    expect(peek).toContain('pointerEvents="none"');
    expect(peek).toContain('overflow: "hidden",');
    // The tab bar's top is where a tab's bottom safe area ends: nothing added for the bar, or they float above it.
    expect(peek).toContain("bottom: safe.bottom + (foot?.height ?? 0)");
    expect(math.match(/"worklet";/g)?.length).toBe(1);
  });

  test("the screen hands its list's scroll view over, drawn fixed under the bar's band", () => {
    const screen = src("ui/LargeTitleScreen.tsx");
    expect(screen).toContain("{pastEnd?.(scroll.ref)}");
    expect(screen.indexOf("{pastEnd?.(scroll.ref)}")).toBeLessThan(screen.indexOf("<CoverBarBackdrop y={y}"));
    expect(src("ui/LargeTitleHead.tsx")).toContain("const ref = useAnimatedRef<Animated.ScrollView>();");
  });
});
