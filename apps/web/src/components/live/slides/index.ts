/**
 * Presentations ("Apresentação", ADR 0196 §2): `Slides` is the editor the live file page draws for `slides`,
 * `SlideThumb` a slide drawn small (the rail, cards, the Drive), `DeckView` a deck to look at (an uploaded `.pptx`,
 * ADR 0198). `deckViewOf` turns an office deck into what they draw.
 */
export { DeckView, deckViewOf } from "./DeckView";
export { SlideImages } from "./render";
export { Slides } from "./Slides";
export { SlideThumb } from "./SlideThumb";
