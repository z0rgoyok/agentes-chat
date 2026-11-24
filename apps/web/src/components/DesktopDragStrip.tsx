/**
 * Outside the workspace (sign-in, onboarding, the error screen): an empty strip on top that drags the window. A module
 * of its own: the title bar's (`DesktopTitleBar`) brings the sidebar and the command menu, which the app's first load
 * and its error screen must not wait for.
 */
export function DesktopDragStrip() {
  return <div className="titlebar-strip" data-tauri-drag-region="deep" aria-hidden="true" />;
}
