import type { ArtifactFileContent, FileWave } from "@agenteschat/client";
import { MAX_PREVIEW_BYTES } from "@agenteschat/client/lib/files";
import { wavePeaks } from "@agenteschat/client/lib/voice";
import { VoicePlayer } from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { useApi } from "@/api/context";
import { useVoiceLabels } from "@/chat/ChatVoice";
import { useOrg } from "@/components/org-context";
import { setVoiceSpeed, useVoiceSpeed } from "@/lib/voice-speed";

/** Bars a file's wave keeps (a voice message's player draws up to 200). */
const FILE_PEAKS = 100;

/**
 * Decoded PCM is float32 per channel at the context's rate: a 25 MB mp3 (~26 min) at 48 kHz is ~600 MB. A 100-bar
 * loudness wave needs no more than the lowest rate Web Audio allows, and files are measured one at a time (a channel or
 * a Drive folder can show many unmeasured ones at once).
 */
const MEASURE_RATE = 3000;
let measuring: Promise<unknown> = Promise.resolve();

/**
 * An audio file in the voice-message player: its wave, play, the clock and the speed every voice message shares. Its
 * wave is the one kept with the file; the first app to play one with none measures it here and keeps it for everyone.
 * A sound this browser can't play gives its place back to `fallback` (the file's tile).
 */
export function FileAudio({
  artifactId,
  version,
  content,
  fallback,
  onFailed,
  className,
}: {
  artifactId: string;
  version: number;
  content: ArtifactFileContent;
  fallback: ReactNode;
  /** Heard when it can't play, for a caller that redraws around it. */
  onFailed?: () => void;
  className?: string;
}) {
  const { org } = useOrg();
  const api = useApi();
  const labels = useVoiceLabels();
  const speed = useVoiceSpeed();
  const wave = useFileWave(artifactId, version, content);
  const [failed, setFailed] = useState(false);
  if (failed) return <>{fallback}</>;
  return (
    <VoicePlayer
      key={`${artifactId}:${version}`}
      className={className}
      src={api.artifacts.fileUrl(org.id, artifactId, { version })}
      peaks={wave?.peaks ?? []}
      durationMs={wave?.durationMs ?? 0}
      speed={speed}
      onSpeed={setVoiceSpeed}
      onFailed={() => {
        setFailed(true);
        onFailed?.();
      }}
      labels={labels}
    />
  );
}

/** The file's kept wave, or, when it has none, the one measured from its bytes here (small enough to read whole). */
function useFileWave(artifactId: string, version: number, content: ArtifactFileContent): FileWave | null {
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const [measured, setMeasured] = useState<FileWave | null>(null);
  const kept = content.wave ?? null;
  const measurable = !kept && content.size <= MAX_PREVIEW_BYTES && typeof OfflineAudioContext !== "undefined";
  useEffect(() => {
    if (!measurable) return;
    let live = true;
    const run = measuring.then(async () => {
      if (!live) return;
      const bytes = await (await api.artifacts.fileBlob(org.id, artifactId, version)).arrayBuffer();
      const sound = await new OfflineAudioContext(1, 1, MEASURE_RATE).decodeAudioData(bytes);
      const wave = {
        peaks: wavePeaks(sound.getChannelData(0), FILE_PEAKS),
        durationMs: Math.round(sound.duration * 1000),
      };
      if (!live) return;
      setMeasured(wave);
      const keptWave = await api.artifacts.setWave(org.id, artifactId, version, wave);
      qc.setQueriesData<{ shownVersion?: number; content?: { kind: string } }>(
        { queryKey: ["org", org.id, "artifacts", "one", artifactId] },
        (old) =>
          old?.shownVersion === version && old.content?.kind === "file"
            ? { ...old, content: { ...old.content, wave: keptWave } }
            : old,
      );
    });
    // A sound this browser can't read whole still plays: its wave stays flat, its length comes from the player.
    measuring = run.catch(() => {});
    return () => {
      live = false;
    };
  }, [measurable, api, org.id, artifactId, version, qc]);
  return kept ?? measured;
}
