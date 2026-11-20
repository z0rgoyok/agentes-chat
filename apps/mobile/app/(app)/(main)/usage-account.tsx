import { useLocalSearchParams } from "expo-router";
import { UsageAccountScreen } from "@/features/usage/UsageAccountScreen";

/** A plan account of Uso (`?key=`, its row's), pushed from its row: its windows, its agents, who uses it. */
export default function UsageAccountRoute() {
  const { key } = useLocalSearchParams<{ key: string }>();
  return <UsageAccountScreen accountKey={key ?? ""} />;
}
