import { useLocalSearchParams } from "expo-router";
import { TeamTemplateScreen } from "@/features/right-hand/TeamTemplates";

/** One team template (`?id=`), pushed over the templates' list: its team and "Create the team". */
export default function TeamTemplateRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <TeamTemplateScreen key={id} id={id ?? ""} />;
}
