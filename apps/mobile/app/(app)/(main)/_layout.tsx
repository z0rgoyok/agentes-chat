import { type ErrorBoundaryProps, type NativeStackNavigationOptions, Stack } from "expo-router";
import { useMemo } from "react";
import { slideListeners } from "@/agent/live";
import { isStill } from "@/features/links/landing";
import { ScreenError } from "@/features/shared/ScreenError";
import { coverBarOptions, usePushedOptions, useScrollUnderPushedOptions, useTheme } from "@/ui";

/** A link straight to a pushed screen still has the tabs under it (the back button works). */
export const unstable_settings = { anchor: "(tabs)" };

/** A screen that breaks while drawing shows what happened and a way back, instead of closing the app. */
export function ErrorBoundary(props: ErrorBoundaryProps) {
  return <ScreenError {...props} />;
}

/**
 * The app's screens under its sheets: the native tabs, and the screens pushed over them with the platform's push (the
 * tab bar hides there; the native back button and the edge swipe go back), Você and its screens among them. The
 * sheets present over all of it (`../_layout.tsx`). Header options are set here so the first frame of a push already
 * has its bar; `PushedHeader` fills in the title and actions.
 *
 * Every screen is pushed with its bar over content that scrolls under it unless it is listed in `own`: a new route
 * never ships without a bar and a way back. A screen opened in place (`stillHref`: the start screen at launch) comes
 * in without its slide.
 */
/** Create an agent's steps (`new-agent/*`), one pushed screen each. */
const NEW_AGENT_ROUTES = [
  "new-agent/index",
  "new-agent/role",
  "new-agent/identity",
  "new-agent/instructions",
  "new-agent/review",
  "new-agent/import",
  "new-agent/import-preview",
];

export default function MainStack() {
  const { colors } = useTheme();
  const pushed = usePushedOptions();
  const scrollUnder = useScrollUnderPushedOptions();
  const screenOptions = useMemo(() => {
    const base: NativeStackNavigationOptions = {
      headerShown: false,
      contentStyle: { backgroundColor: colors.bg },
      gestureEnabled: true,
    };
    // Pushed with the opaque bar: lists and composers lay out below it.
    const solid = { ...base, ...pushed };
    // The default: pushed, its content scrolling under the bar.
    const page = { ...solid, ...scrollUnder };
    // Over a full-bleed cover (a sky): a clear bar, the back button over the art.
    const cover = { ...solid, ...coverBarOptions };
    // Screens that only find where to go and replace themselves: no bar, no slide.
    const bare = { ...base, animation: "none" as const };
    const connectAi = { ...page, contentStyle: { backgroundColor: colors.grouped } };
    const own: Record<string, NativeStackNavigationOptions> = {
      "(tabs)": base,
      "chat/[channelId]": solid,
      // Writing a wiki page: its text and the tools over the keys lay out below an opaque bar (nothing under it).
      "wiki-write": solid,
      "block/[id]": solid,
      "agent/[id]": cover,
      // The wiki's graph: its night fills the screen behind the bar.
      "wiki-map": cover,
      "connectors/[id]": cover,
      // Você: a pushed page with a clear bar over its sky; its screens pushed over it on the grouped gray.
      "me/index": cover,
      // On the sign-in's ruler, its own sky (the scanner: the camera): a clear bar, the system's back over it.
      "me/team-server": cover,
      "me/scan": cover,
      // A background photo's preview: the photo fills the screen, a clear bar and the back button over it.
      "me/chat-wallpaper-photo": cover,
      "connectors/oauth": bare,
      // A bare link to a browser request: finds its conversation and replaces itself with it.
      "handoff/[id]": bare,
      // A web link that needs a lookup or another workspace first: the bar's back is the way out of a slow one.
      link: { ...solid, animation: "none" },
      // Connect an AI: one pushed screen per question, on the grouped gray (its bar counts the steps).
      "connect-ai/index": connectAi,
      "connect-ai/have": connectAi,
      "connect-ai/plans": connectAi,
      "connect-ai/plan": connectAi,
      "connect-ai/key": connectAi,
      "connect-ai/makers": connectAi,
      // Create an agent: one pushed screen per step, on the grouped gray its steps draw on (no white flash in a push).
      ...Object.fromEntries(NEW_AGENT_ROUTES.map((name) => [name, connectAi])),
      images: {
        ...base,
        presentation: "transparentModal",
        animation: "fade",
        contentStyle: { backgroundColor: "transparent" },
      },
      // A file: pushed with its bar opaque over the file itself (a web view lays out below it, as a block does).
      "file/[id]": solid,
      // A live spreadsheet (ADR 0196): the grid, its bars and the keyboard's cell bar lay out below an opaque bar.
      "spreadsheet/[id]": solid,
      // A live presentation and a live canvas (ADR 0196): their slides, their plane and their tools lay out below an
      // opaque bar, as the words of a text box do over the keyboard.
      "slides/[id]": solid,
      "canvas/[id]": solid,
      // A live document (ADR 0200): its page and the format bar over the keyboard lay out below an opaque bar.
      "document/[id]": solid,
      "slide-text/[id]": solid,
      "slide-layout/[id]": solid,
      // Presenting: no bar, black around the slides, faded in; the edge swipe is the pager's (× leaves). Never a
      // modal, as the computer's screen below (the app's toasts present over it).
      "slides-show/[id]": {
        ...base,
        animation: "fade",
        gestureEnabled: false,
        contentStyle: { backgroundColor: "#000000" },
      },
      // An agent's computer and a shared browser profile's live view: pushed with the opaque bar, their picture laid
      // out below it. Never a modal: the app's sheets, pickers and toasts they open present over them, where under a
      // modal they opened hidden and the screen stopped answering.
      "computer/[agentId]": solid,
      "browser-profile/[profileId]": solid,
    };
    return ({ route }: { route: { name: string; params?: object } }): NativeStackNavigationOptions => {
      const options = own[route.name] ?? page;
      return isStill(route.params) ? { ...options, animation: "none" } : options;
    };
  }, [colors, pushed, scrollUnder]);
  return (
    <Stack screenOptions={screenOptions} screenListeners={slideListeners}>
      <Stack.Screen name="(tabs)" />
    </Stack>
  );
}
