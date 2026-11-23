import { accentSky, isAccentHex } from "@agenteschat/tokens/accent";
import { DEFAULT_SKY, type SkyPair } from "../agent/engine.js";

/**
 * A workspace's own `sky` (ADR 0193), whatever workspace is shown now: its accent's pair, or the landing's blue
 * without one. For a mark drawn for a workspace other than the active one, where the engine's `sky` is the active one's.
 */
export const workspaceSky = (accent: string | null | undefined): SkyPair =>
  isAccentHex(accent) ? accentSky(accent.toLowerCase()) : DEFAULT_SKY;
