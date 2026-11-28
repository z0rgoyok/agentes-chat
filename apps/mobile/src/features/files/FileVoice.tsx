import type { FileWave } from "@agenteschat/client";
import { type ReactNode, useState } from "react";
import { useOrgId } from "../shared/hooks";
import { VoiceClip } from "../voice/VoiceMessage";
import { useRemoteFile } from "./source";

/**
 * An audio file in the voice-message player: the wave kept with the file (flat until an app measured it), play, the
 * clock and the speed every voice shares. A sound this phone can't play gives its place back to `fallback`.
 */
export function FileVoice({
  id,
  version,
  wave,
  fallback,
}: {
  id: string;
  /** Absent: its latest. */
  version?: number;
  wave?: FileWave;
  fallback: ReactNode;
}) {
  const orgId = useOrgId();
  const link = useRemoteFile(orgId, id, version);
  const [failed, setFailed] = useState(false);
  if (failed || link.isError) return <>{fallback}</>;
  const clip = `file:${id}:${version ?? "latest"}`;
  return (
    <VoiceClip
      clipId={clip}
      rowKey={clip}
      source={() => link.data ?? { uri: "" }}
      // Its link still on its way: the button waits, dimmed.
      sending={!link.data}
      peaks={wave?.peaks ?? NO_PEAKS}
      durationMs={wave?.durationMs ?? 0}
      onFailed={() => setFailed(true)}
    />
  );
}

const NO_PEAKS: number[] = [];
