import { type ComponentProps, type ComponentType, createElement, lazy } from "react";

const loaders = new Set<() => Promise<unknown>>();

/**
 * A dialog whose code comes when it first renders (React's `lazy`) and, before that, in the background once the
 * workspace's first page is up (`preloadDialogs`): the first page doesn't wait for it, and opening it doesn't either.
 * Once its code is here it renders directly: a `lazy` still suspends on its first render even with its code loaded,
 * and React holds suspended content back for a moment before showing it.
 */
// biome-ignore lint/suspicious/noExplicitAny: the same bound as React's own `lazy`, any component's props
export function lazyDialog<T extends ComponentType<any>>(load: () => Promise<T>) {
  let loaded: T | null = null;
  let loading: Promise<T> | null = null;
  const get = () => {
    loading ??= load().then(
      (component) => {
        loaded = component;
        return component;
      },
      (error: unknown) => {
        // A failed fetch (offline, a deploy in between) tries again on the next open.
        loading = null;
        throw error;
      },
    );
    return loading;
  };
  loaders.add(get);
  const Lazy = lazy(() => get().then((component) => ({ default: component })));
  function Dialog(props: ComponentProps<T>) {
    "use no memo";
    const Shown = (loaded ?? Lazy) as ComponentType<ComponentProps<T>>;
    return createElement(Shown, props);
  }
  return Dialog;
}

/** How long after the workspace's first page the dialogs' code starts coming, when the browser has no idle signal. */
const PRELOAD_DELAY_MS = 2_500;

/**
 * Fetches every `lazyDialog` known so far while the browser is idle, a few seconds after the first page, all at once
 * (they're independent files); a failure is left for the dialog's own open.
 */
export function preloadDialogs() {
  if (import.meta.env?.MODE === "test") return;
  const run = () => {
    for (const load of loaders) void load().catch(() => undefined);
  };
  const idle = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
    .requestIdleCallback;
  const timer = window.setTimeout(() => (idle ? idle(run, { timeout: PRELOAD_DELAY_MS }) : run()), PRELOAD_DELAY_MS);
  return () => window.clearTimeout(timer);
}
