import { useMatchMedia } from "@agenteschat/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { askSidebarRoom, onSidebarChange, sidebarHandToggles } from "@/components/Sidebar";

/*
 * The room a live file's page has (ADR 0196 §9, ADR 0199), measured on the page itself, since the window alone doesn't
 * say it: the conversation docked beside it and the sidebar take their part. Narrow, the header folds; squeezed by a
 * docked conversation, the app's sidebar folds to its rail until the room comes back.
 */

/** Under this width of the page the header keeps glyphs (Present, the conversation) and puts Share into ⋯. */
export const LIVE_NARROW_PAGE = 600;
/** The file's room a docked conversation leaves before the sidebar folds to its rail: the editors' toolbars whole. */
export const FILE_ROOM_MIN = 680;
/** The room past that it takes for the sidebar to come back, so a width at the edge never flickers it. */
export const FILE_ROOM_SLACK = 48;
/** Widths where the sidebar beside the page is the person's to keep (a tablet's starts as the rail anyway). */
const SIDEBAR_KEPT = "(min-width: 1200px)";

interface RoomState {
  docked: boolean;
  desktop: boolean;
  width: number;
  /** This page asked the sidebar for its room. */
  asked: boolean;
  /** The sidebar's width when the page asked: what folding it gave the page. */
  open: number;
  /** The toggle's count when the page opened: a later one is the person's hand. */
  hand: number;
  /** The person used the toggle while here: the sidebar is theirs until the page closes. */
  handled: boolean;
}

/**
 * Watches the page's width (`page`: its element): `narrow` for the header, and, while the conversation is `docked`,
 * the sidebar folded to its rail when the file would get less than `FILE_ROOM_MIN`, back once it would keep
 * `FILE_ROOM_MIN + FILE_ROOM_SLACK` with it open. Never stored, and never against the person: a sidebar they folded
 * themselves stays folded, and once they use its toggle here the page leaves it alone.
 */
export function usePageRoom(page: HTMLElement | null, docked: boolean): { narrow: boolean } {
  const desktop = useMatchMedia(SIDEBAR_KEPT);
  const [narrow, setNarrow] = useState(false);
  const room = useRef<RoomState>({
    docked,
    desktop,
    width: 0,
    asked: false,
    open: 0,
    hand: sidebarHandToggles(),
    handled: false,
  });

  const check = useCallback(() => {
    const s = room.current;
    if (!s.docked || !s.desktop || s.handled || s.width <= 0) {
      if (s.asked) {
        s.asked = false;
        askSidebarRoom(false);
      }
      return;
    }
    const side = document.querySelector<HTMLElement>(".sidebar");
    if (!side) return;
    const sideWidth = side.getBoundingClientRect().width;
    if (!s.asked) {
      // Already the rail (the person's choice): nothing to give.
      if (s.width < FILE_ROOM_MIN && side.dataset.rail !== "true") {
        s.open = sideWidth;
        s.asked = true;
        askSidebarRoom(true);
      }
      return;
    }
    // The page's width with the sidebar open again: the same sum while the sidebar changes size, so a check halfway
    // through its change reads the same.
    if (s.width - Math.max(0, s.open - sideWidth) >= FILE_ROOM_MIN + FILE_ROOM_SLACK) {
      s.asked = false;
      askSidebarRoom(false);
    }
  }, []);

  useEffect(() => {
    if (!page || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const width = page.getBoundingClientRect().width;
      room.current.width = width;
      // No layout (a test's page): the full header.
      setNarrow(width > 0 && width < LIVE_NARROW_PAGE);
      check();
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(page);
    return () => watch.disconnect();
  }, [page, check]);

  // The conversation docked or closed, the window across the desktop width: the room asked again.
  useEffect(() => {
    room.current.docked = docked;
    room.current.desktop = desktop;
    check();
  }, [docked, desktop, check]);

  // The person's own hand on the sidebar while here: theirs from now on (the toggle already undid the page's ask).
  useEffect(
    () =>
      onSidebarChange(() => {
        const s = room.current;
        if (s.handled || sidebarHandToggles() === s.hand) return;
        s.handled = true;
        s.asked = false;
      }),
    [],
  );

  // Leaving the page gives the sidebar back.
  useEffect(
    () => () => {
      if (room.current.asked) askSidebarRoom(false);
      room.current.asked = false;
    },
    [],
  );

  return { narrow };
}
