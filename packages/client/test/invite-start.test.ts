import { describe, expect, test } from "bun:test";
import type { Agent } from "../src/api/types";
import { inviteAgentCase, invitePickable, inviteStart } from "../src/lib/invite-start";

const none = { channelIds: [], agentIds: [] };
const roles = [
  { id: "suporte", channelIds: ["c-suporte", "c-chamados"], agentIds: ["a-max"] },
  { id: "financeiro", channelIds: ["c-contas"], agentIds: ["a-fin", "a-max"] },
  { id: "vazio" },
];

describe("what an invitation starts someone with (ADR 0184)", () => {
  test("the picked cargos bring their channels and agents, then the ones added, less the ones taken out", () => {
    expect(inviteStart(roles, [], none, none)).toEqual(none);
    expect(inviteStart(roles, ["suporte"], none, none)).toEqual({
      channelIds: ["c-suporte", "c-chamados"],
      agentIds: ["a-max"],
    });
    // Two cargos: each once, in the cargos' order; one with no reach read adds nothing.
    expect(inviteStart(roles, ["suporte", "financeiro", "vazio"], none, none)).toEqual({
      channelIds: ["c-suporte", "c-chamados", "c-contas"],
      agentIds: ["a-max", "a-fin"],
    });
    // Taken out stays out, even when another cargo brings it again; added by hand comes after.
    const removed = { channelIds: ["c-chamados"], agentIds: ["a-max"] };
    const added = { channelIds: ["c-geral-2"], agentIds: ["a-ada"] };
    expect(inviteStart(roles, ["suporte", "financeiro"], added, removed)).toEqual({
      channelIds: ["c-suporte", "c-contas", "c-geral-2"],
      agentIds: ["a-fin", "a-ada"],
    });
  });

  test("each agent's case, as the server decides it", () => {
    const agent = (extra: Partial<Agent>) => ({ id: "a-fin", ownerUserId: "u-bruno", ...extra }) as Agent;
    const people = (extra: Partial<Agent> = {}) =>
      agent({ audienceMode: "people", audience: { mode: "people", userIds: [], roleIds: [] }, ...extra });
    const lia = { userId: "u-lia", managesAgents: false };
    const admin = { userId: "u-ana", managesAgents: true };
    expect(inviteAgentCase(agent({ audienceMode: "everyone" }), lia, [])).toBe("everyone");
    expect(inviteAgentCase(people(), lia, ["a-fin"])).toBe("cargo");
    expect(inviteAgentCase(people(), lia, [])).toBe("locked");
    expect(inviteAgentCase(people({ ownerUserId: "u-lia" }), lia, [])).toBe("opens");
    expect(inviteAgentCase(people(), admin, [])).toBe("opens");
    expect(inviteAgentCase(people(), admin, [], ["Bruno"])).toBe("mailbox");
    // On its owner's plan, answering nobody else: only its owner's own switch lets anyone in.
    const plan = { kind: "claude_code", account: "Claude Max" } as Agent["brain"];
    const kept = agent({ audienceMode: "owner", audience: { mode: "owner", userIds: [], roleIds: [] }, brain: plan });
    expect(inviteAgentCase(kept, { userId: "u-bruno", managesAgents: false }, [])).toBe("plan");
    // On a plan that already answers some people, it opens like any other.
    expect(
      inviteAgentCase(
        people({ brain: plan, audience: { mode: "people", userIds: ["u-rui"], roleIds: [] } }),
        admin,
        [],
      ),
    ).toBe("opens");
    expect(
      ["everyone", "cargo", "opens", "locked", "plan", "mailbox"].filter((c) => invitePickable(c as never)),
    ).toEqual(["everyone", "cargo", "opens"]);
  });
});
