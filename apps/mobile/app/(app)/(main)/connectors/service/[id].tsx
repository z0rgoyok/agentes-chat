import { useLocalSearchParams } from "expo-router";
import { ServicePage } from "@/features/connectors/ServicePage";

/**
 * A catalog service's own page (`/connectors/service/<id>`), pushed from its row in Conectores, a category or a search;
 * `personal=1` from Pessoal (presentation set in `_layout`: a clear bar over its sky).
 */
export default function ConnectorServiceRoute() {
  const { id, personal } = useLocalSearchParams<{ id: string; personal?: string }>();
  return <ServicePage id={id ?? ""} personal={personal === "1"} />;
}
