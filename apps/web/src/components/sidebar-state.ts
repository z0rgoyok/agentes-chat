import { useSyncExternalStore } from "react";
import { STORAGE_KEYS, storage } from "@/lib/storage";
import { useMediaQuery } from "./NavDrawer";

/*
 * Whether the sidebar is its icon rail, apart from the sidebar itself (Sidebar.tsx): the title bar, the menus and
 * live pages read and change it without bringing the sidebar's code with them.
 */

/** Tablet widths: the sidebar starts as an icon rail (NavDrawer.tsx has the other breakpoints). */
export const TABLET_QUERY = "(min-width: 761px) and (max-width: 1199px)";

/**
 * The sidebar shrunk to its icon rail, shared with the Mac app's title bar, which carries the toggle there
 * (DesktopTitleBar.tsx). Desktop widths remember the person's choice (in memory too, for when storage is blocked).
 * Tablet widths start as the rail every time: their toggle opens the whole sidebar over the page until a link, Esc,
 * a click outside or the toggle closes it, since the page's tablet layout has no room for it beside.
 */
const SIDEBAR_EVENT = "agentes:sidebar";
let sidebarCollapsed = storage.get(STORAGE_KEYS.sidebarCollapsed) === "1";
let tabletOpen = false;
/**
 * A page that runs out of room asked for the rail (a live file with its conversation beside it, ADR 0199): shown as
 * the rail on desktop widths, never stored, so the person's own choice comes back when the page lets go.
 */
let roomAsked = false;
/** How many times the person used the toggle (any page): a page that asked for the room stops at their hand. */
let handToggles = 0;
export const onSidebarChange = (cb: () => void) => {
  window.addEventListener(SIDEBAR_EVENT, cb);
  return () => window.removeEventListener(SIDEBAR_EVENT, cb);
};
const isTablet = () => typeof window.matchMedia === "function" && window.matchMedia(TABLET_QUERY).matches;
export const toggleSidebar = () => {
  handToggles += 1;
  if (isTablet()) tabletOpen = !tabletOpen;
  // Shrunk for a page's room: the toggle gives the person their sidebar back (their stored choice, open).
  else if (roomAsked) roomAsked = false;
  else {
    sidebarCollapsed = !sidebarCollapsed;
    storage.set(STORAGE_KEYS.sidebarCollapsed, sidebarCollapsed ? "1" : "0");
  }
  window.dispatchEvent(new Event(SIDEBAR_EVENT));
};
/** A page asks for the sidebar's room (its rail) or lets it go; the person's stored choice is untouched. */
export const askSidebarRoom = (asked: boolean) => {
  if (roomAsked === asked) return;
  roomAsked = asked;
  window.dispatchEvent(new Event(SIDEBAR_EVENT));
};
/** The toggle's count so far: a page compares it to tell the person's hand from its own ask. */
export const sidebarHandToggles = () => handToggles;
/** A tablet's open sidebar back to its rail. */
export const closeTabletSidebar = () => {
  if (!tabletOpen) return;
  tabletOpen = false;
  window.dispatchEvent(new Event(SIDEBAR_EVENT));
};
/** Whether the sidebar is its icon rail at this width (a phone's drawer never reads it), and its toggle. */
export function useSidebarCollapsed(): [boolean, () => void] {
  const tablet = useMediaQuery(TABLET_QUERY);
  const collapsed = useSyncExternalStore(
    onSidebarChange,
    () => (tablet ? !tabletOpen : sidebarCollapsed || roomAsked),
    () => false,
  );
  return [collapsed, toggleSidebar];
}

/** File → Novo canal in the desktop app's menu bar (DesktopMenus.tsx): the sidebar opens its dialog. */
export const NEW_CHANNEL_EVENT = "agentes:new-channel";
