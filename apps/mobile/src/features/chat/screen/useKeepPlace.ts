import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Keyboard } from "react-native";
import { KeyboardController, KeyboardEvents } from "react-native-keyboard-controller";
import { useSharedValue } from "react-native-reanimated";
import { createStickerStage } from "@/agent/sticker-stage";
import type { useSheet } from "../../shared/SheetHost";
import { type Place, placeCorrection } from "../scroll";
import type { FollowEnd } from "./useFollowEnd";

/** How long the follow glides after going to the end: the scroll to the message and its last settling (ms). */
const GLIDE_MS = 700;
/** How long the conversation is held in place after something opens over it and after it closes (ms). */
const HOLD_MS = 900;
/** How long the list keeps ignoring the keyboard after what covered it closed (its closing animation, ms). */
const FREEZE_AFTER_MS = 450;

/**
 * Keeping the conversation's place while something covers it (a sheet, a screen pushed over it, the agent's computer),
 * and the list still under that cover. Called on the conversation itself, beside the list's ref and its placement, so
 * these effects keep their order with those.
 */
export function useKeepPlace({
  sheet,
  follow,
}: {
  sheet: ReturnType<typeof useSheet>;
  follow: Pick<FollowEnd, "aimed" | "dragging" | "glide" | "holding" | "listRef" | "setGlide">;
}) {
  const { aimed, dragging, glide, holding, listRef, setGlide } = follow;
  // ── Keeping the place ──
  // Something opening over the conversation must not move it: on iOS it jumped when a header button opened a sheet
  // or the agent's computer. Where the person was (the end, or a row on screen) is taken before it opens, and given
  // back for a moment after it opens and after it closes, whichever way the list moved, unless they drag it or
  // the app scrolls it on purpose (sending, the pill, a pin).
  const placeNow = useCallback((): Place | null => {
    const list = listRef.current;
    const state = list?.getState();
    if (!list || !state) return null;
    if (state.isFollowingEnd) return { end: true };
    const anchor = list.anchorVisibleContent({ hold: false });
    const position = anchor ? state.positionByKey(anchor.key) : undefined;
    return { end: false, scroll: state.scroll, key: anchor?.key ?? null, position: position ?? null };
  }, [listRef]);
  const holdPlace = useCallback(
    (place: Place | null) => {
      if (!place) return;
      const hold = ++holding.current;
      dragging.current = false;
      const until = Date.now() + HOLD_MS;
      const check = () => {
        if (dragging.current || holding.current !== hold) return;
        const list = listRef.current;
        const state = list?.getState();
        if (list && state) {
          const fix = placeCorrection(place, {
            scroll: state.scroll,
            distanceFromEnd: state.distanceFromEnd,
            positionOf: state.positionByKey,
          });
          if (fix === "end") void list.scrollToEnd({ animated: false });
          else if (fix !== null) void list.scrollToOffset({ offset: fix, animated: false });
        }
        if (Date.now() < until) requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    },
    [dragging, holding, listRef],
  );
  // Stickers play in the rows in view (a few of them), never under a sheet (ADR 0091).
  const [stickers] = useState(createStickerStage);
  useEffect(() => sheet.subscribe(stickers.setCovered), [sheet, stickers]);
  // While something covers the conversation (a sheet, the agent's computer) the list ignores the keyboard: one that
  // opens and closes under the cover (a sheet's own field) must not move it. A keyboard already up leaves first, the
  // list going down with it as with any keyboard closing: frozen while it left, the list kept its room, and a
  // keyboard-tall gap stood over the dock until it dropped all at once after the cover closed.
  const freeze = useSharedValue(false);
  const covered = useRef(false);
  const freezeOnHide = useRef(false);
  const cover = useCallback(() => {
    covered.current = true;
    if (KeyboardController.isVisible()) freezeOnHide.current = true;
    else freeze.value = true;
  }, [freeze]);
  // `now`: back on screen (a pushed screen popped), released at once when no keyboard is up or leaving: kept frozen
  // a moment more, a quick tap on the field raised the keyboard and the dock over the last messages, and the list
  // snapped up after. A keyboard still about (a form sent from JS, closing as it pops) keeps the delay.
  const uncover = useCallback(
    (now = false) => {
      covered.current = false;
      freezeOnHide.current = false;
      if (now && !KeyboardController.isVisible()) {
        freeze.value = false;
        return;
      }
      setTimeout(() => {
        if (!covered.current) freeze.value = false;
      }, FREEZE_AFTER_MS);
    },
    [freeze],
  );
  useEffect(() => {
    const gone = KeyboardEvents.addListener("keyboardDidHide", () => {
      if (!freezeOnHide.current) return;
      freezeOnHide.current = false;
      if (covered.current) freeze.value = true;
    });
    return () => gone.remove();
  }, [freeze]);
  // A glide (`GLIDE`) holds the keyboard list's room still meanwhile: its instant shift for the dock changing under a
  // message just sent (the field back to one line, the reply bar leaving) cut the motion short. It ends `GLIDE_MS`
  // later; a cover that came meanwhile keeps its own hold.
  useLayoutEffect(() => {
    if (glide === 0) return;
    if (!covered.current) freeze.value = true;
    const timer = setTimeout(() => {
      setGlide(0);
      if (!covered.current) freeze.value = false;
    }, GLIDE_MS);
    return () => clearTimeout(timer);
  }, [glide, freeze, setGlide]);
  // Every sheet of this screen says when it opens (before the keyboard leaves) and closes: one place for all of
  // them (the header's, a message's, the composer's).
  useEffect(() => {
    let place: Place | null = null;
    let aimedAt = 0;
    return sheet.subscribe((open) => {
      if (open) {
        // A sheet opened from another keeps the place taken by the first.
        if (!covered.current) {
          place = placeNow();
          aimedAt = aimed.current;
        }
        cover();
        holdPlace(place);
        return;
      }
      uncover();
      // Unless the app moved the list on purpose meanwhile (a message sent from the sheet).
      if (aimed.current === aimedAt) holdPlace(place);
    });
  }, [sheet, aimed, cover, uncover, placeNow, holdPlace]);
  // The agent's computer opens full screen: where the conversation was is kept, and given back on return.
  const away = useRef<Place | null>(null);
  const left = useRef(false);
  const leavePlace = useCallback(() => {
    away.current = placeNow();
    left.current = true;
    holdPlace(away.current);
    cover();
    Keyboard.dismiss();
  }, [placeNow, holdPlace, cover]);
  useFocusEffect(
    useCallback(() => {
      if (!left.current) return;
      left.current = false;
      holdPlace(away.current);
      uncover(true);
    }, [holdPlace, uncover]),
  );
  return {
    freeze,
    leavePlace,
    // Where the person is, for the same conversation opened on the other display (ADR 0212, `reading-place.ts`).
    placeNow,
    stickers,
  };
}

export type KeepPlace = ReturnType<typeof useKeepPlace>;
