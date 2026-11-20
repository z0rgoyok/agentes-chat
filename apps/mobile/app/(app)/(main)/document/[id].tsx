import { useLocalSearchParams } from "expo-router";
import { DocumentScreen } from "@/features/live-files/document/DocumentScreen";
import { isSafeId } from "@/features/shared/logic";
import { LandOn } from "@/ui/navigation";

/**
 * A live document (`/document/<id>`, ADR 0200): from the Drive, a message's card, a link or New; none: the Drive. `m`: a
 * message of its conversation to open at (ADR 0199).
 */
export default function DocumentRoute() {
  const { id, m } = useLocalSearchParams<{ id: string; m?: string }>();
  if (!isSafeId(id)) return <LandOn href="/drive" />;
  return <DocumentScreen key={id} id={id} focusId={isSafeId(m) ? m : null} />;
}
