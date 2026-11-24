import { useLocalSearchParams } from "expo-router";
import { ImageViewer } from "@/features/files/ImageViewer";
import { isSafeId } from "@/features/shared/logic";

/**
 * A message's pictures, full screen over the conversation (presentation set in `_layout`):
 * `/images?files=<id>@<version>,…&at=<index>`, with `from` when a stack of pictures opened it, and `m` for a message
 * of the picture's conversation to open at (pushed over the viewer, ADR 0208).
 */
export default function ImagesRoute() {
  const { files, at, from, m } = useLocalSearchParams<{ files?: string; at?: string; from?: string; m?: string }>();
  return <ImageViewer files={files} at={at} from={from} focusId={isSafeId(m) ? m : null} />;
}
