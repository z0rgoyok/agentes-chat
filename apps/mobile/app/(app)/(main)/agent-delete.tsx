import { useLocalSearchParams } from "expo-router";
import { DeleteAgentScreen } from "@/features/agents/DeleteAgentScreen";

/** "Delete agent" (`?id=`), pushed over "Edit agent". */
export default function AgentDeleteRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <DeleteAgentScreen key={id} id={id} />;
}
