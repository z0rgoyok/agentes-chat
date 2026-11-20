import { useLocalSearchParams } from "expo-router";
import { SlideTextScreen } from "@/features/live-files/slides/SlideTextScreen";
import { isSafeId } from "@/features/shared/logic";
import { LandOn } from "@/ui/navigation";

/**
 * A text box's words in a live file (`/slide-text/<id>`, ADR 0196 §9): a slide's (`slide` and `el`) or a canvas's note,
 * text or shape (`shape`); none: the Drive.
 */
export default function SlideTextRoute() {
  const { id, slide, el, shape } = useLocalSearchParams<{ id: string; slide?: string; el?: string; shape?: string }>();
  if (!isSafeId(id)) return <LandOn href="/drive" />;
  return (
    <SlideTextScreen
      key={id}
      id={id}
      slide={isSafeId(slide) ? slide : undefined}
      el={isSafeId(el) ? el : undefined}
      shape={isSafeId(shape) ? shape : undefined}
    />
  );
}
