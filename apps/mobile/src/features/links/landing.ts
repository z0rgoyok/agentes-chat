/**
 * Where a screen lands when it leaves for another one, and the screens opened in place: pure, so the navigation
 * helpers (`@/ui/navigation`) and the tests share them. No imports, so anything may use it without a cycle.
 */

/** The tabs' roots: Conversas, Threads, Agentes, Atividade and Buscar. */
export const TAB_ROOTS = ["/", "/threads", "/agents", "/activity", "/search"] as const;

/** The signed-out side's start: like the tabs, it sits at the bottom of its stack. */
export const SIGN_IN = "/sign-in";

const pathOf = (href: string | { pathname?: string }) =>
  (typeof href === "string" ? href : (href.pathname ?? "")).split(/[?#]/)[0] ?? "";

/**
 * Whether `href` is a place already at the bottom of a stack (a tab's root, the sign-in): a screen leaving for it goes
 * back down to it instead of putting a second copy on top (expo-router makes a new route on `replace`, and the tabs
 * then sat twice in the stack).
 */
export function landsOnRoot(href: string | { pathname?: string }): boolean {
  const path = pathOf(href);
  return path === SIGN_IN || (TAB_ROOTS as readonly string[]).includes(path);
}

/** A pushed screen shown in place, without its slide (the start screen restored at launch, ADR 0108): its param. */
export const STILL_PARAM = "still";

/** `href` opened in place (`STILL_PARAM`), its other params kept. */
export const stillHref = (href: string) => `${href}${href.includes("?") ? "&" : "?"}${STILL_PARAM}=1`;

/** Whether a route's params say it was opened in place. */
export const isStill = (params: unknown): boolean =>
  typeof params === "object" && params !== null && (params as Record<string, unknown>)[STILL_PARAM] === "1";
