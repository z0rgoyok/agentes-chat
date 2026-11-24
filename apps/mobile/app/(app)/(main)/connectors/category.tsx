import { useLocalSearchParams } from "expo-router";
import { ConnectorCategoryScreen } from "@/features/connectors/ConnectorsScreen";

/** A category's every service (`c`), pushed from its shelf's "Ver todos" in Conectores; `personal=1` on Pessoal. */
export default function ConnectorCategoryRoute() {
  const { c, personal } = useLocalSearchParams<{ c?: string; personal?: string }>();
  return <ConnectorCategoryScreen category={c ?? ""} personal={personal === "1"} />;
}
