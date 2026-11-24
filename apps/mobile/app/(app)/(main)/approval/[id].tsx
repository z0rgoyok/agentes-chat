import { useLocalSearchParams } from "expo-router";
import { ApprovalSheet } from "@/features/approvals/ApprovalSheet";
import { goBack } from "@/features/shared/parts";

/**
 * A request to approve, on a screen of its own with the system's back (deep link `agenteschat://approval/<id>`): the
 * inbox, a card in a conversation and a push all open it here.
 */
export default function ApprovalRoute() {
  const { id, mode } = useLocalSearchParams<{ id: string; mode?: string }>();
  return <ApprovalSheet id={id} refuse={mode === "refuse"} onClose={goBack} />;
}
