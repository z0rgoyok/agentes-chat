import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { useLocalSearchParams } from "expo-router";
import { ConversationListScreen } from "@/features/chats/ConversationListScreen";
import { isListKind } from "@/features/chats/logic";
import { ThreadsScreen } from "@/features/chats/ThreadsScreen";
import { useOrg } from "@/providers/org";
import { LandOn } from "@/ui/navigation";

/**
 * Recentes' "See all" from Conversas (`recent`): every conversation by latest activity. Threads and missions are a tab;
 * a personal workspace has no Threads tab (ADR 0159), so its row in You › Work pushes them here. Any other kind (an
 * older link to a list the home no longer has) lands back on its tab (never a second copy of the tabs).
 */
export default function ConversationListRoute() {
  const { kind } = useLocalSearchParams<{ kind: string }>();
  const personal = isPersonal(useOrg().org);
  if (isListKind(kind)) return <ConversationListScreen />;
  if (kind === "threads" && personal) return <ThreadsScreen pushed />;
  return <LandOn href={kind === "threads" ? "/threads" : "/"} />;
}
