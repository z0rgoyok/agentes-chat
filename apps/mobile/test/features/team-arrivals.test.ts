import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { arrivalKeys, teamArrivals } from "../../src/features/right-hand/team-arrivals";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src", path), "utf8");

afterEach(() => teamArrivals.reset());

describe("a team made from Lodi's card, on the phone", () => {
  test("its conversations are keyed as Conversas keys them, channels first", () => {
    expect(arrivalKeys({ channelIds: ["c1"], agentIds: ["a1", "a2"] })).toEqual(["c:c1", "a:a1", "a:a2"]);
    expect(arrivalKeys(null)).toEqual([]);
  });

  test("its faces fly once, and Conversas brings its rows in once", () => {
    teamArrivals.add(["c:c1", "a:a1"], [{ key: "iara", name: "Iara", appearance: null }]);
    expect(teamArrivals.flight()?.faces.map((f) => f.name)).toEqual(["Iara"]);
    teamArrivals.landed();
    expect(teamArrivals.flight()).toBeNull();
    expect([...teamArrivals.takeFresh()]).toEqual(["c:c1", "a:a1"]);
    expect(teamArrivals.takeFresh().size).toBe(0);
  });

  test("nothing made, nothing flies", () => {
    teamArrivals.add([], [{ key: "iara", name: "Iara", appearance: null }]);
    expect(teamArrivals.flight()).toBeNull();
  });

  test("the card feeds it on create, the conversation draws the flight, Conversas takes the rows when it shows", () => {
    expect(src("features/right-hand/TeamCard.tsx")).toContain("teamArrivals.add(");
    expect(src("features/chat/ChatScreen.tsx")).toContain("<TeamFlight barHeight={headerHeight} />");
    expect(src("features/chats/ChatsScreen.tsx")).toContain("teamArrivals.takeFresh()");
    // No flight with reduced motion.
    expect(src("features/right-hand/TeamFlight.tsx")).toContain("if (!flight || reduced) return null;");
  });
});
