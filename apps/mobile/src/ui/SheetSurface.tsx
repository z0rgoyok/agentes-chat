import type { ReactNode } from "react";
import { SheetContent } from "./Sheet";

/**
 * What a route sheet's content sits in (`Sheet.Screen` in the app's layouts, `useRouteSheetOptions`): gestures' own
 * root in the sheet's window, the sheet's colors (in dark, a step above the screen behind it and its cards one more,
 * `sheetColors`), filling the sheet's height. The system draws the grabber. A content with its own scroll view tells
 * the sheet about it (`useRouteSheetScrollable`).
 */
export function SheetSurface({ children, fit = false }: { children: ReactNode; fit?: boolean }) {
  return <SheetContent fill={!fit}>{children}</SheetContent>;
}
