import { markTerms } from "@agenteschat/client/lib/search-filters";
import * as Clipboard from "expo-clipboard";
import { type NativeStackNavigationOptions, Stack, useIsFocused } from "expo-router";
import { memo, type ReactNode, useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Platform, StyleSheet, useWindowDimensions, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { needsHeaderBlur, TAB_BADGE } from "@/lib/nav";
import {
  BarPressable,
  Button,
  Count,
  coverBarOptions,
  fonts,
  GROUPED_ROW,
  GroupedList,
  type HeaderAction,
  HeaderCapsule,
  HeaderSlot,
  type HeaderSlotStore,
  haptics,
  Icon,
  type IconName,
  IconTile,
  LivePause,
  RowPressable,
  Text,
  ToggleSwitch,
  textLineOf,
  useHeaderActionOptions,
  useHeaderSlot,
  useScrollUnderPushedOptions,
  useTheme,
} from "@/ui";
import { withAlpha } from "@/ui/palette";
import { usePane, usePaneHeader, useReadableSide } from "@/ui/pane";
import { usePaneBack } from "@/ui/pane-back";
import { useFontScale } from "@/ui/text-scale";
import { leadBox } from "@/ui/type-scale";
import { useBubblePart } from "./bubble-part";
import { useColors } from "./hooks";

/**
 * Small pieces the screens share that the design system doesn't have as
 * primitives: the icon tile, the action list of sheets, the bar of a pushed
 * screen, haptics and the clipboard.
 */

/** Mentions of me not read yet: the tab bar's red badge, as a channel's on the web. Nothing at zero. */
export function MentionCount({ count }: { count: number }) {
  const { t } = useTranslation();
  if (count <= 0) return null;
  return (
    <View accessible accessibilityLabel={t("shell.unreadMentions", { count })}>
      <Count value={count} max={99} inverted fill={TAB_BADGE.background} color={TAB_BADGE.text} />
    </View>
  );
}

/**
 * The rounded square with an icon (channels, threads, missions, sheet titles): the system Settings' tile (`IconTile`,
 * the subject's color, the symbol in white). With `children` (a face, a mark of the caller's own), a neutral tile.
 */
export function Tile({ icon, size = 36, children }: { icon?: IconName; size?: number; children?: ReactNode }) {
  const c = useColors();
  if (icon && children == null) return <IconTile icon={icon} size={size} />;
  return (
    <View
      style={[
        styles.tile,
        { width: size, height: size, borderRadius: Math.round(size * 0.3), backgroundColor: c.sunken },
      ]}
    >
      {children}
    </View>
  );
}

export interface ActionItem {
  key: string;
  icon?: IconName;
  leading?: ReactNode;
  label: string;
  /** Search words lit in the label, as the web's results mark them. */
  marks?: readonly string[];
  hint?: string;
  /** The label and the hint each on one line, cut with an ellipsis (a pick list of names and roles). */
  oneLine?: boolean;
  /** A slash command shown on the right (`/mission`), in mono: it is code. */
  code?: string;
  trailing?: ReactNode;
  /** A switch on the right ("Seguir"): the row reads as one, checked or not. */
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onPress?: () => void;
}

/** An action's icon: the system's symbol at about the label's size (17 points), alone, as the system's menus show it. */
const ACTION_GLYPH = 24;

/**
 * The list of actions in a sheet, a GroupedList (sheets sit on the grouped gray): an icon or a face in GroupedRow's
 * 36 pt column, the label, a hint under it; the text and the hairline above start together at 64.
 */
export function ActionList({ items }: { items: ActionItem[] }) {
  return (
    <GroupedList>
      {items.map((it) => (
        // `leading`, as a GroupedRow's: GroupedList starts the hairline after its column.
        <ActionRow key={it.key} item={it} leading={Boolean(it.leading ?? it.icon)} />
      ))}
    </GroupedList>
  );
}

/**
 * One action, on a GroupedRow's numbers: 16 pt sides, the 36 pt leading column, 12 apart, 52 tall at least. Drawn
 * again only when its item changes: a list that keeps its items (the search's results) redraws none of them.
 */
const ActionRow = memo(function ActionRow({ item: it }: { item: ActionItem; leading: boolean }) {
  const c = useColors();
  const fontScale = useFontScale();
  const leading =
    it.leading ?? (it.icon ? <Icon name={it.icon} size={ACTION_GLYPH} color={it.danger ? c.danger : c.muted} /> : null);
  const line = textLineOf("body", fontScale);
  // A hint that may wrap: the icon and what is on the right stay on the label's line, not the row's middle.
  const tall = Boolean(it.hint) && !it.oneLine;
  const onLine = (size: number) => (tall ? leadBox(line, size) : null);
  const press = it.onPress;
  return (
    <RowPressable
      // A switch answers the finger as it flips (and with its switch, not a lit row), as `GroupedRow`'s does.
      light={it.checked === undefined}
      onPress={
        it.checked !== undefined && press
          ? () => {
              haptics.selection();
              press();
            }
          : press
      }
      disabled={it.disabled || !it.onPress}
      accessibilityRole={it.checked === undefined ? "button" : "switch"}
      {...(it.checked === undefined ? {} : { accessibilityState: { checked: it.checked } })}
      accessibilityLabel={it.hint ? `${it.label}. ${it.hint}` : it.label}
      style={[styles.action, tall && styles.actionTall, it.disabled && { opacity: 0.4 }]}
    >
      {leading ? (
        <View style={styles.actionLead}>
          {tall && !it.leading ? <View style={onLine(ACTION_GLYPH)}>{leading}</View> : leading}
        </View>
      ) : null}
      <View style={styles.actionText}>
        <Text variant="body" tone={it.danger ? "danger" : "ink"} {...(it.oneLine ? { numberOfLines: 1 } : {})}>
          {it.marks
            ? markTerms(it.label, it.marks).map((part, k) =>
                part.mark ? (
                  // biome-ignore lint/suspicious/noArrayIndexKey: segments of one fixed text
                  <Text key={k} variant="body" style={{ backgroundColor: withAlpha(c.info, 0.22) }}>
                    {part.text}
                  </Text>
                ) : (
                  part.text
                ),
              )
            : it.label}
        </Text>
        {it.hint ? (
          <Text variant="footnote" tone="faint" {...(it.oneLine ? { numberOfLines: 1 } : {})}>
            {it.hint}
          </Text>
        ) : null}
      </View>
      {it.code ? (
        <View style={tall ? [styles.onLine, { minHeight: line.height }] : null}>
          <Text style={[styles.mono, { color: c.faint }]}>{it.code}</Text>
        </View>
      ) : null}
      {it.trailing ? (
        <View style={tall ? [styles.onLine, { minHeight: line.height }] : null}>{it.trailing}</View>
      ) : null}
      {it.checked === undefined ? null : (
        // Taller than the label's line: its middle on the line's, as `GroupedRow`'s switch.
        <View style={tall ? { marginTop: line.middle - 14, marginBottom: line.height - line.middle - 14 } : null}>
          <ToggleSwitch value={it.checked} />
        </View>
      )}
    </RowPressable>
  );
});

const IOS = Platform.OS === "ios";
/** iOS 26's Liquid Glass bar (a saving word there is a prominent button). */
const liquidGlass = IOS && !needsHeaderBlur(Platform.OS, Platform.Version);

export interface PushedHeaderProps {
  title?: ReactNode;
  /**
   * A line under the title (the step, the board, who sent a file), drawn with it in a view of our own: on iOS kept
   * clear of the wider side (`titleSide`) so the bar centres both instead of pushing them against the back button,
   * on Android at the bar's start.
   */
  subtitle?: string | undefined;
  /** The line's colour (a dropped connection's warning); muted when not given. */
  subtitleColor?: string | undefined;
  right?: ReactNode;
  action?: HeaderWordAction;
  /**
   * Buttons on the right as the system's own bar buttons (iOS; a `menu` opens the system's menu from the button), our
   * icon buttons in a capsule on Android (`useHeaderActionOptions`). In place of `right`.
   */
  actions?: HeaderAction[];
  /**
   * Our own view first among `actions`, in their group: a count beside a mark, which has no system button
   * (`useHeaderActionOptions`).
   */
  lead?: ReactNode;
  /** Over a sky cover: a clear bar, the back button over the art. */
  plate?: boolean;
  solid?: boolean;
  /** The screen sits on the grouped gray (the bar matches it where it is opaque: Android). */
  grouped?: boolean;
  /**
   * iOS: the system's large title (a string `title`), over a scroll view that is the screen's first child: it folds
   * into the bar as the list scrolls, and the bar takes the system's material over what passes under it.
   */
  largeTitle?: boolean;
}

/**
 * The bar of a pushed screen, as the native header (react-native-screens): the system back chevron with
 * the edge swipe, a title (the system's own when it is words: centred and shortened by it) with its line under it,
 * an action on the right. Renders nothing itself; it sets the screen's header options, so screens keep calling it
 * where the bar used to be.
 * The bar is opaque by default (`solid`, content lays out below it); `solid={false}` makes content scroll
 * under it (glass on iOS 26, blur before; the screen's scroll view needs
 * `contentInsetAdjustmentBehavior="automatic"`); `plate` puts a clear bar over a full-bleed cover. On Android
 * the right actions float in a `HeaderCapsule` and the back button is a round plate (`usePushedOptions`);
 * its opaque bar takes the screen's color (`grouped`), so no band shows above a grouped gray screen.
 * `action` is a word on the right that saves (Conta's "OK"): the system's bar button on iOS (prominent on
 * iOS 26), our small primary button on Android.
 * Inside a pane of a two-pane layout (ADR 0212: the iPhone Duo's inner display) the same title, line and buttons are
 * the pane's own bar (`PaneHeader`), and the navigator's options are left alone.
 */
export function PushedHeader(props: PushedHeaderProps) {
  return usePane() ? <PaneHeader {...props} /> : <NativeHeader {...props} />;
}

/**
 * `PushedHeader` in a pane (ADR 0212): its title, line and buttons in the pane's bar, our own views (`usePaneHeader`),
 * with no back button in a detail pane: the list it was opened from stands beside it. A pushed screen's list (You, the
 * workspace's settings) has the way back its hidden bar had (`usePaneBack`). Nothing of its own in the screen either. A
 * clear bar (`plate`: a cover, a conversation) floats over the screen, which keeps its room under it as under the
 * navigator's (`useHeaderHeight` is the pane bar's height); any other stands above the screen in its color, so content
 * that left its top room to the system's insets lays out below it.
 */
function PaneHeader({
  title,
  right,
  action,
  plate = false,
  grouped = false,
  actions,
  lead,
  subtitle,
  subtitleColor,
}: PushedHeaderProps) {
  const { colors } = useTheme();
  const back = usePaneBack();
  const leftActions: HeaderAction[] | undefined = back
    ? [{ icon: "back", sf: "chevron.left", label: back.label, onPress: back.onPress }]
    : undefined;
  usePaneHeader({
    title,
    subtitle,
    subtitleColor,
    right,
    lead,
    actions,
    word: action,
    leftActions,
    over: plate,
    tone: grouped ? colors.grouped : colors.bg,
  });
  return null;
}

/** `PushedHeader` as the navigator's bar: the screen's header options. */
function NativeHeader({
  title,
  right,
  action,
  plate = false,
  solid = true,
  grouped = false,
  largeTitle = false,
  actions,
  lead,
  subtitle,
  subtitleColor,
}: PushedHeaderProps) {
  const { colors } = useTheme();
  const scrollUnder = useScrollUnderPushedOptions();
  const barTone = grouped && Platform.OS === "android" ? colors.grouped : null;
  const text = typeof title === "string" ? title : "";
  const titleNode = useHeaderSlot(typeof title === "string" ? null : title);
  const rightNode = useHeaderSlot(right);
  // The bar of the navigator the app uses has no subtitle: a title with a line is drawn, both, in a view of our own.
  const line = subtitle || undefined;
  // Words are the system's own title; a view of our own (a pill, a fading name, a segmented control) is ours, and so
  // are words with a line under them.
  const custom = (title != null && typeof title !== "string") || line !== undefined;
  // What stands on the right, which a drawn title and its line keep clear of on both sides.
  const rightCount = (actions?.length ?? 0) + (lead != null ? 1 : 0) + (right ? 1 : 0);
  const hasRight = Boolean(right);
  // The action's press always reaches its latest handler; the options change only with its word and state.
  const press = useRef(action?.onPress);
  useLayoutEffect(() => {
    press.current = action?.onPress;
  });
  const word = action?.label ?? null;
  const wordOff = action?.disabled ?? false;
  const wordOpens = action?.opens ?? false;
  const { width } = useWindowDimensions();
  const fontScale = useFontScale();
  // iOS: words too long to centre between a wide right side (a word beside a button, several buttons) and the back
  // button start by the back button, as the system lays out a title that can't be centred. Centred on the screen they
  // sat against that side's buttons, far from the back button. A short one ("Você" beside "Editar") stays the system's
  // own, centred. Not a large title (the system draws it), not on Android (the bar's start already).
  const leading =
    IOS &&
    !custom &&
    !largeTitle &&
    text !== "" &&
    titleSide(word, rightCount) > LEADING_FROM &&
    !titleFitsCentred(text, titleSide(word, rightCount), width, fontScale);
  const actionOptions = useHeaderActionOptions({ right: actions, lead });
  const hasActions = (actions?.length ?? 0) > 0 || lead != null;
  // Stable options: `setOptions` runs when the title or the presence of actions change, not on
  // every render of the screen (a conversation re-renders while agents stream).
  const options = useMemo<NativeStackNavigationOptions>(
    () => ({
      ...(plate ? coverBarOptions : solid ? {} : scrollUnder),
      ...(barTone && !plate ? { headerStyle: { backgroundColor: barTone } } : null),
      // Said either way: the screen's options merge, so one set without it kept the large title an earlier render
      // turned on (an empty band over a view that draws none, a search that never folded the title away).
      ...(IOS ? { headerLargeTitleEnabled: largeTitle } : null),
      ...(largeTitle && IOS
        ? { headerLargeTitleShadowVisible: false, headerLargeTitleStyle: { color: colors.ink } }
        : null),
      title: text,
      headerTitle: leading
        ? () => <LeadingTitle text={text} side={titleSide(word, rightCount)} />
        : custom
          ? () => (
              <HeaderTitle
                text={line !== undefined ? text : ""}
                node={titleNode}
                line={line}
                lineColor={subtitleColor}
                side={line !== undefined ? titleSide(word, rightCount) : word !== null ? 100 : 75}
              />
            )
          : text,
      ...(word !== null && IOS
        ? {
            unstable_headerRightItems: () => [
              {
                type: "button" as const,
                label: word,
                accessibilityLabel: word,
                variant: wordVariant(wordOpens),
                disabled: wordOff,
                onPress: () => press.current?.(),
              },
            ],
          }
        : // Said either way, as the large title: a screen's options merge, so a bar that drops its system buttons for
          // `right` would keep them from the earlier options, and they hide `right` on iOS.
          IOS
          ? { unstable_headerRightItems: undefined }
          : null),
      headerRight: hasRight
        ? () => (
            <BarPressable>
              <View style={styles.headerRight}>
                <HeaderCapsule>
                  <HeaderSlot slot={rightNode} />
                </HeaderCapsule>
              </View>
            </BarPressable>
          )
        : word !== null && !IOS
          ? () => (
              <View style={styles.headerRight}>
                <Button
                  size="sm"
                  variant={wordOpens ? "secondary" : "primary"}
                  label={word}
                  disabled={wordOff}
                  onPress={() => press.current?.()}
                />
              </View>
            )
          : undefined,
      ...(hasActions ? withWord(actionOptions, word, wordOff, wordOpens, () => press.current?.()) : null),
    }),
    [
      hasActions,
      actionOptions,
      plate,
      solid,
      scrollUnder,
      barTone,
      largeTitle,
      colors.ink,
      text,
      custom,
      leading,
      line,
      subtitleColor,
      rightCount,
      titleNode,
      hasRight,
      rightNode,
      word,
      wordOff,
      wordOpens,
    ],
  );
  // Nothing of its own in the screen, only its options: the navigator finds a screen's list through its first
  // children (to fold a large title, to turn the bar to glass as the list scrolls under it), and a view placed here
  // would be the first one.
  return <Stack.Screen options={options} />;
}

/**
 * How far a drawn title and its line keep from each edge, the wider side's room, so the bar can centre them: the back
 * button (a 44-point circle) on the left; on the right a word's capsule (about 9 points a letter and 32 of padding)
 * and 44 points a button; the bar's 16-point margin and 8 of air before the title on both.
 */
const titleSide = (word: string | null, buttons: number) => {
  const right = (word ? 32 + word.length * 9 + (buttons > 0 ? 8 : 0) : 0) + 44 * buttons;
  return 16 + Math.max(44, right) + 8;
};

/**
 * Whether the bar's title fits centred between its two sides (`side`, the wider one's), at the bar's 17 points
 * (about 9 a letter) scaled with the person's text size.
 */
export const titleFitsCentred = (text: string, side: number, width: number, fontScale = 1) =>
  text.length * 9 * fontScale <= width - 2 * side;

/** The system's bar button for a word: plain when it opens a screen, filled (prominent on iOS 26) when it saves. */
const wordVariant = (opens: boolean) =>
  opens ? ("plain" as const) : liquidGlass ? ("prominent" as const) : ("done" as const);

/** The back button's side (`titleSide` with nothing on the right). */
const BACK_SIDE = titleSide(null, 0);
/** Past this the right side outweighs the back button: more than one button, or a word with one. */
const LEADING_FROM = BACK_SIDE + 40;

/**
 * A title in words where the right side is wide (`leading`): nearly as wide as the room between the back button and
 * that side (8 points short, so the bar never squeezes it), too wide to centre, so the bar lays it by the back
 * button, the words at its start.
 */
function LeadingTitle({ text, side }: { text: string; side: number }) {
  const { width } = useWindowDimensions();
  return (
    <View style={{ width: Math.max(0, width - BACK_SIDE - side - 8) }}>
      <Text variant="body" numberOfLines={1} accessibilityRole="header" style={styles.titleText}>
        {text}
      </Text>
    </View>
  );
}

/**
 * A word and buttons together on a bar (a task's "Concluir" beside its "…"): the word at the bar's end, the buttons
 * before it (the system's own on iOS; on Android our capsule, then the word's button).
 */
function withWord(
  opts: NativeStackNavigationOptions,
  word: string | null,
  disabled: boolean,
  opens: boolean,
  onPress: () => void,
): NativeStackNavigationOptions {
  if (word === null) return opts;
  if (IOS) {
    const items = opts.unstable_headerRightItems;
    return {
      ...opts,
      unstable_headerRightItems: (props) => [
        {
          type: "button" as const,
          label: word,
          accessibilityLabel: word,
          variant: wordVariant(opens),
          disabled,
          onPress,
        },
        ...(items?.(props) ?? []),
      ],
    };
  }
  const buttons = opts.headerRight;
  return {
    ...opts,
    headerRight: (props) => (
      <View style={[styles.headerRight, styles.headerWithWord]}>
        {buttons?.(props)}
        <Button
          size="sm"
          variant={opens ? "secondary" : "primary"}
          label={word}
          disabled={disabled}
          onPress={onPress}
        />
      </View>
    ),
  };
}

/** A word on the right of a pushed screen's bar that saves (`PushedHeader`'s `action`). */
export interface HeaderWordAction {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  /**
   * A word that opens another screen rather than saving this one (Você's "Editar", an agent's): the system's plain
   * bar button, as the phone's own apps draw it, not the filled one that saves; our secondary button on Android.
   */
  opens?: boolean;
}

/**
 * A title of our own in the native bar (centered on iOS, leading on Android): a view (the conversation's pill), or the
 * words with their line under them. `side`: the room kept on each side, the wider side's, so iOS centres it instead
 * of pushing it against the back button.
 */
function HeaderTitle({
  text,
  node,
  line,
  lineColor,
  side,
}: {
  text: string;
  node: HeaderSlotStore;
  line?: string | undefined;
  lineColor?: string | undefined;
  side: number;
}) {
  const { width } = useWindowDimensions();
  const c = useColors();
  return (
    <View style={[styles.headerTitle, { maxWidth: width - 2 * side }]}>
      {text ? (
        <Text variant="body" numberOfLines={1} style={styles.titleText}>
          {text}
        </Text>
      ) : (
        // A title of our own is pressable (the conversation's pill): its tap is its, not the bar's scroll to top.
        <BarPressable>
          <HeaderSlot slot={node} />
        </BarPressable>
      )}
      {line ? (
        <Text variant="caption" numberOfLines={1} style={{ color: lineColor ?? c.muted }}>
          {line}
        </Text>
      ) : null}
    </View>
  );
}

export { goBack } from "@/ui/navigation";

/**
 * `fn` as of the last render, behind a function that never changes: a memoized row it is handed to isn't redrawn
 * because its parent made a new one.
 */
export function useLatest<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []);
}

/** A light tap under the thumb (long press, reactions, picks). */
export const tapHaptic = () => haptics.light();

/** Done: approved, sent. */
export const successHaptic = () => haptics.success();

/** Didn't work: a connection that failed. */
export const errorHaptic = () => haptics.error();

/** Puts a text on the clipboard; resolves false when the system refused. */
export function copyText(text: string): Promise<boolean> {
  return Clipboard.setStringAsync(text).then(
    (ok) => ok !== false,
    () => false,
  );
}

/** Code only (branches, commands). */
export const MONO = fonts.mono;

const LOADED_IN = FadeIn.duration(200);

/**
 * What comes in while the screen is watched (what it waited for, in its spinner's place; another tab's rows): it fades
 * in. The page holds it in a `LayoutAnimationConfig skipEntering` (`SettingsPage`, the account pages' `Page`), so what
 * had loaded before the screen opened is simply there; so is everything with reduced motion.
 */
export function Loaded({ children }: { children: ReactNode }) {
  const { reducedMotion } = useTheme();
  return <Animated.View entering={reducedMotion ? undefined : LOADED_IN}>{children}</Animated.View>;
}

/** A screen's one action, pinned under its scroll over the home indicator: always at hand, however long the list. */
export function BottomBar({ bottom, children }: { bottom: number; children: ReactNode }) {
  const c = useColors();
  // On a large screen its action keeps to the page's readable column (ADR 0212).
  const side = useReadableSide();
  return (
    <View
      style={[
        styles.bar,
        {
          paddingHorizontal: 16 + side,
          paddingBottom: bottom + 10,
          backgroundColor: c.grouped,
          borderTopColor: c.line2,
        },
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { paddingHorizontal: 16, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth },
  tile: { alignItems: "center", justifyContent: "center" },
  action: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: GROUPED_ROW.minHeight,
    paddingHorizontal: GROUPED_ROW.padX,
    paddingVertical: GROUPED_ROW.padY,
  },
  // A wrapping hint: the label starts where a one-line row's does (its 22 points centred in 52), as GroupedRow's.
  actionTall: { alignItems: "flex-start", paddingVertical: GROUPED_ROW.tallPadY },
  onLine: { justifyContent: "center" },
  // GroupedRow's leading column: the text starts where GroupedList's hairline does.
  actionLead: { width: GROUPED_ROW.lead, alignItems: "center", justifyContent: "center" },
  actionText: { flex: 1, minWidth: 0 },
  mono: { fontFamily: MONO, fontSize: 13 },
  headerTitle: { alignItems: Platform.OS === "ios" ? "center" : "flex-start", minWidth: 0 },
  titleText: { fontWeight: "600" },
  headerRight: { flexDirection: "row", alignItems: "center" },
  headerWithWord: { gap: 8 },
});

/**
 * A raised, neutral surface (the cards inside messages): raised background, the e1 shadow (e2 for what
 * asks for you: an approval) and lit top edge. Under someone else's words in a conversation of bubbles, the bubble's
 * own fill and no shadow (`BubblePartContext`): the card is a bubble of that message.
 */
export function useSurface(elevation: "e1" | "e2" = "e1") {
  const { colors, shadows } = useTheme();
  const part = useBubblePart();
  return useMemo(
    () =>
      part
        ? { backgroundColor: part.fill, ...part.edge }
        : { backgroundColor: colors.raised, boxShadow: `${shadows[elevation]}, ${shadows.top}` },
    [part, colors.raised, shadows, elevation],
  );
}

/** Agents inside stop moving while the screen is not showing (another screen is on top). */
export function FocusLive({ children }: { children: ReactNode }) {
  const focused = useIsFocused();
  return <LivePause paused={!focused}>{children}</LivePause>;
}
