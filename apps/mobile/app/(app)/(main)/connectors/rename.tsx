import { useLocalSearchParams } from "expo-router";
import { RenameConnectionScreen } from "@/features/connectors/ConnectionScreen";

/** Renomear a connection (`id`), pushed over its screen. */
export default function ConnectorRenameRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <RenameConnectionScreen id={id ?? ""} />;
}
