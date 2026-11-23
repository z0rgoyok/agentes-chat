import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SOUNDS } from "@agenteschat/ui/sfx";
import { chatScreenSource } from "./chat-screen-source";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src", path), "utf8");
const take = () => src("features/voice/useVoiceTake.ts");
const bar = () => src("features/voice/useVoiceComposer.tsx");

describe("the audio session goes back to the app's sounds after a voice", () => {
  test("the app's sounds: mixed with the music and silent in silent mode; a voice takes it, then gives it back", () => {
    const mode = src("lib/audio-mode.ts");
    expect(mode).toMatch(/allowsRecording: false,\s*playsInSilentMode: false,\s*interruptionMode: "mixWithOthers",/);
    expect(mode).toContain(
      'return setAudioModeAsync({ allowsRecording: recording, playsInSilentMode: true, interruptionMode: "doNotMix" });',
    );
    // A stopped voice gives it back a moment later, unless the next one (a row, the take) takes it first.
    expect(mode).toContain("export const VOICE_RELEASE_MS = 600;");
    expect(mode).toMatch(/export function voiceAudio\(recording: boolean\): Promise<void> \{\s*cancelRelease\(\);/);
    expect(src("lib/sounds.ts")).toContain("void appAudio();");
  });

  test("playback and the take use it: none leaves the session in silent-mode playback any more", () => {
    const playback = src("features/voice/playback.ts");
    expect(playback).toContain("await voiceAudio(false);");
    expect(playback).toMatch(/now = null;\s*starting = null;[\s\S]{0,200}releaseVoiceAudio\(\);/);
    const t = take();
    expect(t).not.toContain("setAudioModeAsync");
    expect(t).toMatch(/setPhase\("idle"\);\s*return appAudio\(\);/);
  });
});

describe("a take starts with its haptic and keeps the first words", () => {
  test("the recorder gets ready while the finger is down, and gives the session back if the hold never came", () => {
    const b = bar();
    expect(b).toMatch(
      /onBegin: \(\) => \{\s*"worklet";\s*activated\.value = false;[\s\S]{0,60}scheduleOnRN\(take\.warm\);/,
    );
    expect(b).toMatch(/onFinalize: \(\) => \{\s*"worklet";\s*if \(!activated\.value\) scheduleOnRN\(take\.cool\);/);
    const t = take();
    expect(t).toContain("warming.current = voiceAudio(true)");
    expect(t).toContain(".then(() => recorder.prepareToRecordAsync())");
    expect(t).toContain("await record(warmed ? await warmed : false);");
    // Known allowed, nothing is awaited before the haptic and the field.
    expect(t).toMatch(
      /if \(granted\.current !== true\) \{[\s\S]*?\}\s*\}\s*stopPlayback\(\);\s*haptics\.medium\(\);\s*setPhase\("hold"\);/,
    );
  });

  test("sending puts the field back at once, with a light haptic, and the take goes with the send sound", () => {
    const t = take();
    expect(t).toMatch(
      /if \(!short\) haptics\.light\(\);\s*stopTimer\(\);\s*setPhase\("sending"\);\s*await finishStretch\(\);/,
    );
    expect(t).toMatch(
      /const settled = reset\(\);\s*afterSend\(\);[\s\S]{0,200}void settled\.then\(\(\) => playSound\("send"\)\);/,
    );
    expect(bar()).toContain('active: phase !== "idle" && phase !== "sending",');
  });
});

describe("throwing a take away", () => {
  test("a medium haptic, the wave folding into the trash, the discard sound once the recorder stopped", () => {
    expect(SOUNDS).toContain("discard");
    const t = take();
    expect(t).toMatch(/if \(folds\) \{\s*haptics\.medium\(\);\s*setFoldFrom\(from\);\s*setPhase\("discarding"\);/);
    expect(t).toMatch(
      /await finishStretch\(\)\.catch\(\(\) => undefined\);[\s\S]{0,300}void appAudio\(\)\.then\(\(\) => playSound\("discard"\)\);/,
    );
    expect(t).toContain('if (from === "discarding" || from === "sending") return;');
    const b = bar();
    expect(b).toContain("folding && !reducedMotion ? FOLDED : OPEN");
    expect(b).toContain('foldOrigin: { transformOrigin: "left center" },');
    // On the way to the line the clock gives way to the trash, which stays once slid off.
    expect(b).toContain("opacity: 1 - Math.max(towardTrash(x.value), binned.value)");
    expect(b).toMatch(/if \(intent === "cancel"\) binned\.value = 1;/);
  });
});

describe("each touch answers", () => {
  test("lock is light (a drag that commits), pause light, listen a selection, the last seconds warn once", () => {
    const b = bar();
    expect(b).toMatch(/const lockNow = \(\) => \{\s*haptics\.light\(\);\s*take\.lock\(\);/);
    const t = take();
    expect(t).toContain("if (!quiet) haptics.light();");
    expect(t).toMatch(/if \(phaseRef\.current !== "paused"\) return;\s*haptics\.selection\(\);/);
    expect(t).toMatch(
      /if \(!warned\.current && secondsLeft\(ms\) !== null\) \{\s*warned\.current = true;\s*haptics\.warning\(\);/,
    );
    // A call or the background pauses with its own word, no second haptic.
    expect(t).toContain("void pause(true);");
  });

  test("too short: a warning haptic and the field shakes, with the line saying so", () => {
    const t = take();
    expect(t).toMatch(
      /haptics\.warning\(\);\s*setNope\(\(n\) => n \+ 1\);\s*toast\(\{ title: t\("voice\.tooShort"\), icon: "mic" \}\);/,
    );
    const composer = src("ui/Composer.tsx");
    expect(composer).toContain(
      "shake.set(withSequence(step(-6, 45), step(6, 70), step(-4, 60), step(3, 50), step(0, 45)));",
    );
    expect(composer).toContain("if (!count || reduced) return;");
    expect(composer).toContain("const shakeStyle = useShake(voice?.nope ?? 0, reducedMotion);");
  });

  test("the take's parts come and go with the app's own entrances, none with Reduce Motion", () => {
    const entrances = src("ui/entrances.ts");
    expect(entrances).toContain("}).duration(motion.base);");
    expect(entrances).toContain("export const FADE_OUT = FadeOut.duration(motion.fast);");
    // One rise for a row arriving and for the voice's line and bar.
    expect(chatScreenSource()).toContain("const ENTER = RISE_IN;");
    const composer = src("ui/Composer.tsx");
    expect(composer).toMatch(
      /entering=\{reducedMotion \? undefined : RISE_IN\}\s*exiting=\{reducedMotion \? undefined : FADE_OUT\}\s*style=\{\[styles\.bar,/,
    );
    const b = bar();
    expect(b).toContain("entering={reducedMotion ? undefined : FADE_IN}");
    expect(b).toContain("entering={reducedMotion ? undefined : CLICK_IN}");
  });
});
