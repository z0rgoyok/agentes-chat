import { createContext, useContext } from "react";

/**
 * The way back a split's list pane offers when its screen was pushed (ADR 0212: You and the workspace's settings beside
 * their pages): the screen's own bar is hidden while it shows two panes, so the list's bar holds the back button the
 * navigator's bar held. The detail pane never has one: the list stands beside it.
 */
export interface PaneBack {
  label: string;
  onPress: () => void;
}

export const PaneBackContext = createContext<PaneBack | null>(null);

/** The back button of the pane the screen is drawn in; null in a detail pane, a tab's list, or outside a pane. */
export const usePaneBack = () => useContext(PaneBackContext);
