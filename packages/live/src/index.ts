/**
 * Live files (ADR 0196): what the server, the web, the desktop app and the phone must agree on about spreadsheets,
 * presentations, canvases and documents (ADR 0200) edited together: the documents' shape, formulas, number formats,
 * rich text, the sync protocol and presence. Pure TypeScript: no DOM, no React, no Node built-ins.
 *
 * Presentations and canvases both have an `arrange`: here it is the slides' (also `arrangeElements`), and the canvas's
 * is `arrangeShapes` (each is plain `arrange` in its own entry, "./slides" and "./canvas").
 */
export * from "./awareness";
export * from "./base64";
export * from "./canvas";
export * from "./colors";
export * from "./document";
export * from "./effects";
export * from "./errors";
export * from "./fonts";
export * from "./fractional";
export * from "./groups";
export * from "./ids";
export * from "./kinds";
export * from "./origins";
export * from "./protocol";
export * from "./restore";
export * from "./rich";
export * from "./slides";
export { arrange } from "./slides";
export * from "./spreadsheet";
