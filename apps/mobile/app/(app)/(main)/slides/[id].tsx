import { useLocalSearchParams } from "expo-router";
import { SlidesScreen } from "@/features/live-files/slides/SlidesScreen";
import { isSafeId } from "@/features/shared/logic";
import { LandOn } from "@/ui/navigation";

/**
 * A live presentation (`/slides/<id>`, ADR 0196): its slides; with `slide`, that slide opened large (its own push, so
 * the system's back returns to the list). From the Drive, a message's card, a link or New; none: the Drive. `m`: a
 * message of its conversation to open at (ADR 0199).
 */
export default function SlidesRoute() {
  const { id, slide, m } = useLocalSearchParams<{ id: string; slide?: string; m?: string }>();
  if (!isSafeId(id)) return <LandOn href="/drive" />;
  const open = isSafeId(slide) ? slide : null;
  return <SlidesScreen key={`${id}:${open ?? ""}`} id={id} slide={open} focusId={isSafeId(m) ? m : null} />;
}
