import { useLocalSearchParams } from "expo-router";
import { NewMissionScreen } from "@/features/chat/NewMissionScreen";
import { isSafeId } from "@/features/shared/logic";
import { LandOn } from "@/ui/navigation";

/**
 * "Nova missão" (`newMissionHref`), pushed over the conversation it starts from: `channelId`, the home `threadId`, the
 * `goal` so far, the `agentId` picked at first and the thread on screen (`current`). No channel: the home.
 */
export default function NewMissionRoute() {
  const { channelId, threadId, goal, agentId, current } = useLocalSearchParams<{
    channelId?: string;
    threadId?: string;
    goal?: string;
    agentId?: string;
    current?: string;
  }>();
  if (!isSafeId(channelId)) return <LandOn href="/" />;
  return (
    <NewMissionScreen
      channelId={channelId}
      threadId={isSafeId(threadId) ? threadId : null}
      goal={typeof goal === "string" ? goal : ""}
      agentId={isSafeId(agentId) ? agentId : null}
      currentThreadId={isSafeId(current) ? current : null}
    />
  );
}
