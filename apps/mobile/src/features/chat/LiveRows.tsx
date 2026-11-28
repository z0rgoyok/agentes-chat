import { elapsedClock, type LiveRun, type TypingWho, usesBrowser } from "@agenteschat/client";
import {
  type ActivityEntry,
  activitySentence,
  activityVerb,
  barAsking,
  barConsultTime,
  barElapsed,
  barFaces,
  barWords,
  bothAtIt,
  type ConsultWithDetails,
  facesOf,
  listNames,
  markFaced,
  peopleGroups,
  someoneTypes,
} from "@agenteschat/client/lib/activity";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { type TrailLine, usePacedTrail, workTrail } from "@agenteschat/client/lib/trail";
import { barStep } from "@agenteschat/client/lib/work";
import { type AgentColorName, gradientOf } from "@agenteschat/ui/agent/engine";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Pressable,
  Text as RNText,
  type StyleProp,
  StyleSheet,
  type TextLayoutEvent,
  type TextStyle,
  View,
  type ViewStyle,
} from "react-native";
import Animated, {
  css,
  Easing,
  type EntryExitAnimationFunction,
  FadeIn,
  FadeOut,
  LayoutAnimationConfig,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useLivePaused } from "@/agent/live";
import { loopStyle } from "@/agent/loop";
import { OrbitFace } from "@/agent/OrbitFace";
import { CHROME_MAX_SCALE, haptics, Icon, PixelStop, Text, TOUCH, useReducedMotion, useTheme } from "@/ui";
import { AgentFace, AgentWho, Face } from "../shared/Face";
import { useNow } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import {
  awayRun,
  type LineDrawn,
  type LineWords,
  leavingWords,
  lineFit,
  markedParts,
  markName,
  narrowDrawn,
  PHRASE_FADE_MS,
  type PhraseTurn,
  turnPhrase,
  workingEntries,
} from "./logic";
import { useRowDirectory } from "./row-data";
import { WaitMark } from "./WaitMark";

/** The runs at work in their browser, one per agent: each gets its browser card. */
export function browsingRuns(runs: LiveRun[]): LiveRun[] {
  const seen = new Set<string>();
  return runs.filter((r) => {
    if (r.status === "failed" || !usesBrowser(r) || seen.has(r.agentId)) return false;
    seen.add(r.agentId);
    return true;
  });
}

/**
 * The working line, saying what the web's activity bar above the composer says (ChannelPage `ActivityBar`,
 * WorkingLine.tsx, `.ac-typing[data-active]`), one for everyone at work here and the one thing that says so while
 * their words wait for their replies (which show whole, once posted). On the phone it is the conversation's last line,
 * under its last message and scrolling with it, as a reply on its way (above the composer only while there is no
 * conversation yet): a bare line on the conversation's ground, as wide as the composer whatever it says (no glass, no
 * shadow, no band behind it: the faces and the words say it);
 * a few small faces, each on a plate and popping in (an agent on its own asking another shows both, with an arrow;
 * three dots first while only people type); one line with names in ink, crossfading whenever it changes ("Theo e mais 2 estão
 * trabalhando · Marina está digitando…"), who records a voice message last, after three bars and their faces ("Rui
 * está gravando áudio…"); the clock of a question that is out. One agent on its own: its face, its step after its
 * name ("escrevendo…" while it writes) with its time right after it ("16 s"), whoever types or records beside it,
 * then "Parar".
 * Nothing moves with Reduce Motion or off screen.
 */
export function WorkingLine({
  runs,
  consults,
  typing,
  onOpenBrowser,
  onSeeConsult,
  stop,
  rest = null,
  style,
}: {
  runs: LiveRun[];
  consults: ConsultWithDetails[];
  /** "Ver" on a question or hand-off out from here: the two agents' talk (ADR 0095 addendum). */
  onSeeConsult?: (consultationId: string) => void;
  /** The people typing or recording here (never me). */
  typing: TypingWho[];
  /** An agent in its browser: tapping the line opens its card in the conversation. */
  onOpenBrowser?: (agentId: string) => void;
  /**
   * "Parar", the word, last in the line: the runs here the person may stop. The line is the one place that stops
   * (the composer keeps only its send), so the state and its action read together.
   */
  stop?: { runs: LiveRun[]; onStop: (run: LiveRun) => void } | undefined;
  /** What the line holds while nobody works here: a return (`ReturnLine`). Work comes first. */
  rest?: ReactNode;
  /** Its room where it is drawn (in the conversation: a turn's gap above it), only while it says something. */
  style?: StyleProp<ViewStyle>;
}) {
  const { t, i18n } = useTranslation();
  const dir = useRowDirectory();
  const { colors: c } = useTheme();
  const reduced = useReducedMotion();
  const agentName = (id: string) => dir.agentById.get(id)?.name ?? t("channel.unknownAgent");
  const entries = workingEntries(runs, consults, agentName, typing, (id) => dir.memberById.get(id)?.name);
  const asking = barAsking(entries);
  const agents = entries.filter((e) => e.type === "agent");
  const lead = agents[0];
  // The time is one agent's: with several at work the line can't say whose.
  const solo = agents.length === 1 ? lead : undefined;
  // One clock for the time and a question's clock, moving each second while one counts: a redraw in between (the
  // phrase turning, an event) reads the same second, so both step evenly; narrowing to one agent changes the pace, and a
  // new pace reads the clock afresh (`useNow`).
  const now = useNow(asking || solo ? 1000 : 60_000);
  // What it did so far, under the line (`workTrail`): the same lines its reply's work block shows once posted. One
  // agent's, at work (a question it asks keeps its own phrase).
  const trailRun = solo && !solo.consult ? runs.find((r) => r.agentId === solo.id) : undefined;
  const trail = usePacedTrail(trailRun ? workTrail(t, trailRun, i18n.language) : NO_TRAIL);
  if (entries.length === 0) return rest;
  // The one agent it speaks for; a question it asks keeps its own phrase.
  const away = awayRun(entries, runs);
  const step = away && lead && !lead.consult ? barStep(t, away, i18n.language, now) : null;
  const took = away ? barElapsed(t, entries, runs, now) : null;
  // Its effort so far, one pixel per call it made: only for the one agent the line speaks for.
  const soloRun = solo ? runs.find((r) => r.agentId === solo.id) : undefined;
  const calls = soloRun ? (soloRun.work ?? []).filter((w) => w.kind === "call").length : 0;
  const soloColor = solo ? agentLook(dir.agentById.get(solo.id)).color : null;
  // Who types or records beside that agent, after its time ("· Marina digitando · Rui gravando áudio…"): the names give
  // way first, never what they do.
  const groups = step === null ? [] : peopleGroups(entries);
  const also = groups.map((g, i) => ({
    kind: g.kind,
    names: listNames(t, g.names, markName),
    doing: `${activityVerb(t, { kind: g.kind })}${i === groups.length - 1 ? "…" : ""}`,
  }));
  const awayWords = [`${markName(lead?.name ?? "")} ${step}`, took, ...also.map((a) => `${a.names} ${a.doing}`)];
  const sentence =
    step !== null ? awayWords.filter(Boolean).join(" · ") : activitySentence(t, entries, markName, markFaced);
  const label = markedParts(sentence)
    .map((p) => p.text)
    .join("");
  // A piece of the line, on one line, names in ink.
  const piece: LinePiece = (text, style, onTextLayout) => (
    <Text
      variant="caption"
      tone="muted"
      numberOfLines={1}
      maxFontSizeMultiplier={CHROME_MAX_SCALE}
      style={style}
      onTextLayout={onTextLayout}
    >
      {markedParts(text).map((p, i) =>
        p.agentId ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of one sentence, in order
          <RNText key={i} style={{ color: c.ink }}>
            <AgentWho agentId={p.agentId} name={p.text} size={13} lead={i === 0} />
          </RNText>
        ) : p.bold ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of one sentence, in order
          <RNText key={i} style={[styles.ink, { color: c.ink }]}>
            {p.text}
          </RNText>
        ) : (
          p.text
        ),
      )}
    </Text>
  );
  // A question at work keeps its clock; work handed off and a wait carry the lists' time ("22 min").
  const clock =
    asking && asking.kind !== "note" && !asking.wait && !asking.yours ? elapsedClock(now - asking.since) : null;
  const consultTime = barConsultTime(i18n.language, asking, now);
  const seeConsult = asking?.id && onSeeConsult ? () => onSeeConsult(asking.id as string) : undefined;
  const pop = reduced ? undefined : FACE_POP;
  const plate = [styles.tok, { backgroundColor: c.bg }];
  // The agents at work open the pill with their faces. Who records shows after the words with their mark, and so does
  // who types beside them: their faces come and go with the phrase as it turns, so they don't pop in again at each turn.
  // Whoever does the work leads, with its orbit while it works: the agent at work, or the one a question or hand-off
  // went to (its own wait holds it still). The words name both and no face repeats: the stack's faces are the others.
  const worker = asking ? { id: asking.to, name: asking.toName } : lead;
  const atWork = asking ? !asking.yours && !asking.wait : Boolean(lead);
  const faces = barFaces(entries).filter((e) => e !== lead);
  const groupFaces = (kind: "typing" | "recordingVoice") => {
    const who = facesOf(entries, kind);
    return who.length > 0 ? (
      <View style={styles.stack} importantForAccessibility="no-hide-descendants">
        {who.map((e, i) => (
          <View key={`g:${e.id}`} style={[plate, i > 0 ? styles.overlap : undefined]}>
            <Face who={{ type: "person", id: e.id }} size={18} />
          </View>
        ))}
      </View>
    ) : null;
  };
  // An agent working in its browser: the line says so, and a tap opens its browser card in the conversation.
  const browsing = browsingRuns(runs)[0];
  const openBrowser = browsing && onOpenBrowser ? () => onOpenBrowser(browsing.agentId) : undefined;
  const stopHere = stop?.runs ?? [];
  return (
    <View style={[styles.dock, style]}>
      <Animated.View
        // In and out on an ease-out, under 200 ms: the line is chrome that comes and goes many times a day.
        entering={reduced ? undefined : LINE_IN}
        exiting={reduced ? undefined : LINE_OUT}
        style={styles.pill}
        accessibilityLiveRegion="polite"
      >
        {lead || !someoneTypes(entries) || bothAtIt(entries) ? null : <TypingDots color={c.muted} />}
        {/* The agent at work leads, a little larger, its rings orbiting it (`OrbitFace`); the stack's faces are the
            others. */}
        {worker && atWork ? (
          <Animated.View key={`o:${worker.id}`} entering={pop} style={styles.orbit}>
            <OrbitFace color={agentLook(dir.agentById.get(worker.id)).color} size={ORBIT_FACE}>
              <AgentFace agentId={worker.id} size={ORBIT_FACE} framed mode={asking ? "think" : "run"} />
            </OrbitFace>
          </Animated.View>
        ) : worker ? (
          <Animated.View key={`w:${worker.id}`} entering={pop} style={styles.orbit}>
            <AgentFace agentId={worker.id} size={ORBIT_FACE} framed mode="idle" />
          </Animated.View>
        ) : null}
        {faces.length > 0 ? (
          <View style={styles.stack} importantForAccessibility="no-hide-descendants">
            {/* Agents in their sky tile, standing in its middle: bare, a body sits at its box's foot under the room kept
                for a hat, so two faces with different hats looked uneven and low beside the arrow and the words. */}
            {faces.map((e, i) => {
              const gap = i > 0 ? styles.overlap : undefined;
              if (e.type === "person")
                return (
                  <Animated.View key={`p:${e.id}`} entering={pop} style={[plate, gap]}>
                    <Face who={{ type: "person", id: e.id }} size={18} />
                  </Animated.View>
                );
              if (asking && e.consult === asking)
                return (
                  <Animated.View key={`c:${e.id}`} entering={pop} style={[styles.pair, gap]}>
                    <View style={plate}>
                      <AgentFace agentId={e.id} size={18} framed mode="idle" />
                    </View>
                    {/* What waits on me takes the arrow's place; a wait on someone else, the quiet clock. */}
                    {asking.yours ? (
                      <WaitMark size={8} />
                    ) : asking.wait ? (
                      <Icon name="clock" size={12} color={c.faint} />
                    ) : (
                      <Icon name="right" size={12} color={c.faint} />
                    )}
                    <View style={plate}>
                      <AgentFace
                        agentId={asking.to}
                        size={18}
                        framed
                        mode={asking.yours || asking.wait ? "idle" : "think"}
                      />
                    </View>
                  </Animated.View>
                );
              return (
                <Animated.View key={`a:${e.id}`} entering={pop} style={[plate, gap]}>
                  <AgentFace agentId={e.id} size={18} framed mode="run" />
                </Animated.View>
              );
            })}
          </View>
        ) : null}
        {/* The words, read as one (its "Ver" is a button of its own). An agent in its browser:
            tapping opens it live. */}
        <Pressable
          disabled={!browsing}
          onPress={openBrowser}
          accessible
          accessibilityRole={browsing ? "button" : "text"}
          accessibilityLabel={browsing ? `${label}. ${t("browser.watch.open")}` : label}
          style={({ pressed }) => [styles.wordsTap, pressed && styles.pressed]}
        >
          {step !== null && lead ? (
            <AwayStep name={lead.name} step={step} reduced={reduced} />
          ) : (
            <TurningWords
              entries={entries}
              piece={piece}
              reduced={reduced}
              faces={{ typing: groupFaces("typing"), voice: groupFaces("recordingVoice") }}
            />
          )}
          {took ? (
            <Text variant="caption" tone="faint" maxFontSizeMultiplier={CHROME_MAX_SCALE} style={styles.took}>
              · {took}
            </Text>
          ) : null}
          {soloColor && calls > 0 ? <StepPixels count={calls} color={soloColor} reduced={reduced} /> : null}
          {also.map((a) => (
            <View key={a.kind} style={styles.also}>
              {piece(`· ${a.names}`, styles.shrink)}
              {piece(` ${a.doing}`)}
            </View>
          ))}
          {browsing ? (
            <View style={[styles.browser, { backgroundColor: c.raised }]}>
              <Icon name="globe" size={12} color={c.ink2} />
            </View>
          ) : null}
        </Pressable>
        {clock ? (
          <Text
            variant="caption"
            tone="muted"
            accessibilityLabel={t("chat.consult.clock", { time: clock })}
            style={styles.clock}
          >
            {clock}
          </Text>
        ) : null}
        {consultTime ? (
          <Text variant="caption" tone="faint" maxFontSizeMultiplier={CHROME_MAX_SCALE} style={styles.took}>
            · {consultTime}
          </Text>
        ) : null}
        {seeConsult ? (
          <Pressable
            onPress={seeConsult}
            accessibilityRole="button"
            // A 16-point word about 20 wide: 14 above and below and 12 at its sides make the 44 a finger needs.
            hitSlop={{ top: (TOUCH - SEE_LINE) / 2, bottom: (TOUCH - SEE_LINE) / 2, left: 12, right: 12 }}
            style={({ pressed }) => [styles.see, pressed && styles.pressed]}
          >
            <Text variant="caption" tone="ink2" maxFontSizeMultiplier={CHROME_MAX_SCALE} style={styles.seeText}>
              {t("run.strip.see")}
            </Text>
          </Pressable>
        ) : null}
        {/* "Parar" as a word, last: the one stop on screen while the rows are out of view (the row's tail has its own
            while it shows; the composer keeps only its send). */}
        {stop && stopHere.length > 0 ? <LineStop runs={stopHere} onStop={stop.onStop} place="word" /> : null}
      </Animated.View>
      {trail.lines.length > 0 ? (
        <View
          style={[styles.trail, worker ? styles.trailUnderWords : undefined]}
          accessibilityLabel={t("chat.trail.label", agentGrammar(lead?.name ?? ""))}
        >
          {trail.earlier > 0 ? (
            <Text variant="caption" tone="faint" maxFontSizeMultiplier={CHROME_MAX_SCALE} style={styles.took}>
              {t("chat.trail.earlier", { count: trail.earlier })}
            </Text>
          ) : null}
          {trail.lines.map((l) => (
            <Animated.View key={l.key} entering={reduced ? undefined : LINE_IN}>
              <Text variant="caption" tone="muted" maxFontSizeMultiplier={CHROME_MAX_SCALE}>
                {l.text}
              </Text>
            </Animated.View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** The agent at work's face on the line, in points: a little larger than the stack's, its rings around it. */
const ORBIT_FACE = 24;
const NO_TRAIL: TrailLine[] = [];

const LINE_EASE = Easing.bezier(0.23, 1, 0.32, 1);
const LINE_IN = FadeIn.duration(160).easing(LINE_EASE);
const LINE_OUT = FadeOut.duration(120).easing(LINE_EASE);

/** How many of its calls the line draws: the latest ones, the oldest of a full strip fading away. */
const STEP_PIXELS = 8;
const STEP_FADE = [0.35, 0.65];

/**
 * The effort so far, after the line's words: a 4pt pixel per tool call the run made, in the agent's two tones by
 * turns. Each new one comes in from 0.9 as the faces do; the ones already made when the line shows are just there. Past eight, the oldest
 * leave and the two before them fade. Decoration: the line's label says what the agent does.
 */
function StepPixels({ count, color, reduced }: { count: number; color: AgentColorName; reduced: boolean }) {
  const tones = gradientOf(color);
  const first = Math.max(0, count - STEP_PIXELS);
  const shown = Array.from({ length: count - first }, (_, i) => first + i);
  return (
    <View style={styles.steps} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <LayoutAnimationConfig skipEntering>
        {shown.map((n, i) => (
          <Animated.View
            key={n}
            entering={reduced ? undefined : FACE_POP}
            style={[styles.step, { backgroundColor: tones[n % 2], opacity: first > 0 ? (STEP_FADE[i] ?? 1) : 1 }]}
          />
        ))}
      </LayoutAnimationConfig>
    </View>
  );
}
/** The "View" word's line (caption, 16). */
const SEE_LINE = 16;
/**
 * A face coming in on its plate: from 0.9 and fading, on the line's ease-out, never from nothing (a face growing out of
 * a point read as a pop, many times a day).
 */
const FACE_POP: EntryExitAnimationFunction = () => {
  "worklet";
  return {
    initialValues: { opacity: 0, transform: [{ scale: 0.9 }] },
    animations: {
      opacity: withTiming(1, { duration: 160, easing: LINE_EASE }),
      transform: [{ scale: withTiming(1, { duration: 160, easing: LINE_EASE }) }],
    },
  };
};

/**
 * "Parar": last in the requests' line's pill after a thin rule (while it takes the working line's place), or written
 * out at the end of the working line (`place="word"`). One tap stops the agent, nothing asked, and "Parando…" while it
 * stops. 24 points drawn, 44 to the finger.
 */
export function LineStop({
  runs,
  onStop,
  rule = true,
  place = "line",
}: {
  runs: LiveRun[];
  onStop: (run: LiveRun) => void;
  /** The thin rule before it (left out after "Ver", which has its own). */
  rule?: boolean;
  /** `word`: "Parar" written out, at the end of the working line (one word for every run it stops). */
  place?: "line" | "word";
}) {
  const { t } = useTranslation();
  const dir = useRowDirectory();
  const c = useTheme().colors;
  if (runs.length === 0) return null;
  const nameOf = (run: LiveRun) => dir.agentById.get(run.agentId)?.name ?? t("channel.unknownAgent");
  // Right away, nothing asked: what it did stays and "Continuar" picks it up again.
  const stopNow = (run: LiveRun) => {
    haptics.firm();
    onStop(run);
  };
  if (place === "word") {
    const stopping = runs.some((r) => r.stopping);
    const live = runs.filter((r) => !r.stopping);
    return (
      <>
        {rule ? <View style={[styles.sep, { backgroundColor: c.line }]} /> : null}
        {stopping && live.length === 0 ? (
          <View style={styles.stopping} accessible accessibilityLabel={t("run.stopping")}>
            <ActivityIndicator size="small" color={c.muted} />
          </View>
        ) : (
          <Pressable
            onPress={() => {
              for (const r of live) stopNow(r);
            }}
            accessibilityRole="button"
            accessibilityLabel={live.map((r) => `${t("run.stop")} · ${nameOf(r)}`).join(", ")}
            // A 16-point word in a 28-point pill: 14 above and below makes the 44 a finger needs.
            hitSlop={{ top: 14, bottom: 14, left: 8, right: 8 }}
            style={({ pressed }) => pressed && styles.pressed}
          >
            {({ pressed }) => (
              <Text
                variant="caption"
                maxFontSizeMultiplier={CHROME_MAX_SCALE}
                style={[styles.ink, { color: pressed ? c.danger : c.ink }]}
              >
                {t("run.stop")}
              </Text>
            )}
          </Pressable>
        )}
      </>
    );
  }
  return (
    <>
      {rule ? <View style={[styles.sep, { backgroundColor: c.line }]} /> : null}
      {runs.map((r) =>
        r.stopping ? (
          <View key={r.runId} style={styles.stopping} accessible accessibilityLabel={t("run.stopping")}>
            <ActivityIndicator size="small" color={c.muted} />
            <Text variant="caption" tone="muted">
              {t("run.stopping")}
            </Text>
          </View>
        ) : (
          <Pressable
            key={r.runId}
            onPress={() => stopNow(r)}
            accessibilityRole="button"
            accessibilityLabel={`${t("run.stop")} · ${nameOf(r)}`}
            hitSlop={10}
            style={({ pressed }) => [styles.stop, pressed && { backgroundColor: `${c.danger}1F` }]}
          >
            {({ pressed }) => <PixelStop size={11} color={pressed ? c.danger : c.muted} />}
          </Pressable>
        ),
      )}
    </>
  );
}

type LinePiece = (text: string, style?: StyleProp<TextStyle>, onTextLayout?: (e: TextLayoutEvent) => void) => ReactNode;
/** The faces a group of people draws after its mark: who types, who records. */
type GroupFaces = { typing: ReactNode; voice: ReactNode };

/**
 * One agent at work, as the web's `BarStep`: its name in ink on one line, its width whatever the step says (up to half
 * the line, past which it ends in "…"), and its step ("Nina consultando o Email · …"), which gives way first when the
 * line is short of room, its time right after it; each new step fades in (a plain swap with Reduce Motion). The line's
 * label says the whole step.
 */
function AwayStep({ name, step, reduced }: { name: string; step: string; reduced: boolean }) {
  return (
    <View style={styles.awayStep}>
      <Text
        variant="caption"
        tone="ink"
        numberOfLines={1}
        maxFontSizeMultiplier={CHROME_MAX_SCALE}
        style={[styles.ink, styles.awayName]}
      >
        {name}
      </Text>
      <Animated.View key={step} entering={reduced ? undefined : FadeIn.duration(160)} style={styles.barStep}>
        <Text variant="caption" tone="muted" numberOfLines={1} maxFontSizeMultiplier={CHROME_MAX_SCALE}>
          {step}
        </Text>
      </Animated.View>
    </View>
  );
}

// The phrase turns as on the web (`.ac-turn`): the old one leaves upward while the new one comes up from below,
// crossfading, so some words always show; a short rise keeps both inside the pill.
const TURN = { duration: PHRASE_FADE_MS, easing: Easing.bezier(0.2, 0.7, 0.2, 1) };

/**
 * The phrase as it turns (`turnPhrase`): the one shown and, over it, the one leaving, the only two drawn. A phrase
 * keeps its key from coming in to leaving, so the words on screen are the ones that leave, at the widths they drew.
 * The first comes with the pill, and the words go with it at once; with Reduce Motion each phrase just takes the last
 * one's place.
 */
function TurningWords({
  entries,
  piece,
  reduced,
  faces,
}: {
  entries: ActivityEntry[];
  piece: LinePiece;
  reduced: boolean;
  /** Each group's faces, after its mark: who records, and who types beside them. */
  faces: GroupFaces;
}) {
  const { t } = useTranslation();
  const words = barWords(t, entries, markName, markFaced);
  const [shown, setShown] = useState<PhraseTurn>(() => ({ now: words, was: null, n: 0, since: Date.now() }));
  const [, wake] = useState(0);
  const next = turnPhrase(shown, words, Date.now());
  if (next.shown !== shown) setShown(next.shown);
  const leaving = leavingWords(next.shown, reduced, Date.now());
  useEffect(() => {
    if (next.wait === 0) return;
    const timer = setTimeout(() => wake((k) => k + 1), next.wait);
    return () => clearTimeout(timer);
  }, [next.wait]);
  return (
    <View style={styles.words}>
      {leaving ? <BarWords key={shown.n - 1} words={leaving} piece={piece} faces={faces} leaving /> : null}
      <BarWords key={shown.n} words={shown.now} piece={piece} faces={faces} enter={shown.n > 0 && !reduced} />
    </View>
  );
}

/**
 * The line's words in the pieces that give way in turn (`barWords`): the agents' and the " · " after them, then
 * who is typing, then who records (after their mark and faces), whose names alone end in "…". Each piece that can end
 * in "…" keeps to the width it drew (`lineFit`), so what follows comes right after it; the agents' words cut to a
 * sliver leave the line.
 */
function BarWords({
  words: [agents, sep, typers, typing, voiceSep, recorders, recording],
  piece,
  faces,
  enter = false,
  leaving = false,
}: {
  words: LineWords;
  piece: LinePiece;
  faces: GroupFaces;
  /** Comes up from below. */
  enter?: boolean;
  /** Rises and fades over the phrase taking its place. */
  leaving?: boolean;
}) {
  const { colors: c } = useTheme();
  const [drawn, setDrawn] = useState<LineDrawn>({});
  // 0 below, 1 in place, 2 gone above.
  const at = useSharedValue(enter ? 0 : 1);
  useEffect(() => {
    at.value = withTiming(leaving ? 2 : 1, TURN);
  }, [leaving, at]);
  const turn = useAnimatedStyle(() => ({
    opacity: 1 - Math.abs(1 - at.value),
    transform: [{ translateY: 6 * (1 - at.value) }],
  }));
  const measure = (part: keyof LineDrawn) => (e: TextLayoutEvent) => {
    const width = e.nativeEvent.lines[0]?.width ?? 0;
    setDrawn((d) => narrowDrawn(d, part, width));
  };
  const fit = lineFit(drawn, Boolean(typing || recording));
  return (
    <Animated.View
      style={[styles.words, typing && recording ? styles.wrap : undefined, leaving && StyleSheet.absoluteFill, turn]}
    >
      {agents && fit.agents !== null ? (
        <View style={styles.agents}>
          {piece(agents, [styles.shrink, { maxWidth: fit.agents }], measure("agents"))}
          {sep ? piece(sep) : null}
        </View>
      ) : null}
      {typing && recording ? (
        <View style={[styles.group, styles.beforeMark, agents ? styles.afterWords : undefined]}>
          <TypingDots color={c.muted} />
          {faces.typing}
          <View style={[styles.people, styles.giveWay]}>
            {piece(typers, [styles.shrink, { maxWidth: fit.typers }], measure("typers"))}
            {piece(typing)}
            {voiceSep ? piece(voiceSep) : null}
          </View>
        </View>
      ) : typing ? (
        <View style={styles.people}>
          {piece(typers, [styles.shrink, { maxWidth: fit.typers }], measure("typers"))}
          {piece(typing)}
        </View>
      ) : null}
      {recording ? (
        <View style={[styles.group, agents && !typing ? styles.afterWords : undefined]}>
          <RecordingBars color={c.muted} />
          {faces.voice}
          <View style={[styles.people, styles.giveWay]}>
            {piece(recorders, [styles.shrink, { maxWidth: fit.recorders }], measure("recorders"))}
            {piece(recording)}
          </View>
        </View>
      ) : null}
    </Animated.View>
  );
}

/** One round of the typing dots and of the recording bars. */
const MARK_ROUND_MS = 1200;
/** A bar at rest: a third of its height. */
const BAR_LOW = 0.34;
/** A bar's round: tallest at 40% of it, low again by 80% (the web's `.ac-typing__bars`). */
const BAR_ROUND = css.keyframes({
  0: { transform: [{ scaleY: BAR_LOW }] },
  0.4: { transform: [{ scaleY: 1 }] },
  0.8: { transform: [{ scaleY: BAR_LOW }] },
  1: { transform: [{ scaleY: BAR_LOW }] },
});
/** A dot's round: up and bright at 30% of it, back down by 60% (the web's `.ac-typing__dots`). */
const DOT_ROUND = css.keyframes({
  0: { opacity: 0.4, transform: [{ translateY: 0 }] },
  0.3: { opacity: 1, transform: [{ translateY: -2 }] },
  0.6: { opacity: 0.4, transform: [{ translateY: 0 }] },
  1: { opacity: 0.4, transform: [{ translateY: 0 }] },
});
/**
 * Mark `i` of a row trails the one before it by `lag` ms. The delay is negative (a round earlier), so every mark starts
 * at once, already that far into its round: none sits still at mount waiting for its turn.
 */
const trailing = (i: number, lag: number) => i * lag - MARK_ROUND_MS;

/**
 * Three bars rising and falling in turn while someone records a voice message (the web's `.ac-typing__bars`), where
 * the dots are for typing. They loop on the UI thread (a CSS animation: no render per frame while someone records),
 * hold while the screen isn't showing (`LivePause`), and stand still with Reduce Motion.
 */
function RecordingBars({ color }: { color: string }) {
  const reduced = useReducedMotion();
  const paused = useLivePaused();
  return (
    <View style={styles.bars} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {[0.34, 0.75, 0.5].map((still, i) => (
        <Animated.View
          key={still}
          style={[
            styles.bar,
            { backgroundColor: color, transform: [{ scaleY: reduced ? still : BAR_LOW }] },
            // Each bar 0.2 s after the one before.
            reduced ? null : loopStyle(BAR_ROUND, MARK_ROUND_MS, "linear", trailing(i, 200), paused),
          ]}
        />
      ))}
    </View>
  );
}

/**
 * Three dots rising in turn while only people type (the web's `.ac-typing__dots`), on the UI thread as the bars are;
 * still with Reduce Motion.
 */
function TypingDots({ color }: { color: string }) {
  const reduced = useReducedMotion();
  const paused = useLivePaused();
  return (
    <View style={styles.dots} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {[0, 1, 2].map((i) => (
        <Animated.View
          key={i}
          style={[
            styles.dot,
            { backgroundColor: color, opacity: 0.4 },
            // Each dot 0.15 s after the one before.
            reduced ? null : loopStyle(DOT_ROUND, MARK_ROUND_MS, "linear", trailing(i, 150), paused),
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  // As wide as the box under it, its edges on the box's, whatever it says: a turning phrase or a face coming and going
  // never moves its edge. Bare, as the return that rests in it (`Returns` `line`).
  dock: { paddingBottom: 6 },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    // One line, a second only for a name that needs it.
    minHeight: 28,
    paddingVertical: 2,
    paddingHorizontal: 8,
    // Nothing clips: the orbit's rings, turned upright, reach past the line's 28 points (the dock's padding takes them).
  },
  stack: { flexDirection: "row", alignItems: "center", flexShrink: 0 },
  // The rings reach past the face into the gap on each side.
  orbit: { marginHorizontal: 6, flexShrink: 0 },
  // What it did so far, under the line's words: the newest last.
  trail: { gap: 2, paddingHorizontal: 8, paddingTop: 2 },
  // Under the words when the orbiting face leads the line: its padding, the face, its margins and the line's gap.
  trailUnderWords: { paddingLeft: 8 + 6 + ORBIT_FACE + 6 + 6 },
  tok: { padding: 1.5, borderRadius: 7 },
  pair: { flexDirection: "row", alignItems: "center", gap: 1 },
  overlap: { marginLeft: -6 },
  dots: { flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 0 },
  dot: { width: 4, height: 4, borderRadius: 2 },
  bars: { flexDirection: "row", alignItems: "center", gap: 2, height: 12, flexShrink: 0 },
  bar: { width: 3, height: 12, borderRadius: 1.5, opacity: 0.7 },
  // Who records, as a group: the mark, the faces, then the words, keeping their width as who types does (the agents'
  // words give way first), the names alone ending in "…". Who types beside them is a group too.
  group: { flexDirection: "row", alignItems: "center", gap: 6, maxWidth: "100%" },
  // Inside each piece's own width, which never grows past the line.
  beforeMark: { paddingRight: 4 },
  afterWords: { paddingLeft: 4 },
  giveWay: { flexShrink: 1, minWidth: 0 },
  // Beside who types, who records goes on a line of their own when one is short of room: every verb stays whole.
  wrap: { flexWrap: "wrap" },
  // The words take what the marks and the stop leave, so the globe after them stays put while they turn. Who is
  // typing keeps its width: the agents' words before it end in "…" first (the " · " after them goes with their
  // last bit, so it never opens the line), then the names, never what they do.
  words: { flex: 1, flexDirection: "row" },
  agents: { flexDirection: "row", flexShrink: 1, overflow: "hidden" },
  people: { flexDirection: "row", maxWidth: "100%" },
  shrink: { flexShrink: 1 },
  // One agent: its name, then its step, which gives way first (cut with "…", the line's label says it whole).
  awayStep: { flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1, minWidth: 0 },
  // Never a share of the step's shrinking: that wrapped it onto a second line and back as the step turned.
  awayName: { flexShrink: 0, maxWidth: "50%" },
  // Its own width, so the time follows the words instead of floating after a fixed gap.
  barStep: { flexShrink: 1000, minWidth: 0 },
  // Who types beside it, after its time: it gives way before the step does, its names first.
  also: { flexDirection: "row", flexShrink: 4, minWidth: 0 },
  wordsTap: { flexDirection: "row", alignItems: "center", gap: 6, flex: 1, minWidth: 0 },
  browser: {
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    width: 22,
    height: 22,
    borderRadius: 999,
  },
  ink: { fontWeight: "600" },
  took: { fontVariant: ["tabular-nums"] },
  // The calls' pixels keep their size: the words before them give way.
  steps: { flexDirection: "row", alignItems: "center", gap: 2, flexShrink: 0 },
  step: { width: 4, height: 4 },
  // "Ver" after a hand-off's time: the two agents' talk.
  see: { marginLeft: 8, justifyContent: "center" },
  seeText: { fontWeight: "600" },
  clock: { fontWeight: "600", fontVariant: ["tabular-nums"] },
  pressed: { opacity: 0.6 },
  sep: { width: StyleSheet.hairlineWidth * 2, height: 16, marginLeft: 4, marginRight: 2 },
  // Last in the pill, in its round end: 2px from the edge all around.
  stop: { width: 24, height: 24, marginRight: -6, borderRadius: 999, alignItems: "center", justifyContent: "center" },
  stopping: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 4 },
});
