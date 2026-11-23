import type { Expression } from "@agenteschat/ui/agent/engine";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { KeyboardAwareScrollView, KeyboardToolbar } from "react-native-keyboard-controller";
import Animated, { Easing, FadeIn } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AgentAvatar } from "@/agent/AgentAvatar";
import type { AgentLookInput } from "@/agent/looks";
import type { AgentMode } from "@/agent/poses";
import { Sky, WorkspaceSky } from "@/sky/Sky";
import { usePulse } from "../Skeleton";
import { Text } from "../Text";
import { useTheme } from "../theme";

/**
 * The sky's height under the status bar. One height whatever the keyboard does: these screens keep the keyboard up
 * from the first question to the last, so a sky that gave way to it would jump on every step. `low` for a question
 * that takes two lines (the workspace's name, the team's address).
 */
const SKY = { normal: 130, low: 88 } as const;
/** The agent over the sky's bottom edge, its feet on the text below. */
const AGENT = 96;
const AGENT_OVERLAP = 8;
/** The system bar over the keyboard (`KeyboardToolbar`), as tall as the library draws it. */
export const TOOLBAR_HEIGHT = 42;
/** Between a focused field and the keyboard (or the bar over it) when the page scrolls it into view. */
const FIELD_CLEARANCE = 16;

/**
 * The system's bar over the keyboard: ‹ › between a form's fields (`arrows`) and Done, so the keyboard walks the form
 * instead of closing and reopening on each field, and a keyboard with no return key (a number pad) still closes.
 * Outside any keyboard-avoiding view: it follows the keyboard itself, so it is never lifted twice.
 */
export function KeyboardBar({ arrows = true }: { arrows?: boolean }) {
  const { t } = useTranslation();
  return (
    <KeyboardToolbar>
      {arrows ? <KeyboardToolbar.Prev /> : null}
      {arrows ? <KeyboardToolbar.Next /> : null}
      <KeyboardToolbar.Done text={t("mobile.common.done")} />
    </KeyboardToolbar>
  );
}

/** The app's own agent, on the sky of every screen before the app. */
const APP_AGENT: AgentLookInput = { color: "sky", eyes: "round", id: "agentes" };

/** The text of the screens before the app: centered under the agent (fields and buttons keep the width). */
export const CENTER = { textAlign: "center" } as const;

/** Entering a step: a short ease-out fade, the same curve as the rest of the UI (never ease-in). */
const STEP_IN = FadeIn.duration(220).easing(Easing.bezier(0.23, 1, 0.32, 1));

/** A word joiner after each hyphen inside a word: the large title never breaks "e-mail" across two lines. */
const unbrokenHyphens = (text: string) => text.replace(/([A-Za-zÀ-ÿ])-([A-Za-zÀ-ÿ])/g, "$1-⁠$2");

export interface AuthScaffoldProps {
  /** Absent while the question isn't known yet (a step being read): pulsing bars stand in its place. */
  title?: string;
  subtitle?: string;
  /** The subtitle in ink, semibold: an address or an e-mail the question is about, not a second sentence. */
  subtitleStrong?: boolean;
  /** Where this question stands among several ("1 de 3 · Seu e-mail"), over the title. */
  progress?: string;
  children?: ReactNode;
  footer?: ReactNode;
  /** A new key fades the question in (a screen whose question changes with an answer: sent, approved, expired). */
  stepKey?: string;
  /** The agent works while a request is out ("run": writing dashes), sleeps while nothing answers, and reacts with a face. */
  agentMode?: AgentMode;
  /** Another agent on the sky in the app's place: the first run's right hand, who asks its questions. */
  agent?: AgentLookInput;
  expression?: Expression;
  /** Over the screen and outside the steps, so a step's change never remounts it (the bot check's WebView). */
  overlay?: ReactNode;
  /** A lower sky, for a title that takes two lines. */
  sky?: keyof typeof SKY;
  /** The sky of this server (day on the Cloud, dusk on a team's own) instead of the app's: where a connection leads. */
  skyHost?: string;
  /**
   * Several fields on one screen (name, password, a note): the system's bar over the keyboard with ‹ › between them
   * and Pronto, so the keyboard walks the form instead of closing and reopening on each field.
   */
  toolbar?: boolean;
  /**
   * What stands on the sky's edge instead of the app's agent: an invitation's team (its first agents), so the people
   * who'll work with you are seen before any field. Same overlap as the agent, so the title keeps its place.
   */
  hero?: ReactNode;
}

/**
 * One calm question per screen: a low pixel sky with the agent on its edge, the question as the title, the answer
 * below, the keyboard open from start to end with its return key as the action. Margin 16, rhythm in 8. No back of
 * its own: each step is a screen of its stack, whose clear bar puts the system's back over the sky.
 */
export function AuthScaffold({
  title,
  subtitle,
  subtitleStrong = false,
  progress,
  children,
  footer,
  stepKey,
  agentMode = "idle",
  agent = APP_AGENT,
  expression,
  overlay,
  sky = "normal",
  skyHost,
  toolbar = false,
  hero,
}: AuthScaffoldProps) {
  const { colors, reducedMotion } = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const skyStyle = { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 } as const;
  const bar = toolbar ? TOOLBAR_HEIGHT : 0;
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* The keyboard library's scroll view, on every step and both systems (with its provider on, Android no longer
          resizes the window by itself): a focused field scrolls clear of the keyboard and its bar, wherever it sits.
          "layout" grows a spacer as tall as the keyboard at the end, so the flexible gap above the footer gives way
          and the footer stays over the keyboard, as it did on a screen that shrank. */}
      <KeyboardAwareScrollView
        mode="layout"
        bottomOffset={bar + FIELD_CLEARANCE}
        extraKeyboardSpace={bar}
        keyboardShouldPersistTaps="handled"
        // A drag down the screen takes the keyboard down with the finger, as the system's own forms do.
        keyboardDismissMode="interactive"
        contentContainerStyle={{ flexGrow: 1, paddingBottom: insets.bottom + 16 }}
      >
        <View
          style={{ height: insets.top + SKY[sky], zIndex: 1 }}
          accessibilityLabel={t("mobile.auth.skyLabel")}
          accessibilityRole="image"
        >
          {skyHost ? (
            <WorkspaceSky host={skyHost} fade={0.55} style={skyStyle} />
          ) : (
            <Sky color="sky" depth={0.9} fade={0.55} style={skyStyle} />
          )}
          <View style={{ flex: 1, alignItems: "center", justifyContent: "flex-end", marginBottom: -AGENT_OVERLAP }}>
            {hero ?? <AgentAvatar agent={agent} size={AGENT} mode={agentMode} expression={expression} />}
          </View>
        </View>
        <Animated.View
          key={stepKey}
          entering={reducedMotion ? undefined : STEP_IN}
          style={{ paddingHorizontal: 16, paddingTop: AGENT_OVERLAP + 16, flex: 1 }}
        >
          {progress ? (
            <Text variant="footnote" tone="faint" style={[CENTER, { fontWeight: "600", marginBottom: 8 }]}>
              {progress}
            </Text>
          ) : null}
          {/* Centered, like the agent above it: the screens before the app are one question each. */}
          {title === undefined ? (
            <QuestionBones />
          ) : (
            <Text variant="display" accessibilityRole="header" accessibilityLiveRegion="polite" style={CENTER}>
              {unbrokenHyphens(title)}
            </Text>
          )}
          {subtitle ? (
            <Text
              variant="subhead"
              tone={subtitleStrong ? "ink2" : "muted"}
              numberOfLines={subtitleStrong ? 1 : undefined}
              ellipsizeMode="middle"
              style={[CENTER, { marginTop: 8 }, subtitleStrong ? { fontWeight: "600" } : null]}
            >
              {subtitle}
            </Text>
          ) : null}
          <View style={{ marginTop: 24, gap: 8 }}>{children}</View>
          <View style={{ flex: 1 }} />
          {footer ? <View style={{ marginTop: 24, alignItems: "center", gap: 12 }}>{footer}</View> : null}
        </Animated.View>
      </KeyboardAwareScrollView>
      {overlay}
      {toolbar ? <KeyboardBar /> : null}
    </View>
  );
}

/** Where the question goes while it is read: two soft bars, the title's and its line's, pulsing together. */
function QuestionBones() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const pulse = usePulse();
  const bone = { backgroundColor: colors.sunken, borderRadius: 8, alignSelf: "center" } as const;
  return (
    <Animated.View
      style={[{ gap: 10, paddingVertical: 6 }, pulse]}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={t("mobile.a11y.loading")}
    >
      <View style={[bone, { width: "72%", height: 30 }]} />
      <View style={[bone, { width: "52%", height: 16 }]} />
    </Animated.View>
  );
}
