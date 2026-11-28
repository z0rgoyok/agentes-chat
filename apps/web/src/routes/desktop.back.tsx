import { createFileRoute } from "@tanstack/react-router";
import { DesktopBackPage } from "@/pages/DesktopBackPage";

/** The browser's tab after a round trip the desktop app started: the app's link in the fragment (DesktopBackPage). */
export const Route = createFileRoute("/desktop/back")({ component: DesktopBackPage });
