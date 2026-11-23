import { useLocalSearchParams } from "expo-router";
import { SpreadsheetScreen } from "@/features/live-files/spreadsheet/SpreadsheetScreen";
import { isSafeId } from "@/features/shared/logic";
import { LandOn } from "@/ui/navigation";

/**
 * A live spreadsheet (`/spreadsheet/<id>`, ADR 0196): from the Drive, a message's card, a link or New; none: the Drive.
 * `m`: a message of its conversation to open at (ADR 0199).
 */
export default function SpreadsheetRoute() {
  const { id, m } = useLocalSearchParams<{ id: string; m?: string }>();
  if (!isSafeId(id)) return <LandOn href="/drive" />;
  return <SpreadsheetScreen key={id} id={id} focusId={isSafeId(m) ? m : null} />;
}
