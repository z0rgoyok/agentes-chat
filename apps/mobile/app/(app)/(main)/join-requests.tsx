import { useLocalSearchParams } from "expo-router";
import { JoinRequestsScreen } from "@/features/members/JoinRequestsScreen";

/**
 * Requests to join through the invitation link, pushed with the system's bar over whatever opened it (deep link
 * `agenteschat://join-requests`; `request`: the one tapped on Convites, on top). A screen, not a sheet: each card's
 * Cargo, Canais and Agentes push their choice over it.
 */
export default function JoinRequestsRoute() {
  const { request } = useLocalSearchParams<{ request?: string }>();
  return <JoinRequestsScreen focus={request} />;
}
