import { dragsFiles, transferFiles } from "@agenteschat/ui";
import { type DragEvent, useState } from "react";

/** Only computer files count. Nested elements enter/leave separately while the pointer stays over the surface. */
export function useFileDrop(onFiles: (files: File[]) => void, enabled: boolean) {
  const [depth, setDepth] = useState(0);
  // A portal can bubble through React while its DOM is outside this drop surface.
  const hasFiles = (e: DragEvent) =>
    e.target instanceof Node && e.currentTarget.contains(e.target) && dragsFiles(e.dataTransfer);
  const props = enabled
    ? {
        onDragEnter: (e: DragEvent) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          setDepth((d) => d + 1);
        },
        onDragOver: (e: DragEvent) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
        },
        onDragLeave: (e: DragEvent) => {
          if (!hasFiles(e)) return;
          setDepth((d) => Math.max(0, d - 1));
        },
        onDrop: (e: DragEvent) => {
          if (!hasFiles(e)) return;
          setDepth(0);
          // A nested target (the text composer, for example) may have taken this drop already.
          if (e.defaultPrevented) return;
          e.preventDefault();
          const files = transferFiles(e.dataTransfer);
          if (files.length > 0) onFiles(files);
        },
      }
    : {};
  return { over: enabled && depth > 0, props };
}
