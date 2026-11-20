/**
 * iOS 26's bar as it lays out (measured on a device): 20 from each side, the back button 44 wide, the title 20 from what
 * stands beside it, and the right buttons 44 each and 16 apart in one glass group (our counted views first, as wide as
 * they measure).
 */
const GLASS_BAR = { side: 20, button: 44, gap: 20, between: 16 } as const;
/** The narrowest the pill gets: its face and a few letters, never under the buttons. */
const PILL_MIN = 96;

/**
 * The conversation pill's room between the back button and the right buttons (`HeaderPill`): `extra` system buttons
 * besides "…" and `lead` points of our own views first in their group. `liquid`: iOS 26's glass bar; otherwise our own
 * 44-point buttons side by side (Android, older iOS). Pure, so its numbers are tested.
 */
export function pillRoom(screen: number, extra: number, lead: number, liquid: boolean): number {
  if (liquid) {
    const { side, button, gap, between } = GLASS_BAR;
    const items = extra + 1 + (lead > 0 ? 1 : 0);
    const group = lead + (extra + 1) * button + (items - 1) * between;
    return Math.max(PILL_MIN, screen - (side + button + gap) - (gap + group + side));
  }
  // The bar's margins, the back and "…" circles and a gap on each side; our buttons 44 each, the counted views as wide
  // as they are.
  return Math.max(PILL_MIN, screen - 152 - extra * 44 - lead);
}
