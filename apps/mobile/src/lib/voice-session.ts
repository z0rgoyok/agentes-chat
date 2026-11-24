import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

/**
 * What a voice take needs from iOS's audio session (ADR 0100), through modules/voice-session. Android mutes
 * nothing while it records and has no ringer switch for the app's sounds, so there it is nothing.
 */
interface VoiceSessionNative {
  allowFeedbackWhileRecording(): void;
  playSystemSound(uri: string): boolean;
}

const native = Platform.OS === "ios" ? requireOptionalNativeModule<VoiceSessionNative>("VoiceSession") : null;

/** Haptics and system sounds keep playing while the session records (iOS mutes them by default). */
export function allowFeedbackWhileRecording() {
  try {
    native?.allowFeedbackWhileRecording();
  } catch {
    // Without it the take is the same, only without its haptics.
  }
}

/** A short sound as a system sound: it keeps to the ringer switch while a voice holds the session. False if it can't. */
export function playSystemSound(uri: string): boolean {
  try {
    return native?.playSystemSound(uri) ?? false;
  } catch {
    return false;
  }
}

/** Whether this phone plays the take's sounds as system sounds (iOS, on a build with the module). */
export const systemSounds = native !== null;
