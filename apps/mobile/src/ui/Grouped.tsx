import { upperFirst } from "@agenteschat/client/lib/format";
import { Children, isValidElement, type ReactNode } from "react";
import { type AccessibilityActionEvent, Pressable, StyleSheet, View } from "react-native";
import Animated, { FadeIn, LayoutAnimationConfig } from "react-native-reanimated";
import { CodeWords } from "./CodeWords";
import { haptics } from "./haptics";
import { Icon, type IconName } from "./Icon";
import { IconTile } from "./IconTile";
import { InfoHint, useInfoHint } from "./InfoHint";
import { MEDIA_ROW } from "./media-row";
import { PRESS_DELAY } from "./PressScale";
import { cardEdge } from "./palette";
import { CheckMark, Disclosure, MenuMark, ROW_MARK } from "./RowMarks";
import { RowPressable } from "./RowPressable";
import { GROUPED_ROW, TOUCH } from "./rhythm";
import { Text, textLineOf } from "./Text";
import { ToggleSwitch } from "./Toggle";
import { useFontScale } from "./text-scale";
import { motion, useTheme } from "./theme";
import { leadBox } from "./type-scale";

/**
 * The leading column of a row with a face or a mark: whatever leads is centered in it. As wide as a framed face (36,
 * the smaller of the two framed sizes), so a face never spills into the gap before the text.
 */
const LEAD = GROUPED_ROW.lead;
/** An icon's tile in a row (IconTile's own size). */
const TILE = 30;
/** The remove ×'s glyph, inside its 44-point button. */
const REMOVE_GLYPH = 16;
/**
 * A list's corner, the current iOS grouped lists' (26, continuous): rounder than before (14), so a list reads as the
 * system's own.
 */
const LIST_CORNER = 26;

/** How far a nested row (`tree`: a phone under its computer) moves in, and where its branch line runs. */
const NEST = 24;
/** The trunk runs down the middle of the lead column, under the computer's portrait. */
const TREE_X = GROUPED_ROW.padX + LEAD / 2;
/** The branch meets a nested row at its 48-point portrait's middle. */
const TREE_ELBOW = GROUPED_ROW.tallPadY + 24;
/** The branch's curve into the nested row; a `mid` row's trunk carries on from where the curve leaves it. */
const TREE_CURVE = 6;

/**
 * A row that comes while the list is on screen fades in where it lands. Nothing slides: a card growing and the groups
 * under it gliding (each view on its own layout transition) jerked the whole form whenever a part of it opened, and a
 * row leaving faded over what had already taken its place. A choice among many opens its own screen instead.
 */
const ROW_IN = FadeIn.duration(motion.fast);

/**
 * Whether a row of the list has a leading column (an icon's tile, a face): read off the row itself, or off the row a
 * swipe (`SwipeRow`) or an opaque view wraps, so a swipeable row keeps its hairline where the others start.
 */
function leads(props: unknown, depth = 0): boolean {
  if (!props || typeof props !== "object" || depth > 2) return false;
  const p = props as { icon?: unknown; leading?: unknown; children?: unknown };
  if (p.icon || p.leading) return true;
  const inner = isValidElement(p.children) ? p.children.props : null;
  return inner ? leads(inner, depth + 1) : false;
}

/** A nested row's hairline starts at its own text, moved in with it. */
const nests = (props: unknown) => {
  const p = props as { tree?: unknown; depth?: unknown } | null;
  return (p?.tree === "mid" || p?.tree === "end" ? NEST : 0) + (typeof p?.depth === "number" ? p.depth * NEST : 0);
};

/**
 * Settings as on the iPhone: grouped inset lists with the system's corner and the cards' light edge (no shadow), so a
 * list and a card read as one family; the system's hairlines inset to the text, a faint semibold header above in its
 * own case (never capitals) and a faint footer below. With no rows it draws nothing, never an empty card.
 */
export function GroupedList({ children }: { children?: ReactNode }) {
  const { colors: c, reducedMotion, scheme } = useTheme();
  const items = Children.toArray(children).filter(isValidElement);
  if (items.length === 0) return null;
  return (
    // The rows it opens with appear with the screen, and when the whole group goes its rows go with it: neither fades.
    <LayoutAnimationConfig skipEntering skipExiting>
      <View style={[styles.list, { backgroundColor: c.raised }, cardEdge(scheme)]}>
        {items.map((child, i) => (
          <Animated.View key={child.key ?? i} entering={reducedMotion ? undefined : ROW_IN}>
            {i > 0 ? (
              <View
                style={[
                  styles.divider,
                  {
                    backgroundColor: c.separator,
                    // A tile and a face share one leading column, so the text and its hairline start at one place.
                    marginLeft:
                      (leads(child.props) ? GROUPED_ROW.padX + LEAD + 12 : GROUPED_ROW.padX) + nests(child.props),
                  },
                ]}
              />
            ) : null}
            {child}
          </Animated.View>
        ))}
      </View>
    </LayoutAnimationConfig>
  );
}

interface GroupedHeaderProps {
  children: string;
  aside?: ReactNode;
  /** An ⓘ after the header's words with what the whole group is for; its text shows under the header. */
  hint?: { name: string; text: string };
}

/** Whether a word has a capital after its first letter, as a name like "iPhone" or "macOS" does. */
const mixedCase = (word: string) => [...word.slice(1)].some((ch) => ch !== ch.toLocaleLowerCase());

/**
 * A header's words as a title: a first letter in lower case becomes a capital (a long date over its day's rows, which
 * some languages write in lower case), unless the first word already mixes cases.
 */
const headerWords = (words: string) => (mixedCase(words.split(/\s/, 1)[0] ?? "") ? words : upperFirst(words));

/** The small header of a group, semibold in its own case, with `aside` at the end of its line: a small text action. */
export function GroupedHeader({ children, aside, hint }: GroupedHeaderProps) {
  if (hint)
    return (
      <HintedHeader aside={aside} hint={hint}>
        {children}
      </HintedHeader>
    );
  return (
    <View style={aside ? styles.headerRow : null}>
      <Text variant="footnote" tone="faint" accessibilityRole="header" style={[styles.header, styles.shrink]}>
        {headerWords(children)}
      </Text>
      {aside ? <View style={styles.headerAside}>{aside}</View> : null}
    </View>
  );
}

/** The header's words and ⓘ on one line, the aside at its end, the hint's text under them inside the header's room. */
function HintedHeader({ children, aside, hint }: GroupedHeaderProps & { hint: { name: string; text: string } }) {
  const info = useInfoHint({ ...hint, variant: "footnote" });
  return (
    <View style={styles.headerRoom}>
      <View style={styles.headerLine}>
        <View style={[styles.headerWords, styles.shrink]}>
          <Text variant="footnote" tone="faint" accessibilityRole="header" style={[styles.headerText, styles.shrink]}>
            {headerWords(children)}
          </Text>
          {info.button}
        </View>
        {aside}
      </View>
      {info.text}
    </View>
  );
}

/** The faint explanation under a group. */
export function GroupedFooter({
  children,
  hint,
}: {
  children: ReactNode;
  /** An ⓘ after the footer's one sentence, with the rest of the explanation; its text shows under the sentence. */
  hint?: { name: string; text: string };
}) {
  const words = typeof children === "string" ? <CodeWords text={children} /> : children;
  if (hint)
    return (
      <View style={styles.footer}>
        <InfoHint {...hint} variant="footnote">
          <Text variant="footnote" tone="faint">
            {words}
          </Text>
        </InfoHint>
      </View>
    );
  return (
    <Text variant="footnote" tone="faint" style={styles.footer}>
      {words}
    </Text>
  );
}

export interface GroupedRowProps {
  label: string;
  /**
   * The label in parts, the ones that matched what was typed in semibold (Novo's filter); the same words as `label`,
   * which still names the row for VoiceOver.
   */
  labelParts?: readonly { text: string; mark?: boolean }[];
  /** Lines the label may take (default 1): a setting's long name beside its switch. 0: as many as it needs. */
  labelLines?: number;
  /** A small line under the label. */
  sub?: string;
  /** Lines the small line may take (default 1). 0: as many as it needs. */
  subLines?: number;
  /** `amber`: the small line says what waits or ends soon (a link that is full, or with less than a day left). */
  subTone?: "faint" | "amber";
  /** Under the small line, in the text column (a second line of facts). */
  below?: ReactNode;
  /** A line of facts under the small line, in faint, read out with the label (a `below` node is not). */
  belowText?: string;
  /** A rounded tile with this icon on the left. */
  icon?: IconName;
  /** On `icon`'s tile in its place: a brand's one-color logo at this address, in the icon's box and color. */
  mark?: string | null;
  /** Anything else on the left (an organization's tile). */
  leading?: ReactNode;
  /** What `leading` says when it is words (an account's place in an order): VoiceOver reads it before the label. */
  leadingSaid?: string;
  /** The value on the right, faint ("Ligadas"). */
  value?: string;
  /** A short fact about the value, after it on its line ("Pela API"); a sentence goes in `sub`. */
  valueNote?: string;
  /** Drawn just before the value (a picked agent's face, a format's glyph). */
  valueLeading?: ReactNode;
  /**
   * The value changes in its row through the system's choice (an action list), not on a screen: the small up-down
   * mark after the value, where a chevron would be.
   */
  menu?: boolean;
  /** A chevron: it opens a screen. */
  chevron?: boolean;
  /** Three dots: it opens a sheet of actions. */
  more?: boolean;
  /** A checkmark: the chosen option. */
  checked?: boolean;
  /** A switch on the right (the whole row toggles). */
  toggle?: boolean;
  danger?: boolean;
  /** The label in faint: something listed that won't count. */
  faint?: boolean;
  disabled?: boolean;
  onPress?: () => void;
  /** An ⓘ right after the label: a tap on it shows the note under the row and never presses the row. */
  hint?: { name: string; text: string };
  /** An × at the row's end that takes it off the list; VoiceOver merges it into the row, so it is the row's action too. */
  remove?: { label: string; onPress: () => void };
  /**
   * Buttons at the row's end in place of its value (a cargo's ▲ ▼ while the order changes), each a finger's 44 points;
   * VoiceOver merges them into the row too, as its actions.
   */
  buttons?: readonly RowButton[];
  /**
   * The web's MediaRow: the lead, the label and what ends it on one line, `sub` and `below` under them at the row's
   * full width. For a row whose lead would otherwise sit beside three lines or more, or beside a label that may wrap:
   * the lead stays on the label's middle, never above a one-line label.
   */
  media?: boolean;
  /**
   * A tree of rows (phones under the computer they're plugged into): `host` draws the trunk down from its portrait,
   * `mid` and `end` move in and branch off it (`end` closes the trunk).
   */
  tree?: "host" | "mid" | "end";
  /** A level in a tree of any depth (a folder picker): moved in a step per level, a thin guide line per level. */
  depth?: number;
  onLongPress?: () => void;
}

export interface RowButton {
  icon: IconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}

/** One row of a group: icon tile, label, the value in faint, a chevron, a check or a switch. */
export function GroupedRow(props: GroupedRowProps) {
  return props.hint ? <HintedRow {...props} hint={props.hint} /> : <Row {...props} />;
}

/** VoiceOver merges a button inside the row's button into it: the row reads the note out with its label. */
function HintedRow({ hint, ...props }: GroupedRowProps & { hint: { name: string; text: string } }) {
  // On the label's first line, also when the label wraps.
  const info = useInfoHint({ ...hint, variant: "body" });
  return (
    <View>
      <Row {...props} said={hint.text} labelAfter={info.button} />
      <View style={[styles.hint, info.open ? styles.hintOpen : null]}>{info.text}</View>
    </View>
  );
}

function Row({
  label,
  labelParts,
  labelLines = 1,
  sub,
  subLines = 1,
  subTone = "faint",
  below,
  belowText,
  icon,
  mark,
  leading,
  leadingSaid,
  value,
  valueNote,
  valueLeading,
  chevron = false,
  menu = false,
  more = false,
  checked,
  toggle,
  danger = false,
  faint = false,
  disabled = false,
  onPress,
  remove,
  buttons,
  media = false,
  tree,
  depth = 0,
  onLongPress,
  said,
  labelAfter,
}: Omit<GroupedRowProps, "hint"> & { said?: string; labelAfter?: ReactNode }) {
  const { colors: c } = useTheme();
  const fontScale = useFontScale();
  const tone = danger ? c.danger : faint ? c.faint : c.ink;
  // A switch answers the finger as it flips, as `Toggle` does.
  const press =
    toggle !== undefined && onPress
      ? () => {
          haptics.selection();
          onPress();
        }
      : onPress;
  // What goes under the label goes under the lead too: the lead, the label and the end share one centred line.
  const flat = media && Boolean(icon || leading);
  const hasUnder = Boolean(sub || below || belowText);
  // Text that can take more than one line: the tile sits at the top and what is on the right stays on the
  // label's line (centred on the whole row it floated between lines). One-line rows keep everything centred.
  const tall = !flat && (labelLines !== 1 || subLines !== 1 || Boolean(below) || Boolean(belowText));
  const line = tall ? textLineOf("body", fontScale) : null;
  const onLine = (size: number) => (line ? [leadBox(line, size), styles.onLine] : null);
  // A tree row's name wraps: its tile stays centred on the first line, as on a one-line row, and takes no more than
  // that line's height, so a one-line tree row is as tall as any other.
  const tileOnLine =
    depth > 0 && line
      ? { marginTop: line.middle - TILE / 2, marginBottom: line.height - line.middle - TILE / 2 }
      : null;
  const lead = (
    <>
      {/* One column for whatever leads (an icon's tile, a 24 to 36 face, a mark): the text, and the hairline above,
          start at 64 in every row, so a list mixing tiles and faces reads as one column. */}
      {icon ? (
        <View style={[styles.lead, tileOnLine]}>
          {/* The system Settings' 30-point tile, in the 36 column: 11 from the row's top and bottom. */}
          <IconTile icon={icon} danger={danger} mark={mark ?? null} />
        </View>
      ) : null}
      {leading ? <View style={styles.lead}>{leading}</View> : null}
    </>
  );
  const labelText = (
    <>
      {labelAfter ? (
        <View style={styles.labelLine}>
          <Text variant="body" numberOfLines={labelLines} style={[styles.shrink, { color: tone }]}>
            {labelParts
              ? labelParts.map((part, i) =>
                  part.mark ? (
                    // biome-ignore lint/suspicious/noArrayIndexKey: segments of one fixed text
                    <Text key={i} variant="body" style={[{ color: tone }, styles.marked]}>
                      {part.text}
                    </Text>
                  ) : (
                    part.text
                  ),
                )
              : label}
          </Text>
          {labelAfter}
        </View>
      ) : (
        <Text variant="body" numberOfLines={labelLines} style={{ color: tone }}>
          {labelParts
            ? labelParts.map((part, i) =>
                part.mark ? (
                  // biome-ignore lint/suspicious/noArrayIndexKey: segments of one fixed text
                  <Text key={i} variant="body" style={[{ color: tone }, styles.marked]}>
                    {part.text}
                  </Text>
                ) : (
                  part.text
                ),
              )
            : label}
        </Text>
      )}
    </>
  );
  const under = (
    <>
      {sub ? (
        <Text
          variant="footnote"
          tone="faint"
          numberOfLines={subLines}
          style={subTone === "amber" ? { color: c.amberInk } : null}
        >
          {sub}
        </Text>
      ) : null}
      {below}
      {belowText ? (
        <Text variant="footnote" tone="faint" numberOfLines={2}>
          {belowText}
        </Text>
      ) : null}
    </>
  );
  const end = (
    <>
      {valueLeading || valueNote ? (
        <View
          style={[
            styles.value,
            styles.valued,
            valueNote ? styles.noted : null,
            line ? { minHeight: line.height } : null,
          ]}
        >
          {valueLeading}
          {value ? (
            <Text variant="body" numberOfLines={1} style={[styles.shrink, { color: c.label2 }]}>
              {value}
            </Text>
          ) : null}
          {valueNote ? (
            <Text variant="footnote" numberOfLines={1} style={{ color: c.label2 }}>
              {valueNote}
            </Text>
          ) : null}
        </View>
      ) : value ? (
        <View style={[styles.value, line ? { minHeight: line.height, justifyContent: "center" } : null]}>
          <Text variant="body" numberOfLines={1} style={[styles.shrink, { color: c.label2 }]}>
            {value}
          </Text>
        </View>
      ) : null}
      {menu ? (
        <View style={onLine(ROW_MARK.menu)}>
          <MenuMark />
        </View>
      ) : null}
      {checked ? (
        <View style={onLine(ROW_MARK.check)}>
          <CheckMark />
        </View>
      ) : null}
      {toggle !== undefined ? (
        <View style={onLine(28)}>
          <ToggleSwitch value={toggle} />
        </View>
      ) : null}
      {chevron ? (
        <View style={onLine(ROW_MARK.disclosure)}>
          <Disclosure />
        </View>
      ) : null}
      {more ? (
        <View style={onLine(20)}>
          <Icon name="more" size={20} color={c.label2} />
        </View>
      ) : null}
      {remove ? (
        // A finger's 44 around the glyph, lit under the finger as the row's other buttons are; it takes the glyph's
        // place in the row (the circle reaches into the row's padding), so the row keeps its height.
        <Pressable
          onPress={remove.onPress}
          unstable_pressDelay={PRESS_DELAY}
          accessibilityRole="button"
          accessibilityLabel={remove.label}
          style={({ pressed }) => [styles.button, styles.remove, pressed ? { backgroundColor: c.sunken } : null]}
        >
          <Icon name="x" size={REMOVE_GLYPH} color={c.faint} />
        </Pressable>
      ) : null}
      {buttons?.length ? (
        <View style={styles.buttons}>
          {buttons.map((b) => (
            <Pressable
              key={b.label}
              onPress={b.onPress}
              disabled={b.disabled}
              unstable_pressDelay={PRESS_DELAY}
              accessibilityRole="button"
              accessibilityLabel={b.label}
              accessibilityState={{ disabled: Boolean(b.disabled) }}
              style={({ pressed }) => [
                styles.button,
                b.disabled ? styles.buttonOff : pressed ? { backgroundColor: c.sunken } : null,
              ]}
            >
              <Icon name={b.icon} size={18} color={c.ink2} />
            </Pressable>
          ))}
        </View>
      ) : null}
    </>
  );
  // VoiceOver reads the row as one: its × and its buttons are its actions.
  const actions = [
    ...(remove ? [{ name: "delete", label: remove.label, run: remove.onPress }] : []),
    ...(buttons ?? []).filter((b) => !b.disabled).map((b) => ({ name: b.label, label: b.label, run: b.onPress })),
  ];
  return (
    <RowPressable
      onPress={press}
      {...(onLongPress ? { onLongPress } : {})}
      // A row that opens a screen stays lit until that screen covers it; a switch's row answers with its switch.
      hold={chevron}
      light={toggle === undefined}
      // A row of buttons stays enabled with nothing to press itself: VoiceOver still offers its actions.
      disabled={disabled || (!onPress && !actions.length)}
      accessibilityRole={toggle !== undefined ? "switch" : "button"}
      // The row is one element to VoiceOver: its own label stands for every word inside, its small line too.
      accessibilityLabel={[leadingSaid, label, sub, belowText, said, value, valueNote].filter(Boolean).join(", ")}
      {...(actions.length
        ? {
            accessibilityActions: actions.map(({ name, label }) => ({ name, label })),
            onAccessibilityAction: (e: AccessibilityActionEvent) =>
              actions.find((a) => a.name === e.nativeEvent.actionName)?.run(),
          }
        : {})}
      accessibilityState={{
        disabled,
        ...(toggle !== undefined ? { checked: toggle } : {}),
        ...(checked !== undefined ? { selected: checked } : {}),
      }}
      style={[
        styles.row,
        flat ? styles.media : tall ? styles.tall : null,
        tree === "mid" || tree === "end" ? styles.nested : null,
        depth > 0 ? { paddingLeft: GROUPED_ROW.padX + depth * NEST } : null,
        // Off, it looks off: a tap that does nothing never looks like one that should.
        disabled ? styles.off : null,
      ]}
    >
      {tree ? <TreeLines tree={tree} color={c.line2} /> : null}
      {Array.from({ length: depth }, (_, i) => (
        <View
          // biome-ignore lint/suspicious/noArrayIndexKey: one guide per level, never reordered
          key={i}
          pointerEvents="none"
          style={[styles.guide, { left: TREE_X + i * NEST, backgroundColor: c.line2 }]}
        />
      ))}
      {flat ? (
        <>
          <View style={styles.mediaHead}>
            {lead}
            <View style={styles.grow}>{labelText}</View>
            {end}
          </View>
          {hasUnder ? <View>{under}</View> : null}
        </>
      ) : (
        <>
          {lead}
          <View style={styles.grow}>
            {labelText}
            {under}
          </View>
          {end}
        </>
      )}
    </RowPressable>
  );
}

/** The trunk and the branch beside a nested row: hairlines in the list's divider color. */
function TreeLines({ tree, color }: { tree: NonNullable<GroupedRowProps["tree"]>; color: string }) {
  if (tree === "host") return <View pointerEvents="none" style={[styles.trunkHost, { backgroundColor: color }]} />;
  return (
    <>
      {tree === "mid" ? <View pointerEvents="none" style={[styles.trunk, { backgroundColor: color }]} /> : null}
      <View pointerEvents="none" style={[styles.branch, { borderColor: color }]} />
    </>
  );
}

interface GroupedFieldProps {
  label: string;
  /** An ⓘ right after the label, with the field's explanation. */
  hint?: { name: string; text: string };
  children: ReactNode;
  onPress?: () => void;
  /**
   * The label and its ⓘ on a line of their own, the value under them at the row's whole width (a form whose values
   * are lists of tokens, as the web's forms put labels over their fields).
   */
  stacked?: boolean;
}

/**
 * A labeled field row ("Nome", "Seu @"): the label in a fixed column, the value or an input after it;
 * with `onPress`, the whole row opens a screen (a chevron on the right).
 */
export function GroupedField({ label, hint, children, onPress, stacked = false }: GroupedFieldProps) {
  if (stacked)
    return (
      <StackedField label={label} {...(hint ? { hint } : {})} {...(onPress ? { onPress } : {})}>
        {children}
      </StackedField>
    );
  if (hint)
    return (
      <HintedField label={label} hint={hint} onPress={onPress}>
        {children}
      </HintedField>
    );
  const body = (
    <>
      <Text variant="callout" tone="muted" style={styles.key}>
        {label}
      </Text>
      <View style={styles.grow}>{children}</View>
      {onPress ? <Disclosure /> : null}
    </>
  );
  if (!onPress) return <View style={styles.field}>{body}</View>;
  return (
    <RowPressable onPress={onPress} hold accessibilityRole="button" accessibilityLabel={label} style={styles.field}>
      {body}
    </RowPressable>
  );
}

/**
 * A field whose label has an ⓘ. With `onPress` the row's button lies under the label and the value rather than
 * around them: inside another button the ⓘ would be part of it to VoiceOver, never a button of its own.
 */
function HintedField({ label, hint, children, onPress }: GroupedFieldProps & { hint: { name: string; text: string } }) {
  const info = useInfoHint({ ...hint, variant: "callout" });
  const passive = onPress ? "none" : "auto";
  return (
    <View>
      <View style={styles.field}>
        {onPress ? (
          <RowPressable
            onPress={onPress}
            hold
            accessibilityRole="button"
            accessibilityLabel={label}
            style={StyleSheet.absoluteFill}
          />
        ) : null}
        <View style={[styles.key, styles.keyLine]} pointerEvents="box-none">
          <View
            pointerEvents={passive}
            style={styles.shrink}
            accessibilityElementsHidden={Boolean(onPress)}
            importantForAccessibility={onPress ? "no-hide-descendants" : "auto"}
          >
            <Text variant="callout" tone="muted">
              {label}
            </Text>
          </View>
          {info.button}
        </View>
        <View style={styles.grow} pointerEvents={passive}>
          {children}
        </View>
        {onPress ? (
          <View pointerEvents="none">
            <Disclosure />
          </View>
        ) : null}
      </View>
      <View style={[styles.hint, info.open ? styles.hintOpen : null]}>{info.text}</View>
    </View>
  );
}

/**
 * `GroupedField stacked`: the label (and its ⓘ, on the label's line) over the value, the value at the row's whole
 * width; with `onPress` the row's button lies under them, as `HintedField`'s, and a chevron ends the row.
 */
function StackedField({ label, hint, children, onPress }: Omit<GroupedFieldProps, "stacked">) {
  const info = useInfoHint({ name: hint?.name ?? "", text: hint?.text ?? "", variant: "footnote" });
  const passive = onPress ? "none" : "auto";
  return (
    <View>
      <View style={styles.stack}>
        {onPress ? (
          <RowPressable
            onPress={onPress}
            hold
            accessibilityRole="button"
            accessibilityLabel={label}
            style={StyleSheet.absoluteFill}
          />
        ) : null}
        <View style={styles.grow} pointerEvents="box-none">
          <View style={styles.keyLine} pointerEvents="box-none">
            <View
              pointerEvents={passive}
              style={styles.shrink}
              accessibilityElementsHidden={Boolean(onPress)}
              importantForAccessibility={onPress ? "no-hide-descendants" : "auto"}
            >
              <Text variant="footnote" tone="muted">
                {label}
              </Text>
            </View>
            {hint ? info.button : null}
          </View>
          <View style={styles.stackValue} pointerEvents={passive}>
            {children}
          </View>
        </View>
        {onPress ? (
          <View pointerEvents="none">
            <Disclosure />
          </View>
        ) : null}
      </View>
      {hint ? <View style={[styles.hint, info.open ? styles.hintOpen : null]}>{info.text}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  off: { opacity: 0.4 },
  marked: { fontWeight: "600" },
  list: { borderRadius: LIST_CORNER, borderCurve: "continuous", overflow: "hidden" },
  divider: { height: StyleSheet.hairlineWidth },
  header: { paddingTop: 20, paddingBottom: 8, paddingHorizontal: 16, fontWeight: "600" },
  headerRoom: { paddingTop: 20, paddingBottom: 8, paddingHorizontal: 16 },
  headerLine: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 8 },
  headerWords: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  headerText: { fontWeight: "600" },
  headerRow: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between" },
  headerAside: { paddingRight: 16 },
  footer: { paddingTop: 8, paddingHorizontal: 16 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: GROUPED_ROW.minHeight,
    paddingHorizontal: GROUPED_ROW.padX,
    paddingVertical: GROUPED_ROW.padY,
  },
  nested: { paddingLeft: GROUPED_ROW.padX + NEST },
  // A tree level's guide: under the middle of the parent's lead, the row's whole height, so levels read as lines.
  guide: { position: "absolute", top: 0, bottom: 0, width: 1 },
  // From just under the drawing (a laptop's base, a tower's foot), not the bottom of its 48-point box.
  trunkHost: { position: "absolute", left: TREE_X, top: GROUPED_ROW.tallPadY + 45, bottom: 0, width: 1 },
  trunk: { position: "absolute", left: TREE_X, top: TREE_ELBOW - TREE_CURVE, bottom: 0, width: 1 },
  branch: {
    position: "absolute",
    left: TREE_X,
    top: 0,
    width: 8,
    height: TREE_ELBOW,
    borderLeftWidth: 1,
    borderBottomWidth: 1,
    borderBottomLeftRadius: TREE_CURVE,
  },
  // Wrapping text starts where a one-line row's label does, not 8 from the top.
  tall: { alignItems: "flex-start", paddingVertical: GROUPED_ROW.tallPadY },
  media: { flexDirection: "column", alignItems: "stretch", gap: MEDIA_ROW.under },
  mediaHead: { flexDirection: "row", alignItems: "center", gap: 12 },
  // A control taller than the label's line (the 28-point switch) is centred on it rather than pushed below it.
  onLine: { justifyContent: "center" },
  lead: { width: LEAD, alignItems: "center", justifyContent: "center" },
  grow: { flex: 1, minWidth: 0 },
  labelLine: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  value: { flexShrink: 1, maxWidth: "50%" },
  valued: { flexDirection: "row", alignItems: "center", gap: 6 },
  // A note that doesn't fit beside its value goes under it, so the value isn't cut for it.
  noted: { flexWrap: "wrap", justifyContent: "flex-end" },
  field: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: GROUPED_ROW.minHeight,
    paddingHorizontal: GROUPED_ROW.padX,
  },
  key: { width: 96 },
  keyLine: { flexDirection: "row", alignItems: "flex-start", gap: 4 },
  // A stacked field: its label's line, the value 4 under it, the row's own 10 above and below.
  stack: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: GROUPED_ROW.minHeight,
    paddingHorizontal: GROUPED_ROW.padX,
    paddingVertical: GROUPED_ROW.padY,
  },
  stackValue: { marginTop: 4 },
  shrink: { flexShrink: 1, minWidth: 0 },
  // The row's own 16 at the end stays: a button's 44 overhangs its glyph by 13 on each side, 2 apart. Into the row's
  // padding it takes 7 above and below, so on the line it is a 30-point mark's height and showing it moves no row.
  buttons: { flexDirection: "row", gap: 2, marginVertical: -GROUPED_ROW.padY + 3, marginRight: -13 },
  button: { width: TOUCH, height: TOUCH, borderRadius: TOUCH / 2, alignItems: "center", justifyContent: "center" },
  // The circle around the ×'s glyph overhangs it by 14 on each side: pulled back by as much above, below and at the
  // end (into the row's padding) and by the row's 12 gap before it, the glyph stays where it was (16 from the row's
  // end) and the row stays as tall as a 16-point glyph makes it.
  remove: { margin: -(TOUCH - REMOVE_GLYPH) / 2, marginLeft: -12 },
  buttonOff: { opacity: 0.3 },
  hint: { paddingHorizontal: GROUPED_ROW.padX },
  hintOpen: { paddingBottom: 12 },
});
