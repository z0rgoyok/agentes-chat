import { useLocalSearchParams } from "expo-router";
import { PeopleScreen } from "@/features/coding/PeopleScreen";
import { isSafeId } from "@/features/shared/logic";
import { LandOn } from "@/ui/navigation";

/** Who is in a session (ADR 0215), pushed from its "…". */
export default function SessionPeopleRoute() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  if (!isSafeId(sessionId)) return <LandOn href="/coding" />;
  return <PeopleScreen sessionId={sessionId} />;
}
