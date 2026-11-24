import { useLocalSearchParams } from "expo-router";
import { QuestionScreen } from "@/features/activity/QuestionScreen";

/** An agent's question, open from the inbox: answered on a screen of its own (`id`: its notification). */
export default function QuestionRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <QuestionScreen id={id} />;
}
