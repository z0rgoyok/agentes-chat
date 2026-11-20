import type { AppNotification } from "@agenteschat/client";
import { useNotificationAction, useNotificationReply } from "@agenteschat/client";
import { type IslandItem, islandLead, noticeLine } from "@agenteschat/client/lib/island";
import { mediaWord } from "@agenteschat/client/lib/media";
import { quickReply, waitingCardOf } from "@agenteschat/client/lib/notifications";
import { StatusBar } from "expo-status-bar";
import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import {
  AccessibilityInfo,
  type LayoutChangeEvent,
  Platform,
  Pressable,
  ScrollView,
  type ScrollViewInstance,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useKeyboardState } from "react-native-keyboard-controller";
import Animated, {
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import { setIslandLive } from "@/lib/push";
import { useAppActive } from "@/lib/useAppActive";
import { useOrg } from "@/providers/org";
import { useRealtime } from "@/providers/realtime";
import { haptics, Icon, type IconName, LineIcon, Text, useTheme } from "@/ui";
import { router } from "@/ui/navigation";
import { variantStyle } from "@/ui/Text";
import { useNoticeTitle } from "../activity/noticeTitle";
import { isDashboardNotice } from "../dashboards/logic";
import { notificationHref, notificationWebPath } from "../links/logic";
import { openWebPath } from "../links/open-web";
import { Face } from "../shared/Face";
import { useOrgId } from "../shared/hooks";
import { island } from "./island";

/** The camera's island on iPhones that have one: the island grows out of it and folds back into it. */
const CAMERA = { width: 126, height: 37, top: 11 };
/** From this top inset an iPhone has the camera's island (14 Pro and later); below it, a notch or nothing. */
const CAMERA_INSET = 59;
const PILL_HEIGHT = 72;
/** The face on the small island, beside the camera. */
const SMALL_FACE = 27;
/** Open: until its height is measured. */
const OPEN_GUESS = 260;
const TICK_MS = 250;
/** Swiped up this far, or flicked up this fast (points per second), it's put away. */
const PUT_AWAY = -24;
const FLICK_AWAY = -600;
/** "Enviado" stays this long before the notice leaves. */
const SENT_MS = 1400;
const OPEN_MAX = 3;
const WHITE = "#fff";
const MUTED = "rgba(255,255,255,0.64)";
const LINE = "rgba(255,255,255,0.12)";
/**
 * The shape's spring from one size to the next: settled, with almost no overshoot, well before the content fades in
 * (`CONTENT_IN`), so nothing shows past its edge.
 */
const ISLAND_SPRING = { duration: 350, dampingRatio: 0.85 };
/** The content's fade: in once the shape is nearly there, out as it folds away. */
const CONTENT_IN = { delay: 160, duration: 220 };
const CONTENT_OUT = 120;
/** Chips are 36 points tall: this much more around each makes a 44-point target (they sit 8 apart). */
const CHIP_SLOP = 4;

type Shape = "none" | "pill" | "small" | "open";
type Shown = { shape: Exclude<Shape, "none">; w: number; h: number; corner: number };

/** Pulled past its edge, the island follows less the further it goes (a boundary that resists, not a wall). */
function rubberband(overshoot: number, dimension: number, constant = 0.55) {
  "worklet";
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

/**
 * The island on the phone (ADR 0071 §9): what reaches me while the app is open grows out of the camera's island (on
 * other phones it drops from the top as a dark pill), with the face of whoever called. A tap opens it with the whole
 * text and the answer right there; swiping it up puts it away. A notice leaves after a few seconds, and one waiting
 * on me shrinks beside the camera until I decide. While it is up, the system's banner stays away.
 */
export function NoticeIsland() {
  const { t } = useTranslation();
  const { reducedMotion } = useTheme();
  const insets = useSafeAreaInsets();
  const { width, height: screenHeight } = useWindowDimensions();
  const { status } = useRealtime();
  const snap = useSyncExternalStore(island.subscribe, island.get, island.get);
  const [open, setOpen] = useState(false);
  const [openHeight, setOpenHeight] = useState(OPEN_GUESS);
  // The system's keyboard draws over the app: with it up (a reply being typed), the open island ends above it.
  const keyboardHeight = useKeyboardState((state) => (state.isVisible ? state.height : 0));
  // Where the row whose reply is being typed ends, in the open island's list: it is kept in sight over the keyboard.
  const [replyEnd, setReplyEnd] = useState<number | null>(null);
  const list = useRef<ScrollViewInstance>(null);

  // Up with the socket live: the system's banner stays away (nothing shows twice).
  useEffect(() => {
    setIslandLive(status === "open");
    return () => setIslandLive(false);
  }, [status]);

  // Time runs out only for a notice still in its time (a shrunk one waits without it), and only with the app in front.
  const counting = snap.items.some((i) => !i.small);
  const inFront = useAppActive();
  useEffect(() => {
    if (!counting || !inFront) return;
    const timer = setInterval(() => island.tick(TICK_MS), TICK_MS);
    return () => clearInterval(timer);
  }, [counting, inFront]);
  useEffect(() => {
    island.pause("open", open);
    return () => island.pause("open", false);
  }, [open]);

  const { lead, small, others } = islandLead(snap.items);
  // The last one shown stays drawn while the island folds away.
  const shown = useRef<IslandItem | null>(null);
  if (lead) shown.current = lead;
  useEffect(() => {
    if (!snap.items.length) setOpen(false);
  }, [snap.items.length]);

  // A new arrival: a firm tap, felt in a pocket too (the light one passed unnoticed).
  const seen = useRef(snap.seq);
  useEffect(() => {
    if (snap.seq === seen.current) return;
    seen.current = snap.seq;
    if (snap.items.length) haptics.medium();
  }, [snap.seq, snap.items.length]);

  const camera = Platform.OS === "ios" && insets.top >= CAMERA_INSET;
  const top = camera ? CAMERA.top : insets.top + 6;
  const shape: Shape = !lead ? "none" : open ? "open" : small ? "small" : "pill";
  // Grown out of the camera, the pill and the open island cover the status bar's line: their content starts under
  // the camera (never behind it) and the status bar steps aside meanwhile, as with the system's own island.
  const clear = camera ? CAMERA.height : 0;
  const coversBar = camera && (shape === "pill" || shape === "open");
  // Open, it stops above the bottom edge, or above the keyboard while one is up, and scrolls inside: long choices and
  // a reply's field never run off the screen or under the keys.
  const openMax = screenHeight - top - (keyboardHeight > 0 ? keyboardHeight + 12 : insets.bottom + 16);
  // Only while open: the last open height outlives it, and a closed pill must keep its swipe away.
  const scrolls = shape === "open" && openHeight > openMax;
  const size = {
    none: camera ? { w: CAMERA.width, h: CAMERA.height } : { w: 44, h: 44 },
    pill: { w: Math.min(width - 20, 420), h: PILL_HEIGHT + clear },
    small: { w: camera ? 250 : 200, h: camera ? CAMERA.height : 40 },
    open: { w: Math.min(width - 16, 440), h: Math.min(openHeight, openMax) },
  }[shape];
  const corner = shape === "open" ? (camera ? 44 : 28) : shape === "pill" ? 36 : size.h / 2;
  // The island made shorter for the keyboard: the reply being typed scrolls into what is left of it.
  useEffect(() => {
    if (!scrolls || replyEnd === null || keyboardHeight === 0) return;
    list.current?.scrollTo({ y: Math.max(0, replyEnd - size.h), animated: !reducedMotion });
  }, [scrolls, replyEnd, keyboardHeight, size.h, reducedMotion]);
  // What the content is laid out for: this shape, or folding away, the last one shown (it stays drawn while it goes).
  const lastShown = useRef<Shown | null>(null);
  if (shape !== "none") lastShown.current = { shape, w: size.w, h: size.h, corner };
  const drawn = lastShown.current;

  // The shape is a backdrop with nothing in it, so its size and corner spring without laying anything out again; the
  // content sits over it at its final size, behind its own fade (`IslandContent`).
  const w = useSharedValue(size.w);
  const h = useSharedValue(size.h);
  const r = useSharedValue(corner);
  const fade = useSharedValue(0);
  const drag = useSharedValue(0);
  useEffect(() => {
    const to = (v: number) => (reducedMotion ? withTiming(v, { duration: 160 }) : withSpring(v, ISLAND_SPRING));
    w.value = to(size.w);
    h.value = to(size.h);
    r.value = to(corner);
    // Back into the camera's island (or a dot), then gone.
    fade.value =
      shape === "none"
        ? withDelay(reducedMotion ? 0 : 260, withTiming(0, { duration: 160 }))
        : withTiming(1, { duration: 120 });
  }, [shape, size.w, size.h, corner, reducedMotion, w, h, r, fade]);

  // Swiped up: what isn't waiting leaves, what is shrinks beside the camera. The island is the finger while it is
  // down (up freely; pulled down it resists, it lives at the top), and lets go on distance or on a flick, the spring
  // home seeded with the finger's speed.
  const putAway = useCallback(() => {
    setOpen(false);
    island.putAway();
  }, []);
  const pan = useMemo(
    () =>
      Gesture.Pan()
        // Scrolling, a swipe moves the list; the backdrop still closes it.
        .enabled(!scrolls)
        .activeOffsetY([-8, 8])
        .onChange((e) => {
          const next = drag.value + e.changeY;
          drag.value = next <= 0 ? next : rubberband(next, PILL_HEIGHT);
        })
        .onEnd((e) => {
          if (drag.value < PUT_AWAY || e.velocityY < FLICK_AWAY) scheduleOnRN(putAway);
          drag.value = withSpring(0, { duration: 400, dampingRatio: 0.8, velocity: e.velocityY });
        }),
    [drag, putAway, scrolls],
  );

  const frame = useAnimatedStyle(() => ({ opacity: fade.value, transform: [{ translateY: drag.value }] }));
  const backdrop = useAnimatedStyle(() => ({ width: w.value, height: h.value, borderRadius: r.value }));

  const item = lead ?? shown.current;
  if (!item && shape === "none") return null;

  return (
    <>
      {open ? (
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={() => setOpen(false)}
          accessibilityLabel={t("common.close")}
          accessibilityRole="button"
        />
      ) : null}
      {camera ? <StatusBar hidden={coversBar} animated /> : null}
      <View pointerEvents="box-none" style={[styles.place, { top }]}>
        <GestureDetector gesture={pan}>
          {/* Touches and the swipe land on the shape's final size; the backdrop and the content center in it. */}
          <Animated.View
            pointerEvents={shape === "none" ? "none" : "auto"}
            style={[styles.frame, { width: size.w, height: size.h }, frame]}
          >
            <Animated.View style={[styles.backdrop, backdrop]} />
            {drawn ? (
              <IslandContent
                // A new shape lays out new content, invisible from its first frame until the shape is nearly there.
                key={drawn.shape}
                leaving={shape === "none"}
                reduced={reducedMotion}
                width={drawn.w}
                height={drawn.h}
                corner={drawn.corner}
                shapeWidth={w}
                shapeHeight={h}
              >
                {drawn.shape === "open" ? (
                  <ScrollView
                    scrollEnabled={scrolls}
                    ref={list}
                    bounces={false}
                    showsVerticalScrollIndicator={scrolls}
                    // A reply's send takes the first tap, with the keyboard up.
                    keyboardShouldPersistTaps="handled"
                  >
                    <View
                      style={{ width: drawn.w, paddingTop: clear }}
                      onLayout={(e: LayoutChangeEvent) => {
                        // Folding away it keeps the height it had: the next opening measures again.
                        if (shape === "open") setOpenHeight(Math.ceil(e.nativeEvent.layout.height));
                      }}
                    >
                      {snap.items.slice(0, OPEN_MAX).map((i, k) => (
                        <Fragment key={i.n.id}>
                          {k > 0 ? <View style={styles.rule} /> : null}
                          <IslandRow n={i.n} onOpened={() => setOpen(false)} onReplying={setReplyEnd} />
                        </Fragment>
                      ))}
                      {snap.items.length > OPEN_MAX ? (
                        <Pressable
                          onPress={() => {
                            setOpen(false);
                            router.push("/activity");
                          }}
                          style={({ pressed }) => [styles.all, pressed && styles.pressed]}
                          accessibilityRole="link"
                        >
                          <Text variant="footnote" style={{ color: MUTED }}>
                            {t("island.all")}
                          </Text>
                        </Pressable>
                      ) : null}
                    </View>
                  </ScrollView>
                ) : item && drawn.shape === "small" ? (
                  <SmallIsland item={item} others={others} camera={camera} onPress={() => setOpen(true)} />
                ) : item ? (
                  <Pill
                    item={item}
                    others={others}
                    clear={clear}
                    onPress={() => setOpen(true)}
                    onOpened={() => setOpen(false)}
                  />
                ) : null}
              </IslandContent>
            ) : null}
          </Animated.View>
        </GestureDetector>
      </View>
    </>
  );
}

/**
 * What the island says, laid out once at its shape's final size, over the backdrop: nothing in it lays out again while
 * the shape springs. Each shape mounts its own (`key`), invisible from its first frame; it fades in once the shape is
 * nearly there. Folding away (`leaving`) it fades out and shrinks with the shape toward the camera, so none of it shows
 * past the shape's edge.
 */
function IslandContent({
  leaving,
  reduced,
  width,
  height,
  corner,
  shapeWidth,
  shapeHeight,
  children,
}: {
  leaving: boolean;
  reduced: boolean;
  width: number;
  height: number;
  corner: number;
  shapeWidth: SharedValue<number>;
  shapeHeight: SharedValue<number>;
  children: ReactNode;
}) {
  const shown = useSharedValue(0);
  useEffect(() => {
    shown.value = leaving
      ? withTiming(0, { duration: CONTENT_OUT })
      : withDelay(reduced ? 0 : CONTENT_IN.delay, withTiming(1, { duration: CONTENT_IN.duration }));
  }, [leaving, reduced, shown]);
  const look = useAnimatedStyle(() => {
    // Only a shape narrower than the content shrinks it (folding away); one that only grows taller (a reply being
    // typed) never does.
    const across = shapeWidth.value / width;
    const down = leaving ? shapeHeight.value / height : 1;
    return { opacity: shown.value, transform: [{ scale: Math.min(1, across, down) }] };
  });
  return (
    <Animated.View style={[styles.content, { width, height, borderRadius: corner }, look]}>{children}</Animated.View>
  );
}

/** Who did what, the names bold, in white. */
function Title({ n, lines }: { n: AppNotification; lines: number }) {
  const { parts, names } = useNoticeTitle(n);
  return (
    <Text variant="subhead" numberOfLines={lines} style={{ color: MUTED }}>
      {parts.map((part, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of one fixed sentence
        <Fragment key={i}>
          {/* The sentence's own size: a bare Text is body (17) inside this 15. */}
          {i > 0 ? (
            <Text variant="subhead" style={styles.names}>
              {names}
            </Text>
          ) : null}
          {part}
        </Fragment>
      ))}
    </Text>
  );
}

const useLine = (n: AppNotification) => {
  const { t } = useTranslation();
  // What the right hand found is its headline: nothing under it says it again.
  return n.kind === "team_watch" ? "" : noticeLine(n, (kind) => mediaWord(t, kind));
};

/** Closed: the face, who did what and the line; how many more; "Ver" (where it happened) at its end. */
function Pill({
  item,
  others,
  clear,
  onPress,
  onOpened,
}: {
  item: IslandItem;
  others: number;
  /** Room on top for the camera it grew out of. */
  clear: number;
  onPress: () => void;
  onOpened: () => void;
}) {
  const { t } = useTranslation();
  const { title } = useNoticeTitle(item.n);
  const line = useLine(item.n);
  const opener = useOpenNotice(item.n, onOpened);
  // Said aloud as it arrives (VoiceOver, TalkBack).
  useEffect(() => {
    AccessibilityInfo.announceForAccessibility([title, line].filter(Boolean).join(". "));
  }, [title, line]);
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.pill, { paddingTop: clear }, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={[title, line].filter(Boolean).join(", ")}
      accessibilityHint={t("island.expand")}
    >
      <IslandFace n={item.n} size={40} round />
      <View style={styles.grow}>
        <Title n={item.n} lines={1} />
        {line ? (
          <Text variant="subhead" numberOfLines={1} style={{ color: WHITE }}>
            {line}
          </Text>
        ) : null}
      </View>
      {others > 0 ? (
        <View style={styles.count}>
          <Text variant="caption" style={styles.countText}>
            +{others}
          </Text>
        </View>
      ) : null}
      {opener.canOpen ? <Chip label={t("island.see")} onPress={opener.open} /> : null}
    </Pressable>
  );
}

/** Where a notice happened: whether the app can open it, and opening it there (read, and off the island). */
function useOpenNotice(n: AppNotification, onOpened: () => void) {
  const orgId = useOrgId();
  const act = useNotificationAction(orgId);
  const href = notificationHref(n);
  const web = href ? null : notificationWebPath(n, orgId);
  const open = () => {
    if (!n.readAt) act.mutate({ type: "read", item: n, read: true });
    island.settle(n.id);
    onOpened();
    // An approval opens in its sheet (held to approve there); the rest, where it happened.
    if (href) router.push(href);
    else if (web) openWebPath(web);
  };
  return { canOpen: Boolean(href || web), open };
}

/** Only requests waiting on me are left: the face beside the camera and what it asks of me. */
function SmallIsland({
  item,
  others,
  camera,
  onPress,
}: {
  item: IslandItem;
  others: number;
  camera: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const { title } = useNoticeTitle(item.n);
  // A widget's alert or an agent asking to publish a dashboard (ADR 0135) is opened, never answered here.
  const ask = item.n.waiting && !isDashboardNotice(item.n.kind) ? waitingCardOf(item.n).action : "open";
  const label = ask === "review" ? t("island.review") : ask === "answer" ? t("island.reply") : t("island.open");
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.small,
        camera ? styles.smallSplit : styles.smallTogether,
        pressed && styles.pressed,
      ]}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={t("island.expand")}
    >
      <IslandFace n={item.n} size={SMALL_FACE} round />
      <Text variant="footnote" numberOfLines={1} style={styles.smallLabel}>
        {others > 0 ? `${label} +${others}` : label}
      </Text>
    </Pressable>
  );
}

/** One notice on the open island: who and what, the whole line, and the answer right there. */
function IslandRow({
  n,
  onOpened,
  onReplying,
}: {
  n: AppNotification;
  onOpened: () => void;
  /** Its reply is being typed: where the row ends in the open island's list (null once it isn't). */
  onReplying: (end: number | null) => void;
}) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const act = useNotificationAction(orgId);
  const reply = useNotificationReply(orgId);
  const line = useLine(n);
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    island.pause(`typing:${n.id}`, typing);
    return () => island.pause(`typing:${n.id}`, false);
  }, [typing, n.id]);

  // Where this row ends in the island's list, told while its reply is being typed (the island keeps it in sight).
  const [end, setEnd] = useState<number | null>(null);
  useEffect(() => {
    if (!typing) return;
    onReplying(end);
    return () => onReplying(null);
  }, [typing, end, onReplying]);

  const { target, suggestions, readOnly } = quickReply(n, Boolean(useOrg().org?.deletion));
  const waiting = n.waiting ? waitingCardOf(n) : null;
  const { canOpen, open } = useOpenNotice(n, onOpened);

  const read = () => {
    if (!n.readAt) act.mutate({ type: "read", item: n, read: true });
  };
  const answer = (text: string, choice = false) => {
    if (!target || !text.trim()) return;
    setFailed(false);
    reply.mutate(
      { target, text: text.trim(), choice },
      {
        onSuccess: () => {
          read();
          setTyping(false);
          haptics.success();
          setDone(choice ? t("island.answered", { choice: text.trim() }) : t("island.sent"));
          setTimeout(() => island.settle(n.id), SENT_MS);
        },
        onError: () => {
          haptics.error();
          setFailed(true);
        },
      },
    );
  };
  const primary = waiting && (waiting.action !== "answer" || isDashboardNotice(n.kind)) && canOpen;

  return (
    <View
      style={styles.row}
      onLayout={(e: LayoutChangeEvent) => setEnd(e.nativeEvent.layout.y + e.nativeEvent.layout.height)}
    >
      <IslandFace n={n} size={34} />
      <View style={styles.grow}>
        <Title n={n} lines={2} />
        {line ? (
          <Text variant="callout" numberOfLines={4} style={styles.text}>
            {line}
          </Text>
        ) : null}
        {done ? (
          <View style={styles.done} accessibilityLiveRegion="polite">
            <LineIcon name="check" size={13} color="#7ee2a8" variant="footnote" />
            <Text variant="footnote" style={[styles.doneText, styles.grow]}>
              {done}
            </Text>
          </View>
        ) : typing && target ? (
          <View style={styles.reply}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              autoFocus
              placeholder={t("island.placeholder")}
              placeholderTextColor={MUTED}
              accessibilityLabel={t("island.reply")}
              returnKeyType="send"
              onSubmitEditing={() => answer(draft)}
              editable={!reply.isPending}
              style={[styles.input, { ...variantStyle("callout"), lineHeight: undefined }]}
              keyboardAppearance="dark"
            />
            <Chip
              icon="send"
              label={t("island.send")}
              iconOnly
              primary
              disabled={!draft.trim() || reply.isPending}
              onPress={() => answer(draft)}
            />
          </View>
        ) : (
          <>
            {readOnly ? (
              <View style={styles.done}>
                <LineIcon name="lock" size={13} color={MUTED} variant="footnote" />
                <Text variant="footnote" style={[styles.readonly, styles.grow]}>
                  {t("deleting.composer")}
                </Text>
              </View>
            ) : null}
            <View style={styles.acts}>
              {suggestions.map((s) => (
                <Chip key={s} label={s} outline disabled={reply.isPending} onPress={() => answer(s, true)} />
              ))}
              {primary ? (
                <Chip
                  label={waiting?.action === "review" ? t("island.review") : t("island.open")}
                  primary
                  onPress={open}
                />
              ) : null}
              {target ? (
                <Chip
                  icon="reply"
                  label={suggestions.length ? t("island.otherAnswer") : t("island.reply")}
                  onPress={() => setTyping(true)}
                />
              ) : null}
              {!primary && canOpen ? <Chip label={t("island.open")} onPress={open} /> : null}
            </View>
          </>
        )}
        {failed ? (
          <Text variant="footnote" style={styles.failed}>
            {t("island.failed")}
          </Text>
        ) : null}
      </View>
      <Pressable
        onPress={() => island.dismiss(n.id)}
        hitSlop={10}
        style={({ pressed }) => [styles.x, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel={t("island.dismiss")}
      >
        <Icon name="x" size={16} color={MUTED} />
      </Pressable>
    </View>
  );
}

/** A button on the island: white on the dark for the main one, a soft tint for the rest, a ring for a choice. */
function Chip({
  label,
  icon,
  iconOnly,
  primary,
  outline,
  disabled,
  onPress,
}: {
  label: string;
  icon?: IconName;
  iconOnly?: boolean;
  primary?: boolean;
  outline?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const ink = primary ? "#000" : WHITE;
  return (
    <Pressable
      onPress={() => {
        haptics.light();
        onPress();
      }}
      disabled={disabled}
      hitSlop={CHIP_SLOP}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      style={({ pressed }) => [
        styles.chip,
        iconOnly && styles.chipIcon,
        primary ? styles.chipPrimary : outline ? styles.chipOutline : styles.chipSoft,
        (pressed || disabled) && { opacity: disabled ? 0.45 : 0.75 },
      ]}
    >
      {icon ? <Icon name={icon} size={16} color={ink} /> : null}
      {iconOnly ? null : (
        <Text variant="subhead" style={[styles.chipText, { color: ink }]}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

const faceOf = (n: AppNotification) => {
  const a = n.actors[0];
  return a ? { type: a.type === "agent" ? "agent" : "person", id: a.id } : null;
};

/**
 * Who it is from; with nobody behind it (the workspace itself), what it is about as
 * an icon on a soft tile, never an unknown face. `round` at the closed pill's end, so it follows the curve: the open
 * list keeps the tile.
 */
function IslandFace({ n, size, round = false }: { n: AppNotification; size: number; round?: boolean }) {
  const who = faceOf(n);
  const radius = round ? size / 2 : undefined;
  if (who) return <Face who={who} size={size} radius={radius} />;
  return (
    <View style={[styles.sysFace, { width: size, height: size, borderRadius: radius ?? size * 0.3 }]}>
      <Icon name="bell" size={Math.round(size * 0.48)} color={WHITE} />
    </View>
  );
}

const styles = StyleSheet.create({
  // The island's place: centered, whatever its width while it grows.
  place: { position: "absolute", left: 0, right: 0, alignItems: "center", zIndex: 100 },
  // The touch area at the shape's final size; what it holds centers on it from its top.
  frame: { alignItems: "center" },
  // The shape itself: out of the layout and empty, so only it lays out while its size and corner spring.
  backdrop: {
    position: "absolute",
    top: 0,
    backgroundColor: "#000",
    borderCurve: "continuous",
    boxShadow: "0 18px 40px -16px rgba(0,0,0,0.6)",
  },
  // The content at its shape's final size and corner, on the shape's own black (what scrolls inside stays in it, and an
  // open island that grows taller, a reply being typed, is whole at once rather than spilling past the shape); folding
  // away it shrinks toward the camera from its top.
  content: {
    position: "absolute",
    top: 0,
    overflow: "hidden",
    backgroundColor: "#000",
    borderCurve: "continuous",
    transformOrigin: "top",
  },
  sysFace: { alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.14)" },
  pill: { flex: 1, flexDirection: "row", alignItems: "center", gap: 12, paddingLeft: 16, paddingRight: 18 },
  grow: { flex: 1, minWidth: 0 },
  names: { color: WHITE, fontWeight: "600" },
  count: {
    minWidth: 26,
    height: 22,
    paddingHorizontal: 8,
    borderRadius: 11,
    backgroundColor: "rgba(255,255,255,0.16)",
    alignItems: "center",
    justifyContent: "center",
  },
  countText: { color: WHITE, fontWeight: "700" },
  // The face as far from the island's edge as from its top and bottom.
  small: { flex: 1, flexDirection: "row", alignItems: "center", paddingHorizontal: (CAMERA.height - SMALL_FACE) / 2 },
  // Beside the camera: the face on its left, the ask on its right.
  smallSplit: { justifyContent: "space-between", paddingRight: 14 },
  smallTogether: { gap: 10, paddingRight: 14 },
  smallLabel: { color: WHITE, fontWeight: "600" },
  // The × (its icon at `x`'s top and padding) level with the row's first line.
  row: { flexDirection: "row", gap: 12, paddingTop: 16, paddingBottom: 16, paddingLeft: 16, paddingRight: 40 },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: LINE, marginHorizontal: 16 },
  text: { color: WHITE, marginTop: 2 },
  acts: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 },
  // Choices can be whole sentences: a chip grows with its text and wraps inside the island, a pill while it is one
  // line and a rounded box once it takes more.
  chip: {
    maxWidth: "100%",
    minHeight: 36,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  chipText: { flexShrink: 1, fontWeight: "600" },
  chipIcon: { width: 36, paddingHorizontal: 0 },
  chipPrimary: { backgroundColor: WHITE },
  chipSoft: { backgroundColor: "rgba(255,255,255,0.14)" },
  chipOutline: { borderWidth: 1.5, borderColor: "rgba(255,255,255,0.24)" },
  reply: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 12,
    paddingLeft: 14,
    paddingRight: 4,
    paddingVertical: 4,
    borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.1)",
  },
  input: { flex: 1, minWidth: 0, color: WHITE, paddingVertical: 6 },
  // The check on the first line when an answer's words wrap.
  done: { flexDirection: "row", alignItems: "flex-start", gap: 6, marginTop: 10 },
  doneText: { color: "#7ee2a8", fontWeight: "600" },
  readonly: { color: MUTED },
  failed: { color: "#ff8a80", marginTop: 6 },
  x: { position: "absolute", top: 12, right: 12, padding: 4 },
  pressed: { opacity: 0.7 },
  all: { alignItems: "center", paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: LINE },
});
