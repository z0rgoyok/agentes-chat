import { useLocalSearchParams } from "expo-router";
import { SessionCodeScreen } from "@/features/coding/SessionCodeScreen";
import { isSafeId } from "@/features/shared/logic";
import { LandOn } from "@/ui/navigation";

/** A session's Git and Files (ADR 0215), pushed from its conversation's bar. */
export default function SessionCodeRoute() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  if (!isSafeId(sessionId)) return <LandOn href="/coding" />;
  return <SessionCodeScreen sessionId={sessionId} />;
}
