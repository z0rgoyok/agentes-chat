import { useLocalSearchParams } from "expo-router";
import { FileScreen } from "@/features/coding/FileScreen";
import { isSafeId } from "@/features/shared/logic";
import { LandOn } from "@/ui/navigation";

/** A file of a session's worktree, read-only (ADR 0215): `?path=<path>`. */
export default function SessionFileRoute() {
  const { sessionId, path } = useLocalSearchParams<{ sessionId: string; path?: string }>();
  if (!isSafeId(sessionId) || typeof path !== "string" || path === "") return <LandOn href="/coding" />;
  return <FileScreen sessionId={sessionId} path={path} />;
}
