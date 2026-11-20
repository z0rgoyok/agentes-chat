import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The app's screens under its sheets: app/(app)/(main), its layout and its routes. */
export const MAIN = join(import.meta.dir, "..", "app", "(app)", "(main)");

export const mainLayout = () => readFileSync(join(MAIN, "_layout.tsx"), "utf8");

/** What the main stack's layout sets for `name` by itself (its entry in `own`), or null: the stack's default. */
export function ownOptionsOf(name: string, layout = mainLayout()): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*"?${escaped}"?: (.+)$`, "m").exec(layout)?.[1] ?? null;
}

/**
 * Whether the route `name` (under app/(app)/(main)) is pushed with the stack's default: its bar, the back button and
 * content scrolling under the bar. Every route is, unless the layout lists it among its own.
 */
export function pushedByDefault(name: string): boolean {
  const layout = mainLayout();
  return (
    existsSync(join(MAIN, `${name}.tsx`)) &&
    layout.includes("own[route.name] ?? page") &&
    ownOptionsOf(name, layout) === null
  );
}
