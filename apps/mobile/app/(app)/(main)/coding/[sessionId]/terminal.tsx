import { useLocalSearchParams } from "expo-router";
import { TerminalScreen } from "@/features/coding/TerminalScreen";
import { isSafeId } from "@/features/shared/logic";
import { LandOn } from "@/ui/navigation";

/** A session's terminal (ADR 0215), pushed from its code screen and its "…". */
export default function SessionTerminalRoute() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  if (!isSafeId(sessionId)) return <LandOn href="/coding" />;
  return <TerminalScreen sessionId={sessionId} />;
}
