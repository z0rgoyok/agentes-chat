import { useLocalSearchParams } from "expo-router";
import { LayoutScreen } from "@/features/live-files/slides/LayoutScreen";
import { isSafeId } from "@/features/shared/logic";
import { LandOn } from "@/ui/navigation";

/**
 * The layouts of a live presentation (`/slide-layout/<id>`, ADR 0196 §9): for a new slide at a place (`at`) or for a
 * slide's new look (`slide`); none: the Drive.
 */
export default function SlideLayoutRoute() {
  const { id, at, slide } = useLocalSearchParams<{ id: string; at?: string; slide?: string }>();
  if (!isSafeId(id)) return <LandOn href="/drive" />;
  const place = at !== undefined && /^\d{1,4}$/.test(at) ? Number(at) : null;
  return <LayoutScreen key={id} id={id} at={place} slide={isSafeId(slide) ? slide : null} />;
}
