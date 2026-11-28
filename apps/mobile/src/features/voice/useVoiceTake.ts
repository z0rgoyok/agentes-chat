import { type ArtifactRef, newClientId } from "@agenteschat/client";
import { can } from "@agenteschat/client/lib/permissions";
import { playSound } from "@agenteschat/client/lib/sounds";
import { VOICE_MAX_MS, VOICE_MIN_MS } from "@agenteschat/client/lib/voice";
import { Skia } from "@shopify/react-native-skia";
import { useQueryClient } from "@tanstack/react-query";
import {
  getRecordingPermissionsAsync,
  type RecordingOptions,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  useAudioRecorder,
} from "expo-audio";
import { File, Paths } from "expo-file-system";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AccessibilityInfo, Alert, AppState, Linking } from "react-native";
import { useSharedValue } from "react-native-reanimated";
import { appAudio, voiceAudio } from "@/lib/audio-mode";
import { paysHere } from "@/lib/store";
import { allowFeedbackWhileRecording } from "@/lib/voice-session";
import { useOrgMaybe } from "@/providers/org";
import { haptics, useToast } from "@/ui";
import { levelOf, peaksOf, START_SOUND_MS, secondsLeft, takeBack } from "./logic";
import { joinM4a } from "./m4a";
import { flushVoice, queueVoice, type VoiceRefusal, type VoiceSend } from "./outbox";
import { playingId, seekPlayback, startPlayback, stopPlayback } from "./playback";
import { emptyWave, type WavePaths, wavePaths } from "./VoiceBars";

/** Small files of speech: one channel, enough for a voice. Levels on, for the wave. */
const RECORDING: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  sampleRate: 22_050,
  numberOfChannels: 1,
  bitRate: 48_000,
  isMeteringEnabled: true,
};
const TICK_MS = 50;
const REVIEW_ID = "voice-take";
/** How much of the wave's height is drawn while recording. */
export const LIVE_WAVE = 24;
const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/**
 * `hold`: the finger is down. `locked`: hands free. `paused`: stopped, can listen, go on, send or delete. `sending`: it
 * went, the field is back while the recorder closes behind it. `discarding`: thrown away, its wave folding (`FOLD_MS`).
 */
export type VoicePhase = "idle" | "hold" | "locked" | "paused" | "sending" | "discarding";
/** Where a take was when it was thrown away: what shows its wave folding (the field held, or the take's bar). */
export type VoiceFoldFrom = "hold" | "locked" | "paused";
/** How long a thrown-away take's wave folds before the field is plain again. */
export const FOLD_MS = 200;

interface Stretch {
  uri: string;
  ms: number;
}

export interface VoiceTarget {
  orgId: string;
  channelId: string;
  threadId: string | null;
  /** The message this take answers (`meta.replyTo`). */
  replyTo?: string | null;
  authorId: string;
  /** Whether this person may record now (`/voice/allowed`); null while unknown. */
  allowed: boolean | null;
  /** Not allowed because the workspace has no plan in force (`reason: "plan"`). */
  needsPlan?: boolean;
  /**
   * Asked as the hold starts, before anything records: true when the app showed something instead (the first take
   * where voice doesn't become text yet, `VoiceSetupSheet`), and the next hold records.
   */
  ask?: () => boolean;
  afterSend: () => void;
  /**
   * Right before a take goes: what goes with it, the text typed beside it and the files waiting above the field, once
   * they are uploaded. Null when they can't go now: the take stays, paused, and nothing is sent.
   */
  prepare?: (text: string) => Promise<{ text: string; artifacts: ArtifactRef[] } | null>;
  /** While it records, held or hands free, never paused: the others see "gravando áudio…" (call it throttled). */
  onRecording?: () => void;
  /** The server refused a take sent from this conversation: the text typed beside it and its files, for the composer. */
  takeBack?: (back: { text: string; artifacts: ArtifactRef[] }) => void;
}

const removeFile = (uri: string) => {
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {}
};

/** Tells the sender why a recording can't go: the plan says where it is chosen, in words only (App Store 3.1.1). */
export function useSayVoiceRefusal() {
  const { t } = useTranslation();
  const toast = useToast();
  const mayPay = paysHere(can(useOrgMaybe()?.org ?? null, "manage_billing"));
  return useCallback(
    (reason: VoiceRefusal) =>
      toast(
        reason === "plan"
          ? {
              title: t("voice.plan"),
              subtitle: t(mayPay ? "connectAi.billingWeb" : "standing.billing.askAdmin"),
              icon: "x",
            }
          : { title: t(reason === "limit" ? "voice.limit" : "voice.notSent"), icon: "x" },
      ),
    [mayPay, t, toast],
  );
}

/**
 * One recording, from the press to the send. A wave and a clock tick twenty times a second on a timer: the wave goes
 * straight to Skia through a shared value, and only a new second renders.
 *
 * Pausing stops the recorder, because a file can only be played once it is finished: that is what lets a paused
 * recording be heard. Going on starts a new stretch, and `joinM4a` makes them one file. A stretch that can't be
 * joined still goes, as a message of its own: nothing said is lost.
 */
export function useVoiceTake(target: VoiceTarget) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const qc = useQueryClient();
  const sayRefusal = useSayVoiceRefusal();
  const recorder = useAudioRecorder(RECORDING);
  const [phase, setPhaseState] = useState<VoicePhase>("idle");
  const [seconds, setSeconds] = useState(0);
  const [listening, setListening] = useState(false);
  /** Whole seconds of everything recorded, for the "0:05 / 0:12" of a paused take. */
  const [total, setTotal] = useState(0);
  const [foldFrom, setFoldFrom] = useState<VoiceFoldFrom>("hold");
  /** Goes up each time a take was too short: the field shakes (`Composer`). */
  const [nope, setNope] = useState(0);
  const inner = useSharedValue(Skia.Path.Make());
  const edge = useSharedValue(Skia.Path.Make());
  const progress = useSharedValue(1);

  const phaseRef = useRef<VoicePhase>("idle");
  const levels = useRef<number[]>([]);
  const stretches = useRef<Stretch[]>([]);
  /** What the finished stretches add up to. */
  const doneMs = useRef(0);
  const liveMs = useRef(0);
  const width = useRef(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  /** The finger left before the recorder started. */
  const starting = useRef(false);
  const released = useRef(false);
  /** A pause or a send is stopping the recorder (or uploading what goes with it): a second tap meanwhile would keep
   * the same stretch twice. */
  const ending = useRef(false);
  const targetRef = useRef(target);
  targetRef.current = target;
  /** The microphone's permission as last read: known granted, the hold starts with no wait on the system. */
  const granted = useRef<boolean | null>(null);
  /** The recorder getting ready while the finger is down (`warm`): true once it is ready to record at once. */
  const warming = useRef<Promise<boolean> | null>(null);
  /** The last seconds' haptic was given for this take. */
  const warned = useRef(false);

  const setPhase = useCallback((next: VoicePhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);
  const setWave = useCallback(
    (wave: WavePaths) => {
      inner.value = wave.inner;
      edge.value = wave.edge;
    },
    [inner, edge],
  );
  /** The whole take over the width it has now (a paused take's field is laid out differently from a live one's). */
  const wholeWave = useCallback(
    () => setWave(wavePaths(peaksOf(levels.current, 96), width.current, LIVE_WAVE)),
    [setWave],
  );

  const refused = useCallback(
    (reason: VoiceRefusal, item?: VoiceSend) => {
      haptics.warning();
      sayRefusal(reason);
      const back = item ? takeBack(item, targetRef.current) : null;
      if (back) targetRef.current.takeBack?.(back);
    },
    [sayRefusal],
  );

  const stopTimer = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  }, []);

  /** Ends the stretch in progress, if any, and keeps its file. */
  const finishStretch = useCallback(async () => {
    stopTimer();
    if (!recorder.getStatus().isRecording && liveMs.current === 0) return;
    const ms = liveMs.current;
    await recorder.stop();
    if (recorder.uri && ms > 0) stretches.current.push({ uri: recorder.uri, ms });
    doneMs.current += ms;
    liveMs.current = 0;
  }, [recorder, stopTimer]);

  /** Back to nothing recorded; the app's own sounds get the audio session back (what plays after waits for it). */
  const reset = useCallback(() => {
    stopTimer();
    warned.current = false;
    warming.current = null;
    levels.current = [];
    stretches.current = [];
    doneMs.current = 0;
    liveMs.current = 0;
    released.current = false;
    setWave(emptyWave());
    progress.value = 1;
    setSeconds(0);
    setTotal(0);
    setListening(false);
    setPhase("idle");
    return appAudio();
  }, [setWave, progress, setPhase, stopTimer]);

  /** One file from every stretch; what can't be joined stays as a file of its own. */
  const joined = useCallback(async () => {
    const out: Stretch[] = [];
    for (const stretch of stretches.current) {
      const last = out[out.length - 1];
      if (!last) {
        out.push({ ...stretch });
        continue;
      }
      try {
        const bytes = joinM4a(await new File(last.uri).bytes(), await new File(stretch.uri).bytes());
        const file = new File(Paths.cache, `voice-${newClientId()}.m4a`);
        file.write(bytes);
        removeFile(last.uri);
        removeFile(stretch.uri);
        last.uri = file.uri;
        last.ms += stretch.ms;
      } catch {
        out.push({ ...stretch });
      }
    }
    stretches.current = out;
    return out;
  }, []);

  /** The finished stretches as one take that can be heard. */
  const held = useCallback(async () => {
    setPhase("paused");
    await joined();
    wholeWave();
    progress.value = 0;
    const whole = Math.floor(doneMs.current / 1000);
    setSeconds(whole);
    setTotal(whole);
  }, [joined, wholeWave, progress, setPhase]);

  /**
   * Stops the recording, kept, to listen to or go on. The bar turns at once with its haptic (`quiet`: the app paused it,
   * a call or the background, with its own word); its numbers come with the closed file.
   */
  const pause = useCallback(
    async (quiet = false) => {
      const now = phaseRef.current;
      if (now !== "hold" && now !== "locked") return;
      if (ending.current) return;
      ending.current = true;
      if (!quiet) haptics.light();
      stopTimer();
      const whole = Math.floor((doneMs.current + liveMs.current) / 1000);
      setSeconds(whole);
      setTotal(whole);
      setPhase("paused");
      try {
        await finishStretch();
      } finally {
        ending.current = false;
      }
      await held();
    },
    [finishStretch, held, setPhase, stopTimer],
  );

  /** Whether it went; when it didn't, the caller keeps what was typed. */
  const sendTake = useCallback(
    async (typed: string): Promise<boolean> => {
      const { orgId, channelId, threadId, replyTo = null, authorId, afterSend, prepare } = targetRef.current;
      stopPlayback();
      // The field comes back as the finger lifts (or the send is tapped), with its haptic; the recorder closes behind it.
      const short = doneMs.current + liveMs.current < VOICE_MIN_MS;
      if (!short) haptics.light();
      stopTimer();
      setPhase("sending");
      await finishStretch();
      const total = doneMs.current;
      if (total < VOICE_MIN_MS) {
        for (const s of stretches.current) removeFile(s.uri);
        haptics.warning();
        setNope((n) => n + 1);
        toast({ title: t("voice.tooShort"), icon: "mic" });
        void reset();
        return false;
      }
      const extra = await (prepare ? prepare(typed) : Promise.resolve({ text: typed, artifacts: [] }));
      if (!extra) {
        await held();
        return false;
      }
      const files = await joined();
      const all = levels.current;
      let from = 0;
      for (const file of files) {
        const to = from + Math.round((file.ms / total) * all.length);
        queueVoice(
          qc,
          file.uri,
          {
            clientId: newClientId(),
            orgId,
            channelId,
            threadId,
            replyTo,
            authorId,
            durationMs: Math.round(file.ms),
            peaks: peaksOf(all.slice(from, to)),
            language: i18n.language?.slice(0, 2) ?? null,
            // A take that could not be joined goes in pieces: what goes with it, with the first.
            ...(file === files[0] && extra.text ? { text: extra.text } : {}),
            ...(file === files[0] && extra.artifacts.length > 0 ? { artifacts: extra.artifacts } : {}),
          },
          refused,
        );
        from = to;
      }
      const settled = reset();
      afterSend();
      // The same sound as a message of words, once the app's sounds have the session back (silent in silent mode).
      void settled.then(() => playSound("send"));
      return true;
    },
    [finishStretch, held, i18n.language, joined, qc, refused, reset, setPhase, stopTimer, t, toast],
  );
  const send = useCallback(
    async (typed = ""): Promise<boolean> => {
      if (ending.current) return false;
      ending.current = true;
      try {
        return await sendTake(typed);
      } finally {
        ending.current = false;
      }
    },
    [sendTake],
  );

  /**
   * Throws the take away. Asked by the person (`notice`), it is what they did, never an error: a medium haptic as the
   * line is crossed or the trash tapped, the wave folding where it is (`discarding`, `FOLD_MS`), the discard sound once
   * the recorder stopped (it would be recorded, and ring in silent mode, before), and a screen reader hears it; no
   * toast over the conversation.
   */
  const cancel = useCallback(
    async (notice = true) => {
      const from = phaseRef.current;
      // Already going (thrown away or sent): a second tap on the trash meanwhile does nothing.
      if (from === "discarding" || from === "sending") return;
      stopPlayback();
      released.current = true;
      const folds = notice && (from === "hold" || from === "locked" || from === "paused");
      if (folds) {
        haptics.medium();
        setFoldFrom(from);
        setPhase("discarding");
      }
      const folded = folds ? new Promise((done) => setTimeout(done, FOLD_MS)) : Promise.resolve();
      stopTimer();
      await finishStretch().catch(() => undefined);
      for (const s of stretches.current) removeFile(s.uri);
      if (notice) {
        AccessibilityInfo.announceForAccessibility(t("voice.deleted"));
        void appAudio().then(() => playSound("discard"));
      }
      await folded;
      void reset();
    },
    [finishStretch, reset, setPhase, stopTimer, t],
  );

  const tick = useCallback(() => {
    const status = recorder.getStatus();
    const phaseNow = phaseRef.current;
    // A call or Siri took the microphone: what was said is kept, paused, also from under a finger.
    if (!status.isRecording && status.durationMillis > 0 && (phaseNow === "hold" || phaseNow === "locked")) {
      haptics.warning();
      void pause(true);
      return;
    }
    if (phaseNow === "hold" || phaseNow === "locked") targetRef.current.onRecording?.();
    liveMs.current = status.durationMillis;
    const ms = doneMs.current + liveMs.current;
    levels.current.push(levelOf(status.metering));
    if (width.current > 0) setWave(wavePaths(levels.current, width.current, LIVE_WAVE, true));
    const whole = Math.floor(ms / 1000);
    setSeconds((s) => (s === whole ? s : whole));
    // Once, as the clock turns red for the last seconds.
    if (!warned.current && secondsLeft(ms) !== null) {
      warned.current = true;
      haptics.warning();
    }
    if (ms < VOICE_MAX_MS) return;
    if (phaseNow === "hold") void send();
    else void pause();
  }, [pause, setWave, recorder, send]);

  /** Records from now: `ready` when the recorder got ready while the finger was down (`warm`). */
  const record = useCallback(
    async (ready = false) => {
      if (!ready) {
        await voiceAudio(true);
        await recorder.prepareToRecordAsync();
      }
      // Again after the recorder set the session up itself: the take's haptics reach the hand.
      allowFeedbackWhileRecording();
      recorder.record();
      progress.value = 1;
      timer.current = setInterval(tick, TICK_MS);
    },
    [progress, recorder, tick],
  );

  /**
   * The finger landed on the microphone: during the hold the audio session and the recorder get ready, so the take
   * starts with its haptic and the first words are kept (they took about 0.3 s once the hold was reached). Not while a
   * voice plays (the hold stops it first) or when the microphone isn't known to be allowed.
   */
  const warm = useCallback(() => {
    if (phaseRef.current !== "idle" || starting.current || warming.current) return;
    if (granted.current !== true || targetRef.current.allowed === false || playingId() !== null) return;
    warming.current = voiceAudio(true)
      .then(() => recorder.prepareToRecordAsync())
      .then(
        () => true,
        () => false,
      );
  }, [recorder]);

  /** The finger lifted before the hold: nothing was recorded, and the app's sounds get the session back. */
  const cool = useCallback(() => {
    const was = warming.current;
    if (!was || phaseRef.current !== "idle" || starting.current) return;
    warming.current = null;
    void was.then(() => {
      if (phaseRef.current === "idle" && !starting.current && !warming.current) void appAudio();
    });
  }, []);

  /** The hold reached its time. A first use only asks: the next hold records. */
  const start = useCallback(async () => {
    if (phaseRef.current !== "idle" || starting.current) return;
    if (targetRef.current.ask?.()) return;
    if (targetRef.current.allowed === false) {
      haptics.warning();
      sayRefusal(targetRef.current.needsPlan ? "plan" : "limit");
      return;
    }
    starting.current = true;
    released.current = false;
    const warmed = warming.current;
    warming.current = null;
    try {
      // Known allowed: the haptic and the field land with the hold, no wait on the system.
      if (granted.current !== true) {
        const known = await getRecordingPermissionsAsync();
        granted.current = known.granted;
        if (!known.granted) {
          const asked = known.canAskAgain ? await requestRecordingPermissionsAsync() : known;
          granted.current = asked.granted;
          if (!asked.granted && !asked.canAskAgain) {
            Alert.alert(t("voice.micBlocked"), t("voice.micBlockedHint"), [
              { text: t("voice.notNow"), style: "cancel" },
              { text: t("voice.openSettings"), onPress: () => void Linking.openSettings() },
            ]);
          }
          void appAudio();
          return;
        }
      }
      stopPlayback();
      haptics.medium();
      playSound("record");
      setPhase("hold");
      // The recorder starts once the sound has rung (ready by then: it got ready while the finger was down).
      const [ready] = await Promise.all([warmed ?? false, wait(START_SOUND_MS)]);
      await record(ready);
      // Deleted while the recorder was starting (`cancel` found nothing to stop yet): it stops here, not never.
      if (phaseRef.current === "idle") return void (await cancel(false));
      if (released.current) await send();
    } catch {
      toast({ title: t("voice.notSent"), icon: "x" });
      void reset();
    } finally {
      starting.current = false;
    }
  }, [cancel, record, reset, sayRefusal, send, setPhase, t, toast]);

  /** The finger came up: a hold sends; a lock already took over. */
  const release = useCallback(() => {
    if (starting.current) {
      released.current = true;
      return;
    }
    if (phaseRef.current === "hold") void send();
  }, [send]);

  /** Hands free. The haptic is the gesture's, on the frame the finger crosses the line, so none here. */
  const lock = useCallback(() => {
    if (phaseRef.current !== "hold") return;
    setPhase("locked");
  }, [setPhase]);

  const resume = useCallback(async () => {
    if (phaseRef.current !== "paused") return;
    stopPlayback();
    setListening(false);
    setWave(wavePaths(levels.current, width.current, LIVE_WAVE, true));
    setPhase("locked");
    await record().catch(() => setPhase("paused"));
  }, [setWave, record, setPhase]);

  const listen = useCallback(async () => {
    if (phaseRef.current !== "paused") return;
    haptics.selection();
    if (playingId() === REVIEW_ID) {
      stopPlayback();
      setListening(false);
      return;
    }
    const file = stretches.current[stretches.current.length - 1];
    if (!file) return;
    setListening(true);
    await startPlayback({
      id: REVIEW_ID,
      source: { uri: file.uri },
      durationMs: file.ms,
      from: progress.value < 0.999 ? progress.value : 0,
      speed: 1,
      onProgress: (at) => {
        progress.value = at;
        setSeconds(Math.floor((at * file.ms) / 1000));
      },
      onEnd: () => {
        progress.value = 0;
        setListening(false);
        setSeconds(Math.floor(doneMs.current / 1000));
      },
      onError: () => {
        setListening(false);
        toast({ title: t("voice.noPlayback"), icon: "x" });
      },
    });
  }, [progress, t, toast]);

  const scrub = useCallback(
    (at: number) => {
      const file = stretches.current[stretches.current.length - 1];
      progress.value = at;
      if (file) setSeconds(Math.floor((at * file.ms) / 1000));
      seekPlayback(REVIEW_ID, at);
    },
    [progress],
  );

  /** The wave's width now; a paused take is redrawn to fit it (its field has other things around the wave). */
  const setWidth = useCallback(
    (w: number) => {
      if (width.current === w) return;
      width.current = w;
      if (phaseRef.current === "paused" && w > 0) wholeWave();
    },
    [wholeWave],
  );

  // Sent to the background mid-recording: the recording waits, paused.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "background") void pause(true);
    });
    return () => sub.remove();
  }, [pause]);

  // Leaving the conversation: a recording nobody finished is kept nowhere.
  useEffect(
    () => () => {
      stopTimer();
      if (phaseRef.current !== "idle" || warming.current) {
        void recorder.stop().catch(() => undefined);
        for (const s of stretches.current) removeFile(s.uri);
        void appAudio();
      }
    },
    [recorder, stopTimer],
  );

  // The permission read ahead, so a hold that is allowed starts with no wait on the system.
  useEffect(() => {
    void getRecordingPermissionsAsync()
      .then((known) => {
        granted.current = known.granted;
      })
      .catch(() => undefined);
  }, []);

  return {
    phase,
    foldFrom,
    nope,
    seconds,
    total,
    listening,
    inner,
    edge,
    progress,
    start,
    warm,
    cool,
    release,
    lock,
    pause,
    resume,
    send,
    cancel,
    listen,
    scrub,
    setWidth,
    flush: () => flushVoice(qc, refused),
  };
}
