/**
 * The phone's page rhythm: a screen's content 16 from its sides, a card's content 16 inside it, a toolbar's controls
 * (Segmented, Filters) 32 tall with their target grown to 44. Grouped rows are 52 with 10 above and below and 16 at the
 * sides, as the system's own grouped lists on the current iOS (taller than the web's 44: a finger, not a pointer, and
 * an icon's tile with room around it). A row whose text wraps starts its label where a one-line row's sits: its
 * 22-point line centred in 52. Whatever leads a row (an icon's tile, a face) sits in one 36-point column, so the text
 * and the hairline over the row start together at 64 (16 + 36 + the row's 12 gap).
 */
export const SCREEN_X = 16;
export const CARD_PAD = 16;
export const TOOL_H = 32;
export const TOUCH = 44;
export const GROUPED_ROW = { minHeight: 52, padX: 16, padY: 10, tallPadY: (52 - 22) / 2, lead: 36 } as const;

/**
 * A sheet's content sits as far from its sides as a screen's (every sheet: the ones a screen opens, their steps and the
 * ones that are routes), with 12 between its blocks (a title, a field, a list).
 */
export const SHEET_X = SCREEN_X;
export const SHEET_GAP = 12;

/**
 * The bar of a task sheet (`SheetBar`): 50 tall, so its 40-point close plate has room around it, and 14 under the
 * sheet's top edge, clear of the system's grabber (5 tall, 5 from the top).
 */
export const SHEET_BAR = { height: 50, top: 14 } as const;
