import { voiceSpeedOf } from "@agenteschat/client/lib/voice";
import { readValueSync, STORED, writeValue } from "@/lib/storage";

/** The speed voice messages play at, picked on any of them, for all of them, kept on this phone. */
let speed = voiceSpeedOf(readValueSync(STORED.voiceSpeed));
const listeners = new Set<() => void>();

export const voiceSpeed = () => speed;

export const subscribeVoiceSpeed = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

export function setVoiceSpeed(next: number) {
  speed = next;
  void writeValue(STORED.voiceSpeed, String(next));
  for (const cb of listeners) cb();
}
