import { useLocalSearchParams } from "expo-router";
import { NewAgentScreen } from "@/features/agents/NewAgentScreen";

/**
 * "Criar agente", its first screen; each step after it is pushed as a screen of its own (`role`, `identity`,
 * `instructions`, `review` here). `?what=` (the examples of an empty Conversas) starts from scratch on who it is, with
 * that text; `?proposal=` (an agent's proposal card, ADR 0081) starts on Revisar with its draft; `?channel=` (a
 * channel's Adicionar sheet) starts the agent in that channel; `?account=` (Connect AI's "Criar um agente com este
 * plano") thinks with that plan account. Bringing agents from another app is `import`.
 */
export default function NewAgentRoute() {
  const { what, proposal, channel, account } = useLocalSearchParams<{
    what?: string;
    proposal?: string;
    channel?: string;
    account?: string;
  }>();
  return (
    <NewAgentScreen
      initialWhat={typeof what === "string" ? what.slice(0, 500) : ""}
      proposalId={typeof proposal === "string" && proposal ? proposal : null}
      channelId={typeof channel === "string" && channel ? channel : null}
      accountId={typeof account === "string" && account ? account : null}
    />
  );
}
