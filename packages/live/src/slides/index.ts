/** Presentations (ADR 0196 §2): the deck's shape, themes, layouts, edits, office data, preview and text. */
export { initSlides, replaceSlides, slideByNumber, slidesPreview, slidesText, validateSlides } from "./content";
export { slidesFromData, slidesToData } from "./data";
export { FALLBACK_SLOTS, LAYOUTS, type LayoutSlot, roleFamily, slotFor } from "./layouts";
export {
  addElement,
  addSlide,
  arrange,
  arrange as arrangeElements,
  defaultBox,
  deleteElements,
  deleteSlides,
  duplicateSlide,
  elementTextFragment,
  moveSlide,
  setBackground,
  setHidden,
  setLayout,
  setNotes,
  setTheme,
  slideNotes,
  updateElement,
} from "./ops";
export {
  cleanChart,
  cleanStyle,
  cleanTable,
  deckTheme,
  readDeck,
  readElement,
  readElements,
  readSlide,
  SLIDE_CHART_LIMITS,
  SLIDE_TABLE_LIMITS,
  slideIdsOf,
} from "./store";
export {
  chartColors,
  DEFAULT_THEME,
  type HeadingFont,
  SLIDE_H,
  SLIDE_W,
  type SlideTheme,
  shapeFill,
  type TextLook,
  THEMES,
  textLook,
  themeOf,
} from "./themes";
export * from "./types";
