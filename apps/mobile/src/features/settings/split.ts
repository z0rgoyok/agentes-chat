import type { OrgSummary } from "@agenteschat/client";
import { createSplitStore, type SplitStore } from "../shared/split-store";
import { SETTINGS_SECTIONS, visibleSections } from "./logic";

/**
 * The workspace's settings in two panes (ADR 0212: the iPhone Duo's inner display, a large screen): which section's
 * screen stands beside the list, by its address, kept per workspace (`split-store.ts`). Pure but for the store, so the
 * tests run it.
 */

/** Your account, a personal workspace's first row (ADR 0159 §3). */
export const ACCOUNT_PAGE = "/me/account";
/** Advanced, a personal workspace's last row: every section its short list leaves out. */
export const ADVANCED_PAGE = "/settings/advanced";

/**
 * Every page a row of the settings' list opens: each section's screen, and a personal workspace's Your account and
 * Advanced. Deleting or resetting the workspace stays a flow of its own, pushed after its alert.
 */
export const SETTINGS_PAGES: readonly string[] = [...SETTINGS_SECTIONS.map((s) => s.href), ACCOUNT_PAGE, ADVANCED_PAGE];

/** The section whose screen stands beside the settings' list. */
export const settingsSplit: SplitStore<string> = createSplitStore((href: string) => href);

/**
 * What stands beside the list while no row is chosen: its first row (a personal workspace's Your account; a team's
 * first section this person opens). Never pushed when the device closes.
 */
export function settingsFallback(personal: boolean, org: OrgSummary | null | undefined): string | null {
  if (personal) return ACCOUNT_PAGE;
  return visibleSections(org)[0]?.href ?? null;
}
