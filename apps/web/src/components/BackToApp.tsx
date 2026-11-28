import { Button } from "@agenteschat/ui";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

/**
 * How long after sending the link a blur is the browser's own "Open the app?" question taking focus (Chrome's does),
 * not the app coming forward.
 */
export const ASK_BLUR_MS = 1500;

/**
 * The browser's page hands the person back to the desktop app through the app's `link` (the browser asks the first
 * time), once. The tab then tries to close as the app comes forward: browsers refuse it for a tab the system opened
 * that has moved on since (a provider's round trip), so the page also says so and keeps `OpenAppButton`. Not on the
 * blur the question itself makes: a tab that may close (all redirects, history of one) would take the question, and
 * a connector's one-time code with it.
 */
export function useBackToApp(link: string | null) {
  const sent = useRef<string | null>(null);
  useEffect(() => {
    if (!link || sent.current === link) return;
    sent.current = link;
    const at = Date.now();
    window.location.assign(link);
    // A time guard, not a signal: a person who answers the question within it keeps the tab (and its button).
    const close = () => {
      if (Date.now() - at >= ASK_BLUR_MS) window.close();
    };
    window.addEventListener("blur", close);
    return () => window.removeEventListener("blur", close);
  }, [link]);
}

/** The same link by hand, for a browser that didn't ask or a question the person dismissed. */
export function OpenAppButton({ link }: { link: string }) {
  const { t } = useTranslation();
  return (
    <Button asChild size="lg" block>
      <a href={link}>{t("auth.desktop.openApp")}</a>
    </Button>
  );
}
