/**
 * Colors for a whole split into kinds (a disk by what takes it), in a fixed order: each slot's light-theme and
 * dark-theme step, validated as a set for color blindness and against the raised surfaces (`#ffffff`, `#1c1c1b`).
 * Three light steps sit under 3:1 there, so a chart using them names every part beside its amount.
 */
export const DATA_SERIES = [
  { light: "#2a78d6", dark: "#3987e5" },
  { light: "#eb6834", dark: "#d95926" },
  { light: "#1baf7a", dark: "#199e70" },
  { light: "#eda100", dark: "#c98500" },
  { light: "#e87ba4", dark: "#d55181" },
] as const;

/** What no slot names ("Other"): a neutral gray, apart from the track's tint. */
export const DATA_OTHER = { light: "#9a9a94", dark: "#6f6f6a" } as const;
