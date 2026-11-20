import { useLocalSearchParams } from "expo-router";
import { HereScreen } from "@/features/live-files/here/HereScreen";
import { isSafeId } from "@/features/shared/logic";
import { LandOn } from "@/ui/navigation";

/** Who is in a live file now (`/here/<id>`, ADR 0196 §5), pushed from the faces in its bar; none: the Drive. */
export default function HereRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  if (!isSafeId(id)) return <LandOn href="/drive" />;
  return <HereScreen key={id} id={id} />;
}
