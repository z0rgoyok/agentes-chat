/**
 * The outside chat surface this server bridges to (ADR 0187), set once at boot from `SURFACE_*`.
 * Process-wide like the operator events switch: null means the bridge is off and nothing about it shows.
 */

/** Versioned because the service that calls it deploys apart from this server. */
export const SURFACE_PREFIX = "/api/surface/v1";

export interface SurfaceConfig {
  /** The lower-cased name: what rows and `meta.via` store. */
  id: string;
  name: string;
  /** Holds `{text}` once. */
  openUrl: string;
  /** Lower-cased emails that may link while the operator tries it; null: everyone. */
  only: string[] | null;
}

let current: SurfaceConfig | null = null;

export function setSurface(config: SurfaceConfig | null): void {
  current = config;
}

export function surfaceOn(): SurfaceConfig | null {
  return current;
}

export function surfaceAllowed(email: string): boolean {
  if (!current) return false;
  return current.only === null || current.only.includes(email.toLowerCase());
}

/** The surface from the server's config, or null without its token. */
export function surfaceFromConfig(config: {
  SURFACE_BRIDGE_TOKEN?: string;
  SURFACE_NAME?: string;
  SURFACE_OPEN_URL?: string;
  SURFACE_ONLY?: string[];
}): SurfaceConfig | null {
  if (!config.SURFACE_BRIDGE_TOKEN || !config.SURFACE_NAME || !config.SURFACE_OPEN_URL) return null;
  return {
    id: config.SURFACE_NAME.toLowerCase(),
    name: config.SURFACE_NAME,
    openUrl: config.SURFACE_OPEN_URL,
    only: config.SURFACE_ONLY?.length ? config.SURFACE_ONLY : null,
  };
}
