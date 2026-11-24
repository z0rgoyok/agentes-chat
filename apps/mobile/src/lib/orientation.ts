import * as ScreenOrientation from "expo-screen-orientation";
import { Dimensions, type ScaledSize } from "react-native";

/**
 * The shortest side, in points, from which a screen is a large one (ADR 0212): the iPhone Duo's inner display, a
 * tablet. Every phone screen, the Duo's outer one included, is narrower.
 */
export const LARGE_SCREEN = 600;

/** Whether a screen this size is a large one. */
export const isLargeScreen = (screen: { width: number; height: number }) =>
  Math.min(screen.width, screen.height) >= LARGE_SCREEN;

/**
 * The app's own orientation where no screen asks for another (`useSideways`): upright on a phone's screen, free on a
 * large one, which people hold and set down every way and where the system resizes the app (Split View, a fold).
 */
export function homeOrientation(screen = Dimensions.get("screen")): ScreenOrientation.OrientationLock {
  return isLargeScreen(screen)
    ? ScreenOrientation.OrientationLock.DEFAULT
    : ScreenOrientation.OrientationLock.PORTRAIT_UP;
}

/** Back to the app's own orientation (`homeOrientation`). */
export function lockHome() {
  ScreenOrientation.lockAsync(homeOrientation()).catch(() => {});
}

/** Screens holding an orientation of their own (an agent's computer, a presentation): the app leaves theirs alone. */
let held = 0;

/** A screen takes the orientation over while it shows; the returned function hands it back. */
export function holdOrientation(): () => void {
  held += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held -= 1;
  };
}

let following = false;

/**
 * Keeps the app's own orientation as it moves between screens (an iPhone Duo opened or closed): once per process,
 * from the root layout. A turn changes the window's size too, so a screen holding its own orientation is left as it is.
 */
export function followScreens() {
  if (following) return;
  following = true;
  lockHome();
  Dimensions.addEventListener("change", ({ screen }: { screen: ScaledSize }) => {
    if (held === 0) ScreenOrientation.lockAsync(homeOrientation(screen)).catch(() => {});
  });
}
