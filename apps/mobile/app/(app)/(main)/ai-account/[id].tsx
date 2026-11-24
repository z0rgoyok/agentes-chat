import { useLocalSearchParams } from "expo-router";
import { AiAccountScreen } from "@/features/ai/AiHubScreens";

/** An AI account's detail (limits, permissions, its ⋯), from its row on Contas de IA. */
export default function AiAccountRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <AiAccountScreen accountId={id ?? ""} />;
}
