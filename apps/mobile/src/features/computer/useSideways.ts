import * as ScreenOrientation from "expo-screen-orientation";
import { useEffect, useState } from "react";
import { useWindowDimensions } from "react-native";
import { holdOrientation, lockHome } from "@/lib/orientation";

const { OrientationLock } = ScreenOrientation;

/** How long the view stays upright after the button, before the phone may turn it again. */
const SETTLE_MS = 700;

const lock = (to: ScreenOrientation.OrientationLock) => {
  ScreenOrientation.lockAsync(to).catch(() => {});
};

/**
 * The app stands upright on a phone's screen; only the agent's screen, in control, may lie down (ADR 0098), and as soon
 * as that ends the app takes its own way again (`lockHome`: upright, or free on a large screen, ADR 0212). Turning the
 * phone does it; `lieDown` does it with the phone's own rotation lock on, and `standUp` undoes that, since then turning
 * the phone back can't. While it shows, the app's own way leaves this screen's alone (`holdOrientation`).
 */
export function useSideways(allowed: boolean) {
  const { width, height } = useWindowDimensions();
  const [turn, setTurn] = useState<"free" | "wide" | "tall">("free");

  useEffect(() => {
    if (!allowed) return;
    if (turn === "wide") return lock(OrientationLock.LANDSCAPE);
    if (turn === "free") return lock(OrientationLock.DEFAULT);
    lock(OrientationLock.PORTRAIT_UP);
    const id = setTimeout(() => setTurn("free"), SETTLE_MS);
    return () => clearTimeout(id);
  }, [allowed, turn]);

  useEffect(() => {
    if (!allowed) return;
    const release = holdOrientation();
    return () => {
      release();
      setTurn("free");
      lockHome();
    };
  }, [allowed]);

  return {
    wide: allowed && width > height,
    /** Lying down by the button, so only the button stands it up. */
    forced: turn === "wide",
    lieDown: () => setTurn("wide"),
    standUp: () => setTurn("tall"),
  };
}
