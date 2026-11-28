import { formatTimeLeft } from "@agenteschat/client/lib/actions";
import { usePreventRemove } from "expo-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Platform,
  RefreshControl,
  StyleSheet,
  type TextInputProps,
  View,
  type ViewStyle,
} from "react-native";
import { KeyboardAwareScrollView, KeyboardController, KeyboardStickyView } from "react-native-keyboard-controller";
import { LayoutAnimationConfig } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, GroupedList, GroupedRow, type HeaderAction, type IconName, Locked, Text, useToast } from "@/ui";
import { KeyboardBar, TOOLBAR_HEIGHT } from "@/ui/auth/AuthScaffold";
import { useReadableSide } from "@/ui/pane";
import { useColors, useNow, usePullRefresh } from "../shared/hooks";
import { showActionSheet } from "../shared/PickerSheet";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { BottomBar, copyText, type HeaderWordAction, MONO, PushedHeader, successHaptic } from "../shared/parts";
import { useSplitGuard } from "../shared/SplitPanes";

/**
 * What the workspace's settings screens share (each one a screen pushed with the platform's push, as Você's): the
 * page on the grouped gray under the native bar, the system's action list and confirmation (the web's menus and
 * dialogs), a form's guard against leaving with changes and its return key, a terminal command with Copiar, and a
 * progress bar.
 */

/** How long "Copiado" stays on a command's copy row. */
const COPIED_MS = 1800;
/** Between a focused field and the keyboard when the page scrolls it into view. */
const FIELD_CLEARANCE = 24;

/**
 * A settings screen: the native bar (back, the title, a line under it, a word that saves on the right) over the
 * grouped gray, which scrolls under it. A focused field scrolls clear of the keyboard on both systems (the keyboard
 * library's scroll view: with its provider on, Android no longer resizes the window by itself), and a drag down the
 * page takes the keyboard with it. `largeTitle`: a list of places to go (the workspace's settings, Skills, the audit)
 * takes the pushed lists' large title instead (`PushedLargeTitle`, as Drive and Connectors), with no word in the bar
 * and no form under it. `onRefresh`: a list read from the server is read again on a pull.
 */
export function SettingsPage(props: SettingsPageProps) {
  return props.largeTitle ? <LargeTitlePage {...props} /> : <CompactPage {...props} />;
}

interface SettingsPageProps {
  title: string;
  /** What the page is about (whose role, which channel): the bar's line under its title. */
  subtitle?: string | undefined;
  action?: HeaderWordAction;
  /** An icon button on the bar's right in place of a word. Prefer `actions`. */
  right?: ReactNode;
  /** The bar's buttons as the system's own (Convites' "+", a "…" menu): `PushedHeader`'s `actions`. */
  actions?: HeaderAction[];
  /** The action's word is saving: a spinner in its place, the page locked under it. */
  busy?: boolean;
  /** The page's form is sending: its controls are off, the page still scrolls. */
  locked?: boolean;
  /** The workspace is being deleted and this page would change it (`settingsFrozen`): greyed out, as on the web. */
  frozen?: boolean;
  /** A form of several fields: the system's bar over the keyboard (‹ › between them, Done), the page clear of it. */
  toolbar?: boolean;
  /** The page's one main action, docked under it ("Done" at the end of a guide); it rides over the keyboard. */
  bottom?: ReactNode;
  /** A list screen: the system's large title (drawn on Android), folding into the bar as the list scrolls. */
  largeTitle?: boolean;
  /** A large-title list with a search: the list makes room for the keyboard (a form page always does). */
  keyboard?: boolean;
  /** A pull reads the page's lists again; the spinner shows only for the person's own pull (`usePullRefresh`). */
  onRefresh?: () => Promise<unknown>;
  children?: ReactNode;
}

const NOTHING_TO_READ = () => Promise.resolve();

/** The page's pull to refresh, when it reads something from the server (`onRefresh`). */
function usePageRefresh(onRefresh: (() => Promise<unknown>) | undefined) {
  const pull = usePullRefresh(onRefresh ?? NOTHING_TO_READ);
  return onRefresh ? <RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} /> : undefined;
}

/** A list of the workspace's settings under a large title: no subtitle, word or docked action (those are forms'). */
function LargeTitlePage({
  title,
  right,
  actions,
  locked = false,
  frozen = false,
  keyboard = false,
  onRefresh,
  children,
}: SettingsPageProps) {
  const refreshControl = usePageRefresh(onRefresh);
  return (
    <PushedLargeTitle
      title={title}
      grouped
      keyboard={keyboard}
      {...(refreshControl ? { refreshControl } : {})}
      {...(actions ? { actions } : right ? { right } : {})}
    >
      <View style={styles.body}>
        <Locked when={locked || frozen} readable={frozen && !locked}>
          <LayoutAnimationConfig skipEntering>{children}</LayoutAnimationConfig>
        </Locked>
      </View>
    </PushedLargeTitle>
  );
}

function CompactPage({
  title,
  subtitle,
  action,
  right,
  actions,
  busy = false,
  locked = false,
  frozen = false,
  toolbar = false,
  bottom,
  onRefresh,
  children,
}: SettingsPageProps) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const side = useReadableSide();
  const refreshControl = usePageRefresh(onRefresh);
  // The docked action rides over the keyboard (over the system's bar too, with a form's ‹ ›): what it covers there
  // (its height less the home indicator's room, which drops behind the keyboard) is kept clear of a focused field.
  const [dockHeight, setDockHeight] = useState(0);
  const toolbarRoom = toolbar ? TOOLBAR_HEIGHT : 0;
  const docked = bottom ? Math.max(0, dockHeight - insets.bottom) : 0;
  const bar = toolbarRoom + docked;
  return (
    <View style={[styles.fill, { backgroundColor: c.grouped }]}>
      <PushedHeader
        title={title}
        subtitle={subtitle}
        solid={false}
        grouped
        {...(busy
          ? { right: <ActivityIndicator color={c.muted} /> }
          : action
            ? { action }
            : actions
              ? { actions }
              : right
                ? { right }
                : {})}
      />
      <KeyboardAwareScrollView
        style={styles.fill}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        bottomOffset={bar + FIELD_CLEARANCE}
        extraKeyboardSpace={toolbarRoom}
        {...(refreshControl ? { refreshControl } : {})}
        // A docked action holds the home indicator's room itself.
        // On a large screen the form keeps to the readable column (ADR 0212).
        contentContainerStyle={[
          styles.body,
          { paddingHorizontal: BODY_SIDE + side, paddingBottom: bottom ? 24 : 24 + insets.bottom },
        ]}
      >
        {/* What is there as the screen opens doesn't fade in; what loads while it is watched does (`Loaded`). */}
        <Locked when={locked || busy || frozen} readable={frozen && !locked && !busy}>
          <LayoutAnimationConfig skipEntering>{children}</LayoutAnimationConfig>
        </Locked>
      </KeyboardAwareScrollView>
      {bottom ? (
        <KeyboardStickyView
          offset={{ opened: insets.bottom - toolbarRoom }}
          onLayout={(e) => setDockHeight(e.nativeEvent.layout.height)}
        >
          <BottomBar bottom={insets.bottom}>{bottom}</BottomBar>
        </KeyboardStickyView>
      ) : null}
      {toolbar ? <KeyboardBar /> : null}
    </View>
  );
}

/**
 * Leaving a form with changes not saved asks first (back, the edge swipe, a replace), as editing an agent does: the
 * changes go only when the person says so. In a split's detail pane (ADR 0212) another row of the list replacing the
 * form asks the same (`useSplitGuard`). Returns `leave`, which a finished save calls before it goes on, so it isn't
 * asked about what it just saved.
 */
export function useUnsavedGuard(dirty: boolean): () => void {
  const { t } = useTranslation();
  const leaving = useRef(false);
  const ask = (repeat: () => void) =>
    Alert.alert(t("mobile.agentEdit.discardTitle"), t("mobile.agentEdit.discardText"), [
      { text: t("mobile.agentEdit.keepEditing"), style: "cancel" },
      { text: t("mobile.agentEdit.discard"), style: "destructive", onPress: repeat },
    ]);
  usePreventRemove(dirty, ({ repeat }) => {
    if (leaving.current) return repeat();
    ask(repeat);
  });
  useSplitGuard(dirty ? (go) => (leaving.current ? go() : ask(go)) : null);
  return () => {
    leaving.current = true;
  };
}

/**
 * A form field's return key that moves to the next field and keeps the keyboard up. The next one on screen, so fields
 * that come and go with a choice need no refs; the form's last field keeps its own key.
 */
export const NEXT_FIELD = {
  returnKeyType: "next",
  submitBehavior: "submit",
  onSubmitEditing: () => KeyboardController.setFocusTo("next"),
} as const satisfies Pick<TextInputProps, "returnKeyType" | "submitBehavior" | "onSubmitEditing">;

/**
 * Over a photo or a logo while it uploads: the picture dimmed under a spinner, where it changes (a link that only
 * faded said too little). `style`: the picture's own size and corners.
 */
export function Uploading({ style }: { style: ViewStyle }) {
  return (
    <View pointerEvents="none" style={[styles.uploading, style]}>
      <ActivityIndicator color="#ffffff" />
    </View>
  );
}

/**
 * "Resend" under a code typed back, saying how long until another may go: its own clock, so only this button repaints
 * each second while it counts down, never the form around it.
 */
export function ResendCode({
  resendAt,
  disabled = false,
  sending = false,
  onPress,
}: {
  /** When another code may go (ms since the epoch). */
  resendAt: number;
  disabled?: boolean;
  sending?: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const left = Math.max(0, resendAt - Date.now());
  // A repaint every second while it counts down; the time itself is read just above.
  useNow(left > 0 ? 1000 : 60_000);
  return (
    <Button
      variant="ghost"
      size="sm"
      label={left > 0 ? t("proof.resendIn", { time: formatTimeLeft(left) }) : t("proof.resend")}
      disabled={left > 0 || disabled}
      loading={sending}
      onPress={onPress}
    />
  );
}

/** Space above a group that has no header. */
export function Gap() {
  return <View style={styles.gap} />;
}

export interface ActionChoice {
  label: string;
  /** What leads its row. Every choice of a menu has one, or none does. */
  icon?: IconName;
  destructive?: boolean;
  /** The one in use: checked. */
  checked?: boolean;
  onPress: () => void;
}

/**
 * A short menu of actions (the web's "…" menus: Sair / Apagar conta, Tirar foto / Escolher da galeria): the app's own
 * sheet on every system, a title and a list as a conversation's "…" is, never the system's action sheet (a floating
 * stack of buttons that looks like no other part of the app). Picking a value (a person, a level, a language, a
 * time) is `pickOne`'s, with faces, checks and a search.
 */
export function chooseAction(title: string, options: ActionChoice[], cancel: string) {
  if (showActionSheet(title, options)) return;
  // No host mounted (it is at the app's root, so only before the app is up): the system's own.
  if (Platform.OS === "ios") {
    const destructive = options.findIndex((o) => o.destructive);
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title,
        options: [...options.map((o) => o.label), cancel],
        cancelButtonIndex: options.length,
        ...(destructive >= 0 ? { destructiveButtonIndex: destructive } : {}),
      },
      (i) => options[i]?.onPress(),
    );
  } else {
    const buttons = options.map((o) => ({
      text: o.label,
      style: o.destructive ? ("destructive" as const) : undefined,
      onPress: o.onPress,
    }));
    // Android's alert holds three buttons at most: with three choices, a tap outside it cancels.
    Alert.alert(
      title,
      undefined,
      buttons.length < 3 ? [...buttons, { text: cancel, style: "cancel" as const }] : buttons.slice(0, 3),
      { cancelable: true },
    );
  }
}

/** The system's confirmation before something that can't be undone here (the web's confirm dialogs). */
export function confirmAction({
  title,
  text,
  action,
  cancel,
  destructive = true,
  onConfirm,
}: {
  title: string;
  text?: string | undefined;
  action: string;
  cancel: string;
  destructive?: boolean;
  onConfirm: () => void;
}) {
  Alert.alert(title, text, [
    { text: cancel, style: "cancel" },
    { text: action, style: destructive ? "destructive" : "default", onPress: onConfirm },
  ]);
}

/**
 * "Prefiro no Terminal" under a one-click button (the web's fold): the same switch as a command, shown on a tap.
 * `label` names the fold where the command is the way without the app ("Sem o app lá? Use o Terminal").
 */
export function TerminalFallback({ command, label }: { command: string | null; label?: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (!command) return null;
  return (
    <>
      <Gap />
      <GroupedList>
        <GroupedRow
          icon="code"
          label={label ?? t("machines.access.preferTerminal")}
          onPress={() => setOpen((o) => !o)}
        />
      </GroupedList>
      {open ? (
        <>
          <Gap />
          <CommandBlock command={command} />
        </>
      ) : null}
    </>
  );
}

/**
 * A terminal command (or anything to paste), in mono (it is code), and Copiar under it; `copiedTitle`: the toast
 * ("Comando copiado. Cole no Terminal…" by default).
 */
export function CommandBlock({ command, copiedTitle }: { command: string; copiedTitle?: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <GroupedList>
      <View style={styles.command}>
        <Text selectable style={[styles.mono, { color: c.ink }]}>
          {command}
        </Text>
      </View>
      <GroupedRow
        icon={copied ? "check" : "copy"}
        label={copied ? t("common.copied") : t("common.copy")}
        onPress={() =>
          void copyText(command).then((ok) => {
            if (!ok) return;
            successHaptic();
            setCopied(true);
            toast({ title: copiedTitle ?? t("machines.commandCopied"), icon: "copy" });
          })
        }
      />
    </GroupedList>
  );
}

/** How far something went (a copy of files): a sunken track, the part done in ink. */
/** `segments`: `value` split into pieces from the left, each in its color, a hairline of track between them. */
export function Meter({
  value,
  max,
  label,
  segments,
}: {
  value: number;
  max: number;
  label: string;
  segments?: readonly { key: string; value: number; color: string }[];
}) {
  const c = useColors();
  const share = (n: number) => (max > 0 ? Math.min(1, Math.max(0, n / max)) : 0);
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max, now: value }}
      style={[styles.track, segments?.length ? styles.segs : null, { backgroundColor: c.sunken }]}
    >
      {segments?.length ? (
        segments.map((s) => (
          <View key={s.key} style={[styles.seg, { width: `${share(s.value) * 100}%`, backgroundColor: s.color }]} />
        ))
      ) : (
        <View style={[styles.done, { width: `${share(value) * 100}%`, backgroundColor: c.ink }]} />
      )}
    </View>
  );
}

/** A form page's sides on a phone (the readable column's margins add to them on a large screen). */
const BODY_SIDE = 16;

const styles = StyleSheet.create({
  fill: { flex: 1 },
  body: { paddingHorizontal: BODY_SIDE, paddingTop: 4 },
  gap: { height: 14 },
  command: { paddingHorizontal: 14, paddingVertical: 12 },
  mono: { fontFamily: MONO, fontSize: 13, lineHeight: 19 },
  track: { height: 6, borderRadius: 999, overflow: "hidden" },
  done: { height: 6, borderRadius: 999 },
  segs: { flexDirection: "row", gap: 1 },
  seg: { height: 6 },
  uploading: {
    position: "absolute",
    top: 0,
    left: 0,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0, 0, 0, 0.38)",
  },
});
