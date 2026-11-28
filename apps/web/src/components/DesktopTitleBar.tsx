import { Button } from "@agenteschat/ui";
import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useNavDrawer } from "./NavDrawer";
import { WorkspaceSky } from "./Sky";
import { useSidebarCollapsed } from "./sidebar-state";

/**
 * The Mac app's title bar (ADR 0036): room for the window's own buttons, the sidebar toggle, back and forward, and
 * nothing else. ⌘K and Agora stay in the sidebar, as on the web (only its collapse goes, desktop.css), so nothing sits
 * at the bar's right end, under Windows' and Linux's own close button. Anywhere that isn't a button drags the window
 * (`data-tauri-drag-region`, the only thing the window may ask of the app). In
 * the workspace only; elsewhere `DesktopDragStrip` keeps the top draggable.
 */
export function DesktopTitleBar() {
  const { t } = useTranslation();
  const router = useRouter();
  const [collapsed, toggleSidebar] = useSidebarCollapsed();
  // A window narrow enough for the drawer (the app's minimum is under it): the same button opens and closes it.
  const drawer = useNavDrawer();
  const inDrawer = !!drawer?.compact;
  const shown = inDrawer ? drawer.open : !collapsed;
  const navLabel = inDrawer
    ? t(drawer.open ? "shell.closeNav" : "shell.openNav")
    : t(collapsed ? "shell.expandNav" : "shell.collapseNav");

  // ⌘[ and ⌘], as in every Mac app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.altKey || e.ctrlKey || e.shiftKey) return;
      if (e.key === "[") router.history.back();
      else if (e.key === "]") router.history.forward();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  return (
    <header className="titlebar" data-tauri-drag-region="deep">
      {/* Over the sidebar, the workspace's sky goes on up behind the window's buttons (one sky with its header). */}
      <WorkspaceSky part="bar" rail={collapsed} />
      <nav className="titlebar__nav">
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon="sidebar"
          data-sidebar-toggle=""
          aria-label={navLabel}
          title={navLabel}
          aria-expanded={shown}
          onClick={inDrawer ? drawer.toggle : toggleSidebar}
        />
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon="chevronLeft"
          aria-label={t("shell.titleBar.back")}
          title={`${t("shell.titleBar.back")} (⌘[)`}
          onClick={() => router.history.back()}
        />
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon="chevronRight"
          aria-label={t("shell.titleBar.forward")}
          title={`${t("shell.titleBar.forward")} (⌘])`}
          onClick={() => router.history.forward()}
        />
      </nav>
    </header>
  );
}
