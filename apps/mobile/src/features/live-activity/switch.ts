import { useSyncExternalStore } from "react";
import { readValueSync, STORED, writeValue } from "@/lib/storage";

/**
 * The agents' Live Activity's switch (Você › Notificações, ADR 0210): on by default, kept on this phone. Its own module,
 * with nothing native in it: the settings screen reads it on every platform.
 */
let off = readValueSync(STORED.liveActivityOff) === "1";
const listeners = new Set<() => void>();
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};
const isOn = () => !off;

/** Whether the agents' Live Activity is on on this phone. */
export const useLiveActivityOn = () => useSyncExternalStore(subscribe, isOn, isOn);

export function setLiveActivityOn(on: boolean) {
  off = !on;
  void writeValue(STORED.liveActivityOff, on ? "0" : "1");
  for (const cb of listeners) cb();
}
