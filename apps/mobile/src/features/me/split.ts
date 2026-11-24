import { createSplitStore, type SplitStore } from "../shared/split-store";

/**
 * Você in two panes (ADR 0212: the iPhone Duo's inner display, a large screen): which of its pages stands beside its
 * list, by its address, kept per workspace (`split-store.ts`). Pure but for the store, so the tests run it.
 */

/**
 * Você's own pages, each opened beside the list there: Status, every preference a row pushes, About and Account (the
 * bar's Editar). What isn't one of them keeps being pushed: the workspaces, the workspace's settings, an agent, the
 * work (tasks, Drive…). Sounds and Appearance change in their row's menu, with no page.
 */
export const ME_PAGES = [
  "/me/status",
  "/me/notifications",
  "/me/approvals",
  "/me/start",
  "/me/activity",
  "/me/chat-look",
  "/me/agent-style",
  "/me/app-icon",
  "/me/language",
  "/me/about",
  "/me/account",
] as const;

export type MePageHref = (typeof ME_PAGES)[number];

/**
 * What stands beside the list while no page is chosen: the first preference, Notifications (always listed, in either
 * kind of workspace). Never pushed when the device closes.
 */
export const ME_FALLBACK: MePageHref = "/me/notifications";

/** The page standing beside Você's list. */
export const meSplit: SplitStore<string> = createSplitStore((href: string) => href);
