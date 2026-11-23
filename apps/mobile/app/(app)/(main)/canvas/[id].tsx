import { useLocalSearchParams } from "expo-router";
import { CanvasScreen } from "@/features/live-files/canvas/CanvasScreen";
import { isSafeId } from "@/features/shared/logic";
import { LandOn } from "@/ui/navigation";

/**
 * A live canvas (`/canvas/<id>`, ADR 0196): from the Drive, a message's card, a link or New; none: the Drive. `m`: a
 * message of its conversation to open at (ADR 0199).
 */
export default function CanvasRoute() {
  const { id, m } = useLocalSearchParams<{ id: string; m?: string }>();
  if (!isSafeId(id)) return <LandOn href="/drive" />;
  return <CanvasScreen key={id} id={id} focusId={isSafeId(m) ? m : null} />;
}
