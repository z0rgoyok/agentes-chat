import { voiceSpeedOf } from "@agenteschat/client/lib/voice";
import { useSyncExternalStore } from "react";
import { STORAGE_KEYS, storage } from "./storage";

const CHANGE_EVENT = "agentes:voice-speed";
const kept = () => voiceSpeedOf(storage.get(STORAGE_KEYS.voiceSpeed));

/**
 * The speed voice messages play at, picked on any of them, for all of them, kept in this browser. Held in memory
 * first, so a pick still counts for as long as the page is open when storage can't keep it.
 */
let current = kept();

export const voiceSpeed = () => current;

export function setVoiceSpeed(speed: number) {
  current = speed;
  storage.set(STORAGE_KEYS.voiceSpeed, String(speed));
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

const onVoiceSpeedChange = (cb: () => void) => {
  // A pick in another tab of this browser, or its storage cleared there.
  const fromOtherTab = (event: StorageEvent) => {
    if (event.key !== null && event.key !== STORAGE_KEYS.voiceSpeed) return;
    current = kept();
    cb();
  };
  window.addEventListener(CHANGE_EVENT, cb);
  window.addEventListener("storage", fromOtherTab);
  return () => {
    window.removeEventListener(CHANGE_EVENT, cb);
    window.removeEventListener("storage", fromOtherTab);
  };
};

export const useVoiceSpeed = () => useSyncExternalStore(onVoiceSpeedChange, voiceSpeed, voiceSpeed);
