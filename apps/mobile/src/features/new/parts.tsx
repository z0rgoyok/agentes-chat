import { SheetBar } from "@/ui";
import { router } from "@/ui/navigation";
import type { AppHref } from "../links/logic";
import { goBack } from "../shared/parts";

/**
 * Pieces of the forms "New" opens (the "+" of the tabs), each a native form sheet: the title row, and leaving every
 * sheet to open what was just made.
 */

/**
 * The sheet's bar in a sheet's padded body: the task sheets' `SheetBar` (the title centered, × on the left), its sides
 * and its room under the grabber the body's own. × closes this sheet only: one presented over another (Add workspace
 * over the workspaces) shows the one under it again, as a flick down does; nothing draws a back inside a sheet.
 */
export function SheetHeader({
  title,
  onPress,
}: {
  title: string;
  /** Instead of closing the route's sheet: a sheet the screen opens itself, closed its own way. */
  onPress?: () => void;
}) {
  return <SheetBar inset title={title} onClose={onPress ?? (() => goBack())} />;
}

/** Closes the sheets and screens over the tabs ("New" and its forms), then opens `href` (a new conversation) there. */
export function closeSheetsAndOpen(href: AppHref) {
  if (router.canDismiss()) router.dismissAll();
  setTimeout(() => router.push(href), 60);
}
