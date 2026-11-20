import { useLocalSearchParams } from "expo-router";
import { ShowScreen } from "@/features/live-files/slides/ShowScreen";
import { isSafeId } from "@/features/shared/logic";
import { LandOn } from "@/ui/navigation";

/**
 * Presenting a live presentation (`/slides-show/<id>`, ADR 0196 §9): from a slide (`at`), or following whoever presents
 * (`follow`: their client id); none: the Drive.
 */
export default function SlidesShowRoute() {
  const { id, at, follow } = useLocalSearchParams<{ id: string; at?: string; follow?: string }>();
  if (!isSafeId(id)) return <LandOn href="/drive" />;
  const following = follow !== undefined && /^\d{1,10}$/.test(follow) ? Number(follow) : null;
  return <ShowScreen key={id} id={id} at={isSafeId(at) ? at : null} follow={following} />;
}
