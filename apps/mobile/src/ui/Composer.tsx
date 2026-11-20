import { joinDrafts, tooLongText, tooLongToSend } from "@agenteschat/client/lib/message-length";
import { applyFormat, FORMAT_KINDS, type FormatKind } from "@agenteschat/ui/format";
import { Canvas, Group, Path, Skia, vec } from "@shopify/react-native-skia";
import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import {
  Platform,
  Pressable,
  Text as RNText,
  ScrollView,
  StyleSheet,
  TextInput,
  type TextInputInstance,
  type TextStyle,
  View,
} from "react-native";
import {
  GestureDetector,
  useExclusiveGestures,
  useLongPressGesture,
  useTapGesture,
} from "react-native-gesture-handler";
import Animated, {
  cancelAnimation,
  Easing,
  type EntryExitAnimationFunction,
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withDelay,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { PixelStop } from "@/agent/PixelMarks";
import { readValueSync, STORED, writeValueSync } from "@/lib/storage";
import { FADE_OUT, RISE_IN } from "./entrances";
import { haptics } from "./haptics";
import { Icon } from "./Icon";
import { PRESS_IN, PRESS_OUT, PressScale } from "./PressScale";
import { systemText } from "./Text";
import { useToast } from "./Toast";
import { useTheme } from "./theme";
import { CHROME_MAX_SCALE, weights } from "./type-scale";

/** The "@" (or, with `sigil: "#"`, the channel) being typed right before the caret. */
export interface ComposerToken {
  start: number;
  query: string;
  sigil?: "#";
}

export interface ComposerMentionState {
  /** What follows "@" ("th"), or "#" when `sigil` says so. */
  query: string;
  sigil?: "#";
  /** Replaces "@th" with "@handle " and puts the caret after it. */
  pick: (handle: string) => void;
}

/**
 * How a message goes while an agent works: "join" reaches it at its next pause (a tap on send), "now"
 * makes it stop what it is doing and read the message at once (the send button held). Without an agent at work it is "join".
 */
export type SendHow = "join" | "now";

/**
 * An agent at work in the conversation: with text, the choice shows (to anyone who writes there); the empty
 * field's button stops it, only for who may stop it (`stop` is left out otherwise).
 */
export interface ComposerWorking {
  stop?: {
    /** The stop button's label ("Parar o Theo"). */
    label: string;
    onStop: () => void;
  };
}

export interface ComposerProps {
  placeholder: string;
  onSend: (text: string, how: SendHow) => void;
  /** Someone is working here (null otherwise). */
  working?: ComposerWorking | null;
  /** The "+" for attachments and actions; left out where there are none (the agent's computer). */
  onPlus?: () => void;
  /**
   * Where the "@"/"#" picker and the formatting bar are drawn when the screen puts them outside the box it measures
   * (`createComposerFloat`, drawn by `ComposerFloat`): they come and go with the keys typed and the words selected, and
   * inside a box whose height insets a list they moved the list (and the field under the finger) each time. Without it
   * they sit at the top of the composer.
   */
  float?: ComposerFloatSlot;
  /** The field's `nativeID` (the chat links it to the keyboard's drag-to-dismiss area). */
  inputNativeID?: string;
  /** While "@…" is typed right before the caret (and the field is focused): the card above the field. */
  mention?: (state: ComposerMentionState) => ReactNode;
  /** The "@" (or "#") token at the caret (`mentionQuery`); the composer doesn't know the rules itself. */
  mentionAt?: (text: string, caret: number) => ComposerToken | null;
  /** The text after a pick (`insertMention`). */
  insertMention?: (text: string, token: ComposerToken, handle: string) => { text: string; caret: number };
  /**
   * Text handed in from another screen ("Falar com o Theo" leaves "@theo " here): put in the field when it is
   * empty, and the field focused. Once per request (`at`). With `join` (a refused message coming back to be
   * changed) it goes in before whatever is being typed, so neither text is lost.
   */
  prefill?: { text: string; at: number; join?: boolean } | null;
  /** A change here brings the keyboard up ("Responder" on a message). */
  focusAt?: number;
  /** Right above the field ("Respondendo a Ana"). */
  banner?: ReactNode;
  /**
   * What waits to go with the message (photos, videos, files): inside the field on a row of its own across it, over the
   * words and the send button, as the phone's own messages hold them; the send button stays beside the words.
   */
  attachments?: ReactNode;
  /** Something waits above the field to go with the message (photos, files): send shows and sends with no words. */
  sendEmpty?: boolean;
  /**
   * The words are past the length limit (said above the field, the send held): this takes them as a text file
   * instead ("Enviar como arquivo"), and the field empties. Absent where no more files fit: the words say it.
   */
  onLongAsFile?: (text: string) => void;
  /** Each change that leaves text in the field ("está digitando…" for the others; the screen throttles it). */
  onType?: (text: string) => void;
  /**
   * Where the words wait when the person leaves before sending (a conversation, a thread): they are back in the field
   * when the person returns, until sent or erased. Kept while the app runs.
   */
  draftKey?: string;
  /** The button in the empty field that opens the GIFs and stickers (null where neither can be sent). */
  media?: { label: string; onPress: () => void } | null;
  /**
   * Voice messages (null where they are off): `mic` in a field with no words (files may wait); while the mic is held,
   * `overlay` covers the field. Hands free or paused, `bar` is the take's row above the field, in the field's own
   * capsule (same height, radius, ring and inset), the field and the "+" stay usable, and the field's send hands the
   * words to `send`, which sends them with the take (and the files) as one message. `above` sits over the row (the
   * slide-to-cancel hint, the recording line).
   */
  voice?: {
    mic: ReactNode | null;
    overlay: ReactNode | null;
    bar: ReactNode | null;
    send: ((text: string) => Promise<boolean>) | null;
    above: ReactNode | null;
    active: boolean;
    /** Goes up each time a take was too short: the field shakes, as a refused entry does. */
    nope?: number;
  } | null;
}

/** The pill's height, the "+" and the send button's. */
const FIELD = 48;
const SEND = 36;
/**
 * Space around the send button inside the pill: it sits centered on the first line. It is also the slop that takes a
 * 36 button to the field's 48 under the finger, up to the pill's own edges.
 */
const INSET = (FIELD - SEND) / 2;
/**
 * The field's ring (the system's separator, so the capsule's edge reads on any ground) and its soft shadow; a voice
 * take's bar wears the same.
 */
const FIELD_SHADOW = (line: string) => `0px 0px 0px 0.5px ${line}, 0px 6px 18px -10px rgba(0, 0, 0, 0.25)`;
/** Words left in a conversation's field, by `draftKey`, while the app runs. */
const DRAFTS = new Map<string, string>();

/** How long the send button is held to stop the agent and send; the ring around it fills meanwhile. */
const HOLD_SEND_MS = 600;
/**
 * The ring waits this long before it shows and starts to fill (it still closes at `HOLD_SEND_MS`): a quick tap on send
 * never flashes it.
 */
const RING_DELAY_MS = 120;
const RING = 44;
const RING_PATH = (() => {
  // Paths are immutable in this Skia: they are made with a builder.
  const path = Skia.PathBuilder.Make();
  path.addCircle(RING / 2, RING / 2, RING / 2 - 2);
  return path.build();
})();
const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);
/**
 * The send button comes in from 0.85 and fading, on the strong ease-out with no overshoot, and leaves the same way:
 * it shows dozens of times a conversation, so it is quick and plain. Reduced motion keeps only the fade.
 */
const SEND_MS = 140;
const SEND_FROM = 0.85;
const SEND_IN: EntryExitAnimationFunction = () => {
  "worklet";
  return {
    initialValues: { opacity: 0, transform: [{ scale: SEND_FROM }] },
    animations: {
      opacity: withTiming(1, { duration: SEND_MS, easing: EASE_OUT }),
      transform: [{ scale: withTiming(1, { duration: SEND_MS, easing: EASE_OUT }) }],
    },
  };
};
const SEND_OUT: EntryExitAnimationFunction = () => {
  "worklet";
  return {
    initialValues: { opacity: 1, transform: [{ scale: 1 }] },
    animations: {
      opacity: withTiming(0, { duration: SEND_MS, easing: EASE_OUT }),
      transform: [{ scale: withTiming(SEND_FROM, { duration: SEND_MS, easing: EASE_OUT }) }],
    },
  };
};
const SEND_FADE_IN = FadeIn.duration(SEND_MS);
const SEND_FADE_OUT = FadeOut.duration(SEND_MS);
/** The formatting bar and the sticker button fade in and out; built once, never while the field redraws. */
const BAR_IN = FadeIn.duration(140);
const BAR_OUT = FadeOut.duration(100);

/** Where a composer's floating parts go when the screen draws them outside its measured box (`ComposerProps.float`). */
export interface ComposerFloatSlot {
  get: () => ReactNode;
  set: (node: ReactNode) => void;
  subscribe: (listener: () => void) => () => void;
}

/** A slot for one composer's floating parts, made once per screen (`useState(createComposerFloat)`). */
export function createComposerFloat(): ComposerFloatSlot {
  let node: ReactNode = null;
  const listeners = new Set<() => void>();
  return {
    get: () => node,
    set: (next) => {
      if (next === node) return;
      node = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * Draws what the composer put in its slot, where the screen places this: the "@"/"#" picker or the formatting bar. It
 * redraws in the same frame as the composer (the slot is set in a layout effect), so nothing lags the keys.
 */
export function ComposerFloat({ slot }: { slot: ComposerFloatSlot }) {
  const node = useSyncExternalStore(slot.subscribe, slot.get, slot.get);
  return <>{node}</>;
}

/** `fn` as of the last render, behind a function that never changes: what it is handed to isn't redrawn for it. */
function useLatest<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []);
}

const sameToken = (a: ComposerToken | null, b: ComposerToken | null) =>
  a === b || (a !== null && b !== null && a.start === b.start && a.query === b.query && a.sigil === b.sigil);

/**
 * The field's shake each time `count` goes up (a voice take too short to send): a few points either way, settling,
 * on the UI thread; none with Reduce Motion.
 */
function useShake(count: number, reduced: boolean) {
  const shake = useSharedValue(0);
  useEffect(() => {
    if (!count || reduced) return;
    const step = (to: number, duration: number) => withTiming(to, { duration, easing: Easing.linear });
    shake.set(withSequence(step(-6, 45), step(6, 70), step(-4, 60), step(3, 50), step(0, 45)));
  }, [count, reduced, shake]);
  return useAnimatedStyle(() => ({ transform: [{ translateX: shake.get() }] }));
}

/**
 * The center of the app: one raised capsule that holds everything, the "+" for attachments and actions at its start,
 * the words, then its round buttons at the end: the quiet ones (stickers, the mic) on a neutral fill, the one that acts
 * (send, stop) in ink, the only ink circle. One line keeps them all on the same center line; longer text grows the
 * capsule upward and everything stays at the bottom. GIFs and stickers (`media`) have their button at the empty field's
 * end: they go as a message of their own, never with words.
 * Formatting has no button in the row: while words are selected in the field, a bar of them (bold, italic, lists…)
 * shows right over it and writes Markdown around the selection, which stays selected.
 *
 * A key typed redraws the field once, for its words: where the caret went, whether words are selected and the "@"
 * being typed are kept as the keys go and redraw only when what they show changes, and the "+" and the send button
 * are pieces of their own that the words leave alone.
 *
 * While an agent works: the empty field's button is "Parar" (a rounded square), one
 * tap and it stops, no question asked (what it did stays and can continue); with text, a tap on send joins
 * what it is doing and holding the button (a ring of ink fills around it) stops it and sends. A light tap on
 * send, a firm one on stop. The first time words go into an agent's work with a tap, a toast says so, once: a line
 * under the field came and went with the send button and moved the conversation each time.
 */
export function Composer({
  placeholder,
  onSend,
  working = null,
  onPlus,
  float,
  inputNativeID,
  mention,
  mentionAt,
  insertMention,
  prefill,
  focusAt,
  banner,
  attachments,
  sendEmpty = false,
  onLongAsFile,
  onType,
  draftKey,
  media,
  voice,
}: ComposerProps) {
  const { colors, shadows, reducedMotion } = useTheme();
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const [text, setText] = useState(() => (draftKey ? (DRAFTS.get(draftKey) ?? "") : ""));
  const tooLong = tooLongToSend(text);
  // Every change of the words is the draft too; an empty field leaves none behind.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key is the conversation the field belongs to
  useEffect(() => {
    if (!draftKey) return;
    if (text.trim()) DRAFTS.set(draftKey, text);
    else DRAFTS.delete(draftKey);
  }, [text]);
  // The words as the keys left them, and where the caret and the selection are: read by what the next key, a pick or
  // a format does, never drawn themselves. The field's own events keep them current, in whichever order they come.
  const textRef = useRef(text);
  textRef.current = text;
  const caret = useRef(0);
  const range = useRef({ start: 0, end: 0 });
  // What is drawn from them, set only when it changes: the "@"/"#" being typed, and whether words are selected.
  const [token, setToken] = useState<ComposerToken | null>(null);
  const tokenRef = useRef<ComposerToken | null>(null);
  const [selecting, setSelecting] = useState(false);
  const selectingRef = useRef(false);
  // A selection the composer sets (after a pick or a format), held until the field reports its own.
  const [selection, setSelection] = useState<{ start: number; end: number } | undefined>(undefined);
  const [focused, setFocused] = useState(false);
  // Whether the person has held send once or was told how; read the first time it matters.
  const taught = useRef<boolean | null>(null);
  const input = useRef<TextInputInstance | null>(null);

  const retoken = (value: string, at: number) => {
    const next = mentionAt ? mentionAt(value, at) : null;
    if (sameToken(next, tokenRef.current)) return;
    tokenRef.current = next;
    setToken(next);
  };

  const prefillAt = prefill?.at;
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per request (its time), whatever the text
  useEffect(() => {
    if (!prefill) return;
    const handed = prefill.text;
    const current = textRef.current;
    const next = prefill.join ? joinDrafts(handed, current) : current.trim() ? current : handed;
    put(next);
    input.current?.focus();
  }, [prefillAt]);
  useEffect(() => {
    if (focusAt) input.current?.focus();
  }, [focusAt]);
  const typed = text.trim().length > 0;
  const take = voice?.send ?? null;
  const has = typed || sendEmpty || Boolean(take);
  // The mic held: the field is the recording, nothing else shows around it.
  const holding = Boolean(voice?.overlay);
  const shownToken = focused && mention ? token : null;
  const stopMode = Boolean(working?.stop) && !has && !voice?.active;
  const button = has || stopMode;
  const mediaButton = media && !has ? media : null;
  // Files waiting don't take it away: a take started then goes with them.
  const mic = voice && !typed ? voice.mic : null;
  // A take too short to send: the field shakes once, as a refused entry does (with the haptic and the line saying so).
  const shakeStyle = useShake(voice?.nope ?? 0, reducedMotion);

  // Words set from here leave no words selected. iOS reports no selection change for text set from code, so what
  // was selected before stayed "selected": the formatting bar floated over the field emptied by a send.
  const unselect = () => {
    if (!selectingRef.current) return;
    selectingRef.current = false;
    setSelecting(false);
  };
  /**
   * New words with the caret at `at` (the end by default), as a pick leaves them, or words handed back (a draft, a take
   * that didn't go): caret, token and selection all follow the new words, which no selection event will report.
   */
  const put = (next: string, at = next.length) => {
    textRef.current = next;
    caret.current = at;
    range.current = { start: at, end: at };
    unselect();
    setText(next);
    setSelection({ start: at, end: at });
    retoken(next, at);
  };
  /**
   * The words went: the field empties, its caret at the start, the focus kept. The caret is set with the words, as
   * `put` does: on iOS a multiline field emptied from code with no selection kept the height of the lines it had (a
   * two-line message left an empty two-line field after it was sent).
   */
  const clear = () => put("", 0);

  const send = (how: SendHow) => {
    const value = textRef.current.trim();
    if (take) {
      if (tooLong) return;
      clear();
      void take(value).then((sent) => {
        if (!sent && value) put(joinDrafts(value, textRef.current));
      });
      return;
    }
    if ((!value && !sendEmpty) || tooLong) return;
    // The tap answers at once (its haptic is the press's): the field emptied and the button gone in this frame. The
    // send itself (the copy in the conversation, which redraws the whole list) follows on the next one: done in the
    // same render, the field waited for the conversation's redraw and the button felt slow on a long conversation.
    clear();
    const joining = working ? how : "join";
    requestAnimationFrame(() => onSend(value, joining));
  };

  const wasTaught = () => {
    taught.current ??= readValueSync(STORED.stopSendTaught) === "1";
    return taught.current;
  };
  const markTaught = () => {
    if (wasTaught()) return;
    taught.current = true;
    writeValueSync(STORED.stopSendTaught, "1");
  };
  const press = () => {
    // Past the limit the words can't go (the line above the field says why and offers the way out): the tap is
    // answered, never met with nothing.
    if (tooLong) {
      haptics.warning();
      return;
    }
    if (has) {
      haptics.light();
      const joins = Boolean(working) && !take;
      send("join");
      // Once ever: the words went into the agent's work, and holding would have stopped it to read them now.
      if (joins && !wasTaught()) {
        markTaught();
        toast({ title: t("mobile.composer.holdToStop"), icon: "send" });
      }
      return;
    }
    if (!working?.stop) return;
    haptics.firm();
    working.stop.onStop();
  };
  // The button held while an agent works here: it stops and reads this at once. The haptic is the hold's own.
  const holdSend = () => {
    send("now");
    markTaught();
  };
  const holdHint = working && has && !take && !tooLong ? t("mobile.composer.holdToStop") : null;
  // The send button keeps these between the keys typed (it is drawn again only for what it shows).
  const onButton = useLatest(press);
  const onHold = useLatest(holdSend);

  const formatting = focused && selecting && !holding;
  const format = useLatest((kind: FormatKind) => {
    haptics.selection();
    const { start, end } = range.current;
    const next = applyFormat(textRef.current, start, end, kind, { link: t("composer.format.linkText") });
    textRef.current = next.value;
    caret.current = next.end;
    range.current = { start: next.start, end: next.end };
    setText(next.value);
    setSelection({ start: next.start, end: next.end });
    retoken(next.value, next.end);
  });

  const pick = useLatest((handle: string) => {
    const at = tokenRef.current;
    if (!at || !insertMention) return;
    haptics.selection();
    const next = insertMention(textRef.current, at, handle);
    put(next.text, next.caret);
  });

  // Over the field, in the screen's slot when it gives one: the formatting bar while words are selected, else the
  // picker while "@…" or "#…" is typed. Each is made again only when what it shows changes, so the keys typed between
  // leave it as it is.
  const formatBar = useMemo(
    () =>
      formatting ? (
        <Animated.View
          entering={reducedMotion ? undefined : BAR_IN}
          exiting={reducedMotion ? undefined : BAR_OUT}
          style={styles.formatBleed}
        >
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="always"
            contentContainerStyle={styles.formatRow}
          >
            <View
              accessibilityRole="toolbar"
              accessibilityLabel={t("composer.format.toolbar")}
              style={[styles.format, { backgroundColor: colors.raised, boxShadow: `${shadows.e1}, ${shadows.top}` }]}
            >
              {FORMAT_KINDS.map((kind) => (
                <PressScale
                  key={kind}
                  to={0.9}
                  haptic={false}
                  onPress={() => format(kind)}
                  accessibilityRole="button"
                  accessibilityLabel={t(`composer.format.${kind}`)}
                  // 36 wide and tall: the slop reaches 44 up and down without pushing the field.
                  hitSlop={{ top: 4, bottom: 4 }}
                  style={styles.formatButton}
                >
                  <View style={styles.center}>
                    <Icon name={kind} size={20} color={colors.ink2} />
                  </View>
                </PressScale>
              ))}
            </View>
          </ScrollView>
        </Animated.View>
      ) : null,
    [formatting, reducedMotion, colors, shadows, t, format],
  );
  const picker = useMemo(
    () => (shownToken && mention ? mention({ query: shownToken.query, sigil: shownToken.sigil, pick }) : null),
    [shownToken, mention, pick],
  );
  const floating = formatBar ?? picker;
  // Handed to the slot after every draw, in the same frame (a layout effect), and taken back when the field goes.
  useLayoutEffect(() => {
    float?.set(floating);
  });
  useLayoutEffect(() => () => float?.set(null), [float]);

  return (
    <View>
      {float ? null : floating}
      {banner}
      {tooLong ? (
        <View accessibilityRole="alert" style={styles.tooLong}>
          <RNText
            maxFontSizeMultiplier={CHROME_MAX_SCALE}
            style={[systemText("footnote", weights.regular), { color: colors.danger }]}
          >
            {tooLongText(t, i18n.language, text.trim().length)}
            {onLongAsFile ? "" : ` ${t("channel.tooLong.fix")}`}
          </RNText>
          {onLongAsFile ? (
            // An 18-point line: 13 of slop around it gives the 44-point target.
            <Pressable
              accessibilityRole="button"
              hitSlop={13}
              onPress={() => {
                onLongAsFile(textRef.current.trim());
                clear();
              }}
            >
              <RNText
                maxFontSizeMultiplier={CHROME_MAX_SCALE}
                style={[systemText("footnote", weights.semibold), styles.tooLongAct, { color: colors.ink }]}
              >
                {t("channel.tooLong.asFile")}
              </RNText>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {voice?.above ?? null}
      {voice?.bar ? (
        <Animated.View
          entering={reducedMotion ? undefined : RISE_IN}
          exiting={reducedMotion ? undefined : FADE_OUT}
          style={[styles.bar, { backgroundColor: colors.raised, boxShadow: FIELD_SHADOW(colors.separator) }]}
        >
          {voice.bar}
        </Animated.View>
      ) : null}
      <View style={styles.row}>
        <Animated.View
          style={[
            styles.field,
            {
              backgroundColor: colors.raised,
              boxShadow: FIELD_SHADOW(colors.separator),
              paddingLeft: onPlus ? INSET : 14,
              paddingRight: button || mediaButton || mic ? INSET : 14,
            },
            shakeStyle,
          ]}
        >
          {/* What goes with the message: a row of its own across the field, over the words and the send button. */}
          {attachments ? <View style={styles.attachRow}>{attachments}</View> : null}
          {/* The capsule's start, on the words' last line as the buttons at its end. */}
          {onPlus ? <PlusButton label={t("mobile.a11y.attach")} onPress={onPlus} /> : null}
          {/* The placeholder is ours, on one line (cut with "…"): a long one wrapped and grew the empty field. */}
          <View style={styles.inputBox}>
            {!text ? (
              <View style={styles.placeholder} pointerEvents="none">
                <RNText numberOfLines={1} style={[placeholderText, { color: colors.faint }]}>
                  {placeholder}
                </RNText>
              </View>
            ) : null}
            <TextInput
              ref={input}
              {...(inputNativeID ? { nativeID: inputNativeID } : {})}
              value={text}
              onChangeText={(next) => {
                textRef.current = next;
                setText(next);
                retoken(next, caret.current);
                if (next.trim()) onType?.(next);
              }}
              {...(selection ? { selection } : {})}
              // The caret moves with every key: kept, not drawn. Only a change in what shows (the "@" picker, words
              // selected for the formatting bar) redraws the field.
              onSelectionChange={(e) => {
                const { start, end } = e.nativeEvent.selection;
                caret.current = end;
                range.current = { start, end };
                retoken(textRef.current, end);
                if (end > start !== selectingRef.current) {
                  selectingRef.current = end > start;
                  setSelecting(end > start);
                }
                if (selection) setSelection(undefined);
              }}
              multiline
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              accessibilityLabel={placeholder}
              style={[inputText, styles.inputFill, { color: colors.ink }]}
            />
          </View>
          {mediaButton ? (
            <Animated.View
              entering={reducedMotion ? undefined : BAR_IN}
              exiting={reducedMotion ? undefined : BAR_OUT}
              style={styles.sendBox}
            >
              <PressScale
                to={0.9}
                onPress={mediaButton.onPress}
                accessibilityRole="button"
                accessibilityLabel={mediaButton.label}
                hitSlop={INSET}
                style={[styles.media, { backgroundColor: colors.chip }]}
              >
                <View style={styles.center}>
                  <Icon name="sticker" size={20} color={colors.muted} />
                </View>
              </PressScale>
            </Animated.View>
          ) : null}
          {button ? (
            <SendButton
              stop={stopMode}
              label={stopMode && working?.stop ? working.stop.label : t("mobile.a11y.send")}
              onPress={onButton}
              holdHint={holdHint}
              onHold={onHold}
            />
          ) : null}
          {voice?.overlay ?? null}
          {mic ? <View style={styles.micBox}>{mic}</View> : null}
        </Animated.View>
      </View>
    </View>
  );
}

/**
 * The "+" at the capsule's start: a round button on the neutral fill, as the quiet ones at its end, its slop reaching
 * the capsule's edges. A piece of its own, so the keys typed in the field never draw it again.
 */
const PlusButton = memo(function PlusButton({ label, onPress }: { label: string; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <PressScale
      to={0.9}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={INSET}
      style={[styles.plus, { backgroundColor: colors.chip }]}
    >
      <View style={styles.center}>
        <Icon name="plus" size={22} color={colors.ink2} />
      </View>
    </PressScale>
  );
});

/**
 * The field's round button: the send arrow, or the stop square. It comes in (`SEND_IN`: from 0.85, fading, no
 * overshoot) on the glyph it shows, its value born with it: iOS draws a glyph still turning inside that entrance
 * blurry. On a button already there the two swap in place, one turning away as the other turns in.
 *
 * With `holdHint` (an agent at work and text to send), a tap sends and holding fills a ring of ink around the button,
 * linear, for as long as the hold takes; the ring and its track show only after `RING_DELAY_MS`, so a tap never
 * flashes them. Let go early and it empties fast. The ring closed, a firm haptic lands with it and the message goes
 * "now". Both run on the UI thread; React hears of the tap and the hold only.
 *
 * Drawn again only when what it shows changes (its glyph, its label, the hold): its gestures are set up on the native
 * side each time it is, and a field that redrew it with every key did that with every key.
 */
const SendButton = memo(function SendButton({
  stop,
  label,
  onPress,
  holdHint,
  onHold,
}: {
  stop: boolean;
  label: string;
  onPress: () => void;
  /** What holding does, said to a screen reader; null when holding does nothing more than a tap. */
  holdHint: string | null;
  onHold: () => void;
}) {
  const { colors, reducedMotion } = useTheme();
  const hold = holdHint !== null;
  const mode = useSharedValue(stop ? 1 : 0);
  const ring = useSharedValue(0);
  const pressed = useSharedValue(0);
  const held = useSharedValue(false);
  const trackOpacity = useDerivedValue(() => (ring.value > 0.001 ? 1 : 0));
  const holdNow = () => {
    haptics.firm();
    onHold();
  };
  const longPress = useLongPressGesture({
    enabled: hold,
    minDuration: HOLD_SEND_MS,
    maxDistance: 24,
    // The field's 48 to the finger, as the plain button's: the view takes the same slop (iOS routes the touch by it).
    hitSlop: INSET,
    onBegin: () => {
      "worklet";
      held.value = false;
      pressed.value = reducedMotion ? 1 : withTiming(1, PRESS_IN);
      // Linear, as time passes, and only once the touch has lasted past a tap: it still closes when the hold lands.
      ring.value = withDelay(
        RING_DELAY_MS,
        withTiming(1, { duration: HOLD_SEND_MS - RING_DELAY_MS, easing: Easing.linear }),
      );
    },
    onActivate: () => {
      "worklet";
      held.value = true;
      ring.value = withTiming(0, { duration: 200, easing: EASE_OUT });
      scheduleOnRN(holdNow);
    },
    onFinalize: () => {
      "worklet";
      pressed.value = reducedMotion ? 0 : withTiming(0, PRESS_OUT);
      if (held.value) return;
      cancelAnimation(ring);
      ring.value = withTiming(0, { duration: 150, easing: EASE_OUT });
    },
  });
  const tap = useTapGesture({
    enabled: hold,
    maxDuration: HOLD_SEND_MS - 20,
    hitSlop: INSET,
    onDeactivate: () => {
      "worklet";
      scheduleOnRN(onPress);
    },
  });
  const gesture = useExclusiveGestures(longPress, tap);
  const pressStyle = useAnimatedStyle(() => ({ transform: [{ scale: 1 - 0.1 * pressed.value }] }));
  useEffect(() => {
    const to = stop ? 1 : 0;
    // Both springs give their mass: with Reanimated 4's default of 4 they overshoot by half and take seconds to settle.
    mode.value = reducedMotion ? to : withSpring(to, { damping: 16, stiffness: 320, mass: 1 });
  }, [stop, reducedMotion, mode]);
  const sendGlyph = useAnimatedStyle(() => ({
    opacity: 1 - mode.value,
    transform: [{ scale: 1 - 0.6 * mode.value }, { rotate: `${45 * mode.value}deg` }],
  }));
  const stopGlyph = useAnimatedStyle(() => ({
    opacity: mode.value,
    transform: [{ scale: 0.4 + 0.6 * mode.value }, { rotate: `${-45 * (1 - mode.value)}deg` }],
  }));
  const glyphs = (
    <>
      <Animated.View style={[styles.glyph, sendGlyph]}>
        <Icon name="send" size={18} color={colors.bg} />
      </Animated.View>
      <Animated.View style={[styles.glyph, stopGlyph]}>
        <PixelStop size={13} color={colors.bg} moving={stop} />
      </Animated.View>
    </>
  );
  return (
    <Animated.View
      entering={reducedMotion ? SEND_FADE_IN : SEND_IN}
      exiting={reducedMotion ? SEND_FADE_OUT : SEND_OUT}
      style={styles.sendBox}
    >
      {holdHint !== null ? (
        <>
          <Canvas style={styles.ring} pointerEvents="none">
            <Group origin={vec(RING / 2, RING / 2)} transform={[{ rotate: -Math.PI / 2 }]}>
              <Path path={RING_PATH} style="stroke" strokeWidth={2} color={colors.line2} opacity={trackOpacity} />
              <Path
                path={RING_PATH}
                style="stroke"
                strokeWidth={2.5}
                strokeCap="round"
                color={colors.ink}
                start={0}
                end={ring}
              />
            </Group>
          </Canvas>
          <GestureDetector gesture={gesture}>
            <Animated.View
              accessible
              accessibilityRole="button"
              accessibilityLabel={label}
              accessibilityHint={holdHint}
              hitSlop={INSET}
              style={[styles.send, { backgroundColor: colors.ink }, pressStyle]}
            >
              {glyphs}
            </Animated.View>
          </GestureDetector>
        </>
      ) : (
        <PressScale
          to={0.9}
          haptic={false}
          onPress={onPress}
          accessibilityRole="button"
          accessibilityLabel={label}
          hitSlop={INSET}
          style={[styles.send, { backgroundColor: colors.ink }]}
        >
          {glyphs}
        </PressScale>
      )}
    </Animated.View>
  );
});

/**
 * The field's text: one line is exactly the send button's height, so text, "+" and send share a center
 * line. iOS draws a multiline field's `lineHeight` from the top (the text sits low), so there the line
 * keeps the font's own height and the padding centers it; Android centers it itself.
 */
const body = systemText("body");
const inputText: TextStyle = {
  flex: 1,
  minWidth: 0,
  minHeight: SEND,
  maxHeight: 140,
  fontSize: body.fontSize,
  fontWeight: body.fontWeight,
  letterSpacing: body.letterSpacing,
  paddingHorizontal: 0,
  ...Platform.select<TextStyle>({
    ios: { paddingTop: 8, paddingBottom: 8 },
    // The one line centered in the send button's height: the field is exactly as tall.
    default: {
      lineHeight: body.lineHeight,
      paddingTop: (SEND - (body.lineHeight ?? SEND)) / 2,
      paddingBottom: (SEND - (body.lineHeight ?? SEND)) / 2,
      textAlignVertical: "center",
      includeFontPadding: false,
    },
  }),
};

/** The placeholder's words, as the field's own text sits on its first line. */
const placeholderText: TextStyle = {
  fontSize: body.fontSize,
  fontWeight: body.fontWeight,
  letterSpacing: body.letterSpacing,
  ...Platform.select<TextStyle>({ android: { lineHeight: body.lineHeight, includeFontPadding: false } }),
};

const styles = StyleSheet.create({
  // Why the words can't go, then the way out after them, or under them when it doesn't fit.
  tooLong: {
    flexDirection: "row",
    flexWrap: "wrap",
    columnGap: 12,
    rowGap: 4,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  tooLongAct: { textDecorationLine: "underline" },
  inputBox: { flex: 1, minWidth: 0 },
  // The field's whole width; its thumbnails sit as far from the field's rounded corner as their own corner is round.
  attachRow: { width: "100%", paddingTop: 6 },
  inputFill: { flex: 0, width: "100%" },
  // Over the empty field's one line, centered on it.
  placeholder: { position: "absolute", left: 0, right: 0, bottom: 0, height: SEND, justifyContent: "center" },
  // To the screen edges (past the composer's own inset), so on a narrow phone the last buttons scroll in instead of
  // being cut at the padding.
  formatBleed: { marginHorizontal: -10 },
  formatRow: { paddingHorizontal: 10, paddingBottom: 8 },
  format: { flexDirection: "row", height: 44, padding: 4, gap: 2, borderRadius: 22 },
  formatButton: { width: SEND, height: SEND, borderRadius: SEND / 2 },
  row: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  // The send button's size, on the same center line.
  plus: { width: SEND, height: SEND, borderRadius: SEND / 2 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  field: {
    flex: 1,
    minWidth: 0,
    minHeight: FIELD,
    borderRadius: FIELD / 2,
    flexDirection: "row",
    // Attachments take a line of their own over the words (`attachRow`).
    flexWrap: "wrap",
    alignItems: "flex-end",
    gap: 8,
    paddingVertical: INSET,
    paddingLeft: 14,
  },
  // A take's row above the field: the field's capsule at its one-line height, its 36 controls INSET from every edge.
  bar: {
    marginBottom: 8,
    height: FIELD,
    borderRadius: FIELD / 2,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: INSET,
  },
  sendBox: { width: SEND, height: SEND },
  // Around the button, 4 past it on every side.
  ring: { position: "absolute", left: (SEND - RING) / 2, top: (SEND - RING) / 2, width: RING, height: RING },
  // Above the overlay: the finger that holds it stays on the same button while the field changes.
  micBox: { width: SEND, height: SEND, zIndex: 2 },
  send: { width: SEND, height: SEND, borderRadius: SEND / 2 },
  media: { width: SEND, height: SEND, borderRadius: SEND / 2 },
  glyph: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center" },
});
