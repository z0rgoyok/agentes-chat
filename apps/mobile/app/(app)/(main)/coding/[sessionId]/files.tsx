import { useLocalSearchParams } from "expo-router";
import { FolderScreen } from "@/features/coding/FolderScreen";
import { isSafeId } from "@/features/shared/logic";
import { LandOn } from "@/ui/navigation";

/** A folder of a session's worktree (ADR 0215): `?dir=<path>`. */
export default function SessionFolderRoute() {
  const { sessionId, dir } = useLocalSearchParams<{ sessionId: string; dir?: string }>();
  if (!isSafeId(sessionId)) return <LandOn href="/coding" />;
  return <FolderScreen sessionId={sessionId} dir={typeof dir === "string" ? dir : ""} />;
}
