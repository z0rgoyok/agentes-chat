import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chatScreenSource } from "./chat-screen-source";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src", path), "utf8");

describe("a conversation's rows say each thing once", () => {
  test("in a DM the agent's role is in the bar under its name, not on every turn", () => {
    expect(src("features/chat/MessageRow.tsx")).toContain(
      "{!reminder && !routine && !talker && !helping && agent?.role && look.names && !bubbled && !compact ? (",
    );
    // `names` is off in a DM, whose bar says the agent's role under its name.
    expect(src("features/chat/look.ts")).toContain("names: !dm");
    expect(chatScreenSource()).toContain("dir.agentById.get(dmAgentId)?.role || undefined");
  });
});
