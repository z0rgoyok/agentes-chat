import {
  DarkTheme,
  DefaultTheme,
  router as expoRouter,
  type Href,
  type NativeStackNavigationOptions,
  type Theme as NavigationTheme,
  Stack,
  useFocusEffect,
} from "expo-router";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { isStill, landsOnRoot, STILL_PARAM } from "@/features/links/landing";
import { needsHeaderBlur, pushOnce } from "@/lib/nav";
import { IconButton } from "./IconButton";
import { useTheme } from "./theme";

/**
 * Options for the native navigators (react-native-screens through expo-router): the theme the native
 * headers read, the large-title stacks of the tabs, pushed screens and form sheets. Colors always come
 * from our theme, so light/dark follows the person's choice.
 */

const legacyBlur = needsHeaderBlur(Platform.OS, Platform.Version);

const push = pushOnce((...args: Parameters<typeof expoRouter.push>) => expoRouter.push(...args));
/**
 * The app's router: expo-router's, whose screens a quick double tap would push twice (its stack only folds a push of a
 * screen marked `singular`), pushing each screen once per tap (`pushOnce`). expo-router binds its methods after the
 * first render, so each is read when called. Every screen imports this one, never expo-router's.
 */
export const router: typeof expoRouter = new Proxy(expoRouter, {
  get: (target, key, receiver) => (key === "push" ? push : Reflect.get(target, key, receiver)),
});

/** A piece of the native header that changes with the screen (actions, a custom title). */
export interface HeaderSlotStore {
  get(): ReactNode;
  set(node: ReactNode): void;
  subscribe(listener: () => void): () => void;
}

function createSlot(initial: ReactNode): HeaderSlotStore {
  let node = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => node,
    set(next) {
      if (next === node) return;
      node = next;
      for (const l of listeners) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * Keeps `node` (an element rebuilt on every render of the screen) in a stable store, so the screen's
 * header options stay the same object and `setOptions` isn't called on every render; `HeaderSlot` shows
 * the latest node inside the header.
 */
export function useHeaderSlot(node: ReactNode): HeaderSlotStore {
  const [slot] = useState(() => createSlot(node));
  useLayoutEffect(() => {
    slot.set(node);
  });
  return slot;
}

/** Renders the latest node of a `useHeaderSlot` store. */
export function HeaderSlot({ slot }: { slot: HeaderSlotStore }) {
  const node = useSyncExternalStore(slot.subscribe, slot.get, slot.get);
  return <>{node}</>;
}

/** React Navigation's theme from ours (back button tint, header text, userInterfaceStyle of the bars). */
export function useNavigationTheme(): NavigationTheme {
  const { colors, scheme } = useTheme();
  return useMemo(() => {
    const base = scheme === "dark" ? DarkTheme : DefaultTheme;
    return {
      ...base,
      dark: scheme === "dark",
      colors: {
        ...base.colors,
        primary: colors.ink,
        background: colors.bg,
        card: colors.bg,
        text: colors.ink,
        border: colors.line,
        notification: colors.ink,
      },
    };
  }, [colors, scheme]);
}

/**
 * The bar over content that scrolls under it: the system glass on iOS 26 (nothing set, so the system
 * draws it), a blur on older iOS, an opaque bar on Android (content starts below it).
 */
function useScrollUnderBar(): NativeStackNavigationOptions {
  const { colors, scheme } = useTheme();
  return useMemo<NativeStackNavigationOptions>(() => {
    if (Platform.OS === "ios") {
      return legacyBlur
        ? {
            headerTransparent: true,
            headerBlurEffect: scheme === "dark" ? "systemChromeMaterialDark" : "systemChromeMaterialLight",
          }
        : {};
    }
    return { headerTransparent: false, headerStyle: { backgroundColor: colors.bg } };
  }, [colors.bg, scheme]);
}

/**
 * The window's side insets as a screen's padding (ADR 0212): the controls the iPhone Duo's outer display keeps on its
 * right, a notch in landscape. A screen's content stays clear of them while its color still fills behind them; on a
 * portrait iPhone they are zero. A screen that places its own controls by these insets (an agent's computer, the
 * image viewer, a presentation) takes none here.
 */
export function useSideInsets() {
  const { left, right } = useSafeAreaInsets();
  return useMemo(() => ({ paddingLeft: left, paddingRight: right }), [left, right]);
}

/**
 * A tab's stack root, for a large title the screen draws (`LargeTitleScreen`: on Android, and on iOS where art stands
 * behind the bar): a clear bar whose title fades in on scroll. A tab root under the system's large title (iOS) sets
 * the system's bar over these, as the pushed screens do: under this clear bar the system's large title stayed expanded
 * over the list.
 */
export function useLargeTitleOptions(): NativeStackNavigationOptions {
  const { colors } = useTheme();
  const side = useSideInsets();
  return useMemo<NativeStackNavigationOptions>(
    () => ({
      headerShown: true,
      headerTransparent: true,
      headerStyle: { backgroundColor: "transparent" },
      headerShadowVisible: false,
      headerLargeTitleEnabled: false,
      headerTitleStyle: { color: colors.ink },
      headerTintColor: colors.ink,
      contentStyle: { backgroundColor: colors.bg, ...side },
    }),
    [colors, side],
  );
}

/**
 * The stack inside a tab (Conversas, Agentes, Atividade): its root screen sets its large title (`LargeTitleScreen`).
 * The title is set here too so the first frame already has it.
 */
export function TabStack({ title }: { title: string }) {
  const options = useLargeTitleOptions();
  return (
    <Stack screenOptions={options}>
      <Stack.Screen name="index" options={{ title }} />
    </Stack>
  );
}

/**
 * The stack of Início: its root has no large title (the greeting over the sky is the large title). The
 * bar is clear over the sky; the title fades in once the greeting scrolls away, and what the bar becomes
 * once scrolled is drawn by the screen (`CoverBarBackdrop`) or, on iOS 26, by the system's scroll edge.
 */
export function CoverTabStack({ title }: { title: string }) {
  const { colors } = useTheme();
  const side = useSideInsets();
  const options = useMemo<NativeStackNavigationOptions>(
    () => ({
      headerShown: true,
      headerTransparent: true,
      headerStyle: { backgroundColor: "transparent" },
      headerShadowVisible: false,
      headerLargeTitleEnabled: false,
      headerTitleStyle: { color: colors.ink },
      headerTintColor: colors.ink,
      contentStyle: { backgroundColor: colors.bg, ...side },
    }),
    [colors, side],
  );
  return (
    <Stack screenOptions={options}>
      <Stack.Screen name="index" options={{ title }} />
    </Stack>
  );
}

/**
 * A pushed screen (conversation, mission, agent, delete account): native bar, back chevron only, the
 * edge swipe back, the platform's push animation. Opaque by default (lists and composers lay out below
 * it); `PushedHeader` switches a screen to a bar its content scrolls under. On Android the back button is a
 * round plate floating like iOS 26's glass one (the toolbar's own arrow sat bare on the bar).
 */
export function usePushedOptions(): NativeStackNavigationOptions {
  const { colors, reducedMotion } = useTheme();
  const { t } = useTranslation();
  const side = useSideInsets();
  const backTitle = t("mobile.common.back");
  return useMemo<NativeStackNavigationOptions>(
    () => ({
      headerShown: true,
      title: "",
      headerBackButtonDisplayMode: "minimal",
      // Hidden by the minimal button, but VoiceOver reads it: without it the back button was named after the
      // route group under it, "(tabs)".
      headerBackTitle: backTitle,
      headerTransparent: false,
      headerStyle: { backgroundColor: colors.bg },
      headerShadowVisible: false,
      headerTitleStyle: { color: colors.ink },
      headerTintColor: colors.ink,
      gestureEnabled: true,
      // From the right on both platforms (Android's default rises from below); a cross-fade with less motion.
      animation: reducedMotion ? "fade" : "slide_from_right",
      contentStyle: { backgroundColor: colors.bg, ...side },
      ...plateBack(backTitle),
    }),
    [colors, backTitle, reducedMotion, side],
  );
}

/** Android's back button: a round plate (the toolbar's own arrow hidden); iOS keeps the system's. */
function plateBack(label: string): NativeStackNavigationOptions {
  if (Platform.OS !== "android") return {};
  return {
    headerBackVisible: false,
    headerLeft: ({ canGoBack }) =>
      canGoBack ? <IconButton icon="back" label={label} plate onPress={() => goBack()} /> : null,
  };
}

/**
 * Back to the screen this one was opened from, so leaving a flow lands where the person was; `fallback` (home by
 * default) when it was opened by a link with nothing under it.
 */
export function goBack(fallback: Href = "/") {
  if (router.canGoBack()) router.back();
  else landOn(fallback);
}

/**
 * Leaves this screen for `href`, taking its place. A tab's root (or the sign-in) is already at the bottom of the
 * stack, so the screens over it are dismissed down to it: expo-router makes a new route on `replace`, and the tabs then
 * sat twice in the stack (a second tab bar slid over, a swipe back showed the copy, the app's root hooks ran twice).
 * Any other screen replaces this one.
 */
export function landOn(href: Href) {
  if (landsOnRoot(href)) router.dismissTo(href);
  else router.replace(href);
}

/** `<Redirect>` for a screen with nothing to show: it lands (`landOn`) where it sends the person. */
export function LandOn({ href }: { href: Href }) {
  useFocusEffect(useCallback(() => landOn(href), [href]));
  return null;
}

/**
 * A screen opened in place (`stillHref`, no slide) drops that mark once it is up, so going back slides as it does from
 * any pushed screen (the stack's options read the mark: `isStill`).
 */
export function useSettleStill(params: unknown) {
  const still = isStill(params);
  useEffect(() => {
    if (!still) return;
    const frame = requestAnimationFrame(() => router.setParams({ [STILL_PARAM]: undefined }));
    return () => cancelAnimationFrame(frame);
  }, [still]);
}

/** The bar of a pushed screen whose content scrolls under it (needs `contentInsetAdjustmentBehavior="automatic"`). */
export function useScrollUnderPushedOptions(): NativeStackNavigationOptions {
  const bar = useScrollUnderBar();
  return useMemo<NativeStackNavigationOptions>(
    () =>
      // On iOS, clear the opaque defaults of `usePushedOptions` (options merge by spread, so an explicit
      // `undefined` lets iOS 26 draw its own glass bar).
      Platform.OS === "ios" ? { headerTransparent: undefined, headerStyle: undefined, ...bar } : bar,
    [bar],
  );
}

/** Over a full-bleed cover (the agent's sky): a clear bar on both platforms, the back button over the art. */
export const coverBarOptions: NativeStackNavigationOptions = {
  headerTransparent: true,
  headerStyle: { backgroundColor: "transparent" },
};
