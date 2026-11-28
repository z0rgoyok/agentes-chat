import { type SoundName, setSoundPlayer } from "@agenteschat/client/lib/sounds";
import { DEFAULT_SOUND_STYLE, isSoundStyle, renderSound, SOUNDS, type SoundStyle, wavBytes } from "@agenteschat/ui/sfx";
import { type AudioPlayer, createAudioPlayer } from "expo-audio";
import { File, Paths } from "expo-file-system";
import { useEffect, useSyncExternalStore } from "react";
import { appAudio } from "./audio-mode";
import { readValueSync, STORED, writeValue } from "./storage";
import { playSystemSound, systemSounds } from "./voice-session";

/**
 * The app's sounds on the phone (ADR 0070): synthesized by `@agenteschat/ui/sfx` into WAV files in the cache
 * (made once per style, again only if the system clears them), played low, mixed with the person's music and
 * silent in silent mode. The choice (a style, or off) belongs to this phone.
 */
export type SoundChoice = SoundStyle | "off";

/** Bump when the synth changes: new files instead of the old sounds. */
const VERSION = 1;
const VOLUME = 0.45;
const REPEAT_MS = 150;

const read = (): SoundChoice => {
  const saved = readValueSync(STORED.sounds);
  return saved === "off" || isSoundStyle(saved) ? saved : DEFAULT_SOUND_STYLE;
};
let choice: SoundChoice = read();
const listeners = new Set<() => void>();
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};
const current = () => choice;

export const useSoundChoice = () => useSyncExternalStore(subscribe, current, current);

/** Saves the choice and lets the person hear the new style. */
export function setSoundChoice(next: SoundChoice) {
  choice = next;
  void writeValue(STORED.sounds, next);
  for (const cb of listeners) cb();
  if (next !== "off") {
    play("mention");
    warm(next);
  }
}

const players = new Map<string, AudioPlayer>();
const lastPlayed = new Map<SoundName, number>();

/**
 * Played as the phone's voice takes the session to record (ADR 0100): on iOS as a system sound, which keeps to the
 * ringer switch where the session now plays in silent mode. Its file carries the volume the player would set.
 */
const AS_SYSTEM: ReadonlySet<SoundName> = new Set(["record"]);

function fileFor(style: SoundStyle, name: SoundName, system = false) {
  const file = new File(Paths.cache, `sound-${VERSION}-${style}-${name}${system ? "-system" : ""}.wav`);
  if (!file.exists) {
    const samples = renderSound(style, name);
    file.write(wavBytes(system ? samples.map((v) => v * VOLUME) : samples));
  }
  return file;
}

/** Files for the system sounds as well, on a phone that plays them so. */
const filesOf = (style: SoundStyle, name: SoundName) => {
  fileFor(style, name);
  if (systemSounds && AS_SYSTEM.has(name)) fileFor(style, name, true);
};

function playerFor(style: SoundStyle, name: SoundName) {
  const key = `${style}/${name}`;
  let player = players.get(key);
  if (!player) {
    player = createAudioPlayer({ uri: fileFor(style, name).uri });
    player.volume = VOLUME;
    players.set(key, player);
  }
  return player;
}

function play(name: SoundName) {
  if (choice === "off") return;
  const now = Date.now();
  if (now - (lastPlayed.get(name) ?? 0) < REPEAT_MS) return;
  lastPlayed.set(name, now);
  try {
    // On iOS, never through the voice's session: it rings in silent mode.
    if (systemSounds && AS_SYSTEM.has(name)) {
      playSystemSound(fileFor(choice, name, true).uri);
      return;
    }
    const player = playerFor(choice, name);
    // Back at the start before it plays, never both at once: `seekTo` lands later (it is async) and, landing after the
    // sound began, played its start a second time, heard as the sound twice. A player that never played is there.
    if (player.currentTime > 0) {
      const start = () => player.play();
      void player.seekTo(0).then(start, start);
    } else player.play();
  } catch {
    // No file or no audio: silence, never an error.
  }
}

/** The style's files made ahead, one per tick, so the first sound of each isn't late. */
function warm(style: SoundStyle) {
  let i = 0;
  const next = () => {
    const name = SOUNDS[i++];
    if (!name || choice !== style) return;
    try {
      filesOf(style, name);
    } catch {
      return;
    }
    setTimeout(next, 0);
  };
  setTimeout(next, 0);
}

/** In the signed-in app: the player for the shared code, the audio session, the files made after the start. */
export function useSounds() {
  useEffect(() => {
    void appAudio();
    setSoundPlayer(play);
    const timer = setTimeout(() => {
      if (choice !== "off") warm(choice);
    }, 3000);
    return () => {
      clearTimeout(timer);
      setSoundPlayer(null);
    };
  }, []);
}
