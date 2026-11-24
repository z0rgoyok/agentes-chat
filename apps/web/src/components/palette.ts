/*
 * The ⌘K palette's shortcut and its "open" signal, apart from the palette itself (CommandMenu.tsx): the shell's
 * buttons and menus need these on the app's first load, the palette only when it opens.
 */

/** ⌘K / Ctrl+K anywhere in the workspace (also when typing): opens the palette. */
export const isPaletteShortcut = (e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">) =>
  (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k";

/** Opens the palette from elsewhere (a button). */
export const openPalette = () => window.dispatchEvent(new Event("agentes:palette"));
