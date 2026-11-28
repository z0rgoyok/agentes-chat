import { type SoundName, setSoundPlayer } from "@agenteschat/client/lib/sounds";
import { DEFAULT_SOUND_STYLE, isSoundStyle, renderSound, SAMPLE_RATE, type SoundStyle } from "@agenteschat/ui/sfx";
import { STORAGE_KEYS, sessionStore, storage } from "./storage";

/**
 * The app's sounds on the web and in the desktop app (ADR 0070): synthesized once per sound, played through
 * Web Audio, low. The choice (a style, or off) belongs to this device, like the theme.
 */
export type SoundChoice = SoundStyle | "off";

const CHANGE_EVENT = "agentes:sounds";
/** A cue under the conversation, never over it. */
const VOLUME = 0.35;
/** The same sound twice this close is one (a burst of events). */
const REPEAT_MS = 150;

const read = (): SoundChoice => {
  const saved = storage.get(STORAGE_KEYS.sounds);
  return saved === "off" || isSoundStyle(saved) ? saved : DEFAULT_SOUND_STYLE;
};
let choice: SoundChoice = read();

export const soundChoice = () => choice;
export const onSoundChoiceChange = (cb: () => void) => {
  window.addEventListener(CHANGE_EVENT, cb);
  return () => window.removeEventListener(CHANGE_EVENT, cb);
};
/** Saves the choice and lets the person hear the new style. */
export function setSoundChoice(next: SoundChoice) {
  choice = next;
  storage.set(STORAGE_KEYS.sounds, next);
  window.dispatchEvent(new Event(CHANGE_EVENT));
  play("mention");
}

let ctx: AudioContext | null = null;
let out: GainNode | null = null;
const buffers = new Map<string, AudioBuffer>();
const lastPlayed = new Map<SoundName, number>();
/** A click or a key switched audio on once: from then on the app turns it on by itself to play. */
let unlocked = false;
/**
 * Audio goes off this long after the last sound ends. Running, a context holds the output device and plays silence
 * into it: on a Mac the device shows as playing for as long as the window is open, and its audio service keeps busy.
 */
const RELEASE_MS = 1500;
/** A sound that would start later than this after it was asked for doesn't play (late is worse than none). */
const LATE_MS = 1000;
let releaseTimer: ReturnType<typeof setTimeout> | undefined;
/** When the last sound started ends, on the context's clock (seconds). */
let playingUntil = 0;

/** Switches audio off once the sounds playing end and nothing new came for `RELEASE_MS`. */
function releaseLater(c: AudioContext) {
  clearTimeout(releaseTimer);
  const left = Math.max(0, playingUntil - c.currentTime) * 1000;
  releaseTimer = setTimeout(() => {
    releaseTimer = undefined;
    if (c.state === "running") c.suspend().catch(() => {});
  }, left + RELEASE_MS);
}

function audio(): AudioContext | null {
  if (ctx) return ctx;
  if (typeof AudioContext === "undefined") return null;
  ctx = new AudioContext();
  out = ctx.createGain();
  out.gain.value = VOLUME;
  out.connect(ctx.destination);
  return ctx;
}

function buffer(c: AudioContext, style: SoundStyle, name: SoundName) {
  const key = `${style}/${name}`;
  let b = buffers.get(key);
  if (!b) {
    const samples = renderSound(style, name);
    b = c.createBuffer(1, samples.length, SAMPLE_RATE);
    b.getChannelData(0).set(samples);
    buffers.set(key, b);
  }
  return b;
}

function play(name: SoundName) {
  if (choice === "off") return;
  const c = audio();
  // Before the first click or key the browser keeps audio off: nothing plays (late is worse than none).
  if (!c || !out || !unlocked) return;
  const now = performance.now();
  if (now - (lastPlayed.get(name) ?? -Infinity) < REPEAT_MS) return;
  lastPlayed.set(name, now);
  const sound = buffer(c, choice, name);
  const start = () => {
    if (!out || c.state !== "running" || performance.now() - now > LATE_MS) return;
    const source = c.createBufferSource();
    source.buffer = sound;
    source.connect(out);
    source.start();
    playingUntil = Math.max(playingUntil, c.currentTime + sound.duration);
    releaseLater(c);
  };
  // Switched off after the last sound (`releaseLater`): on again first, which takes a moment.
  if (c.state === "running") start();
  else c.resume().then(start, () => {});
}

/**
 * The tab that had the person last: with the app open in several tabs, only that one plays what arrives while
 * hidden (each tab gets the same events).
 */
const TAB_ID = sessionStore.get(STORAGE_KEYS.soundTab) ?? Math.random().toString(36).slice(2);
sessionStore.set(STORAGE_KEYS.soundTab, TAB_ID);
const markActive = () => {
  if (document.visibilityState === "visible") storage.set(STORAGE_KEYS.soundTab, TAB_ID);
};

/** Whether a notification's sound is this tab's to play, and with the window behind others (`background`). */
export function notificationAudience(): { mine: boolean; background: boolean } {
  const background = document.visibilityState !== "visible" || !document.hasFocus();
  return { mine: document.visibilityState === "visible" || storage.get(STORAGE_KEYS.soundTab) === TAB_ID, background };
}

/** Once at start: the player for the shared code, and audio switched on by the person's first gesture. */
export function installSounds() {
  setSoundPlayer(play);
  markActive();
  document.addEventListener("visibilitychange", markActive);
  window.addEventListener("focus", markActive);
  const unlock = () => {
    const c = audio();
    if (!c) return;
    c.resume()
      .then(() => {
        if (c.state !== "running") return;
        unlocked = true;
        window.removeEventListener("pointerdown", unlock, true);
        window.removeEventListener("keydown", unlock, true);
        // Nothing to play yet: off again until a sound comes.
        releaseLater(c);
      })
      .catch(() => {});
  };
  window.addEventListener("pointerdown", unlock, true);
  window.addEventListener("keydown", unlock, true);
}
