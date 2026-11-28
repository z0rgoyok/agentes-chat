import { recordAudit } from "../audit";
import { getMembership } from "../organizations";
import { personBehindCall } from "../requester";
import type { ToolDefinition, ToolSource } from "../tools/types";
import { AGENT_CO_AUTHOR_EMAIL, agentCoAuthorOn, setAgentCoAuthor } from "./signature";

export const COMMIT_CO_AUTHOR_TOOL = "commit_co_author";

const STATE = {
  on: `On: every agent here ends its commits with its own line (Co-Authored-By: <its name> <${AGENT_CO_AUTHOR_EMAIL}>).`,
  off: "Off: agents here end their commits with no line of their own.",
};

/**
 * `commit_co_author` (ADR 0156): the line every agent of the workspace ends its commits with, turned off or on again
 * when a person asks any agent, or its `status`. Reversible and harmless, so it asks nobody at any approvals level,
 * but a person must be behind the run (a routine's run changes nothing). Each change is audited: who asked, which
 * agent, when.
 */
export function createCoAuthorToolSource(): ToolSource {
  const tool: ToolDefinition = {
    name: COMMIT_CO_AUTHOR_TOOL,
    description: `The line every agent here ends its commits with (Co-Authored-By: <its name> <${AGENT_CO_AUTHOR_EMAIL}>), next to the coding CLI's own and the credit for the person who asked; on by default. When a person asks to stop or bring back the agents' co-author line on commits ('tira o Co-Authored-By dos commits'), turn it off or on for the whole workspace at once; status says which it is. Then confirm in one short line.`,
    scope: "",
    inputSchema: {
      type: "object",
      properties: { action: { type: "string", enum: ["on", "off", "status"] } },
      required: ["action"],
      additionalProperties: false,
    },
    describe: (input) => ({
      title:
        input.action === "status"
          ? "See the agents' line on commits"
          : `Turn ${input.action === "off" ? "off" : "on"} the agents' line on commits`,
    }),
    async execute(input, ctx) {
      const { action } = input;
      if (action !== "on" && action !== "off" && action !== "status") {
        return { content: "action must be on, off or status.", isError: true };
      }
      const now = await agentCoAuthorOn(ctx.db, ctx.orgId);
      if (action === "status") return { content: now ? STATE.on : STATE.off, data: { on: now } };
      const person = await personBehindCall(ctx);
      if (!person || !(await getMembership(ctx.db, person, ctx.orgId))) {
        return {
          content: "Only a person here can ask for this, and nobody is behind this run: nothing changed.",
          isError: true,
        };
      }
      const on = action === "on";
      if (on !== now) {
        await setAgentCoAuthor(ctx.db, ctx.orgId, on);
        await recordAudit(ctx.db, {
          orgId: ctx.orgId,
          actor: { type: "agent", id: ctx.agentId },
          action: "organization.agent_co_author_changed",
          target: { type: "organization", id: ctx.orgId },
          details: { on },
          runId: ctx.runId || null,
          channelId: ctx.channelId || null,
          onBehalfOfUserId: person,
        });
      }
      return {
        content: `${on === now ? "It already was." : "Done for every agent here, from its next turn."} ${on ? STATE.on : STATE.off}`,
        data: { on },
      };
    },
  };
  return { name: "co-author", tools: async () => [tool] };
}
