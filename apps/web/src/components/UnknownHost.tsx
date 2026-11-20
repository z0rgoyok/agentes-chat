import { Button, LogoMark } from "@agenteschat/ui";
import type { i18n as I18n } from "i18next";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider, useTranslation } from "react-i18next";
import { AuthFrame } from "@/components/AuthLayout";
import { useDocumentTitle } from "@/lib/desktop";
import "@/components/auth.css";

/** The page on a hostname the server marked `data-unknown-host` (ADR 0194): the address isn't set up yet. */
export function UnknownHost() {
  const { t } = useTranslation();
  useDocumentTitle(t("empty.unknownHostTab"));
  return (
    <AuthFrame>
      <div className="auth__notice">
        <LogoMark size={48} />
        <h1>{t("empty.unknownHostTitle")}</h1>
        <p>{t("empty.unknownHostText")}</p>
        <Button variant="primary" size="lg" icon="refresh" onClick={() => window.location.reload()}>
          {t("common.retry")}
        </Button>
      </div>
    </AuthFrame>
  );
}

/** Whether the server marked this page as on a hostname it doesn't answer for. */
export const onUnknownHost = () => document.documentElement.hasAttribute("data-unknown-host");

/** Draws `UnknownHost` in #root. The returned promise never settles, so an entry that awaits it starts nothing else. */
export function showUnknownHost(i18n: I18n): Promise<never> {
  const root = document.getElementById("root");
  if (!root) throw new Error("#root element missing from index.html");
  document.documentElement.lang = i18n.language;
  createRoot(root).render(
    <StrictMode>
      <I18nextProvider i18n={i18n}>
        <UnknownHost />
      </I18nextProvider>
    </StrictMode>,
  );
  return new Promise<never>(() => {});
}
