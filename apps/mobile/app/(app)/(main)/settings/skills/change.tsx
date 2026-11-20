import { useLocalSearchParams } from "expo-router";
import { SkillChangeScreen } from "@/features/settings/SkillsScreen";

/** What an agent changed in the skill (`id`, the change `change`), pushed over its page. */
export default function SettingsSkillChangeRoute() {
  const { id, change } = useLocalSearchParams<{ id: string; change: string }>();
  return <SkillChangeScreen id={id ?? ""} changeId={change ?? ""} />;
}
