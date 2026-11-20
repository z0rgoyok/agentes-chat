import { useLocalSearchParams } from "expo-router";
import { DocumentViewer } from "@/features/files/DocumentViewer";
import { isSafeId } from "@/features/shared/logic";

/**
 * A file from a message, the Drive or a link, pushed with its native bar: `/file/<id>?v=<version>`. A live file goes on
 * to its own screen, with `m` (a message of its conversation to open at, ADR 0199).
 */
export default function FileRoute() {
  const { id, v, m } = useLocalSearchParams<{ id: string; v?: string; m?: string }>();
  const version = v ? Number(v) : Number.NaN;
  return (
    <DocumentViewer
      id={id}
      {...(Number.isInteger(version) && version > 0 ? { version } : {})}
      focusId={isSafeId(m) ? m : null}
    />
  );
}
