import { setAudioModeAsync } from "expo-audio";
import { allowFeedbackWhileRecording } from "./voice-session";

/**
 * The app's audio session, one owner at a time (ADR 0070, ADR 0100). By default it is the app's own sounds: mixed with
 * the person's music and silent in silent mode. A voice playing or recording takes it over (heard in silent mode, the
 * music paused) and gives it back once it ends; it was never given back, so after one voice message every sound of
 * the app rang in silent mode and stopped the music.
 */

/** A stopped voice gives the session back after this, unless another voice starts meanwhile (the next row, the take). */
export const VOICE_RELEASE_MS = 600;

let release: ReturnType<typeof setTimeout> | null = null;
const cancelRelease = () => {
  if (release) clearTimeout(release);
  release = null;
};

/** The app's own sounds own the session: mixed with the music, silent in silent mode. */
export function appAudio(): Promise<void> {
  cancelRelease();
  return setAudioModeAsync({
    allowsRecording: false,
    playsInSilentMode: false,
    interruptionMode: "mixWithOthers",
    shouldPlayInBackground: false,
  }).catch(() => undefined);
}

/**
 * A voice plays (`recording` false) or records: heard in silent mode, alone. Recording, the take's haptics still reach
 * the hand: iOS mutes them while the session records unless told otherwise, and the audio library never does.
 */
export function voiceAudio(recording: boolean): Promise<void> {
  cancelRelease();
  return setAudioModeAsync({ allowsRecording: recording, playsInSilentMode: true, interruptionMode: "doNotMix" }).then(
    () => {
      if (recording) allowFeedbackWhileRecording();
    },
  );
}

/** A voice stopped: the app's sounds get the session back in a moment, unless another voice takes it first. */
export function releaseVoiceAudio() {
  cancelRelease();
  release = setTimeout(() => {
    release = null;
    void appAudio();
  }, VOICE_RELEASE_MS);
}
