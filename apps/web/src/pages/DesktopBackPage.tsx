import { useLocation } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { AuthShell } from "@/components/AuthLayout";
import { OpenAppButton, useBackToApp } from "@/components/BackToApp";
import { desktopLinkIn } from "@/lib/desktop";

/**
 * In the browser, after a round trip the desktop app's window started there (a connector's sign-in, a mailbox): the
 * server lands here with the app's link in the fragment (packages/engine oauth-return.ts), so the tab says where the
 * person went and keeps a way back, instead of standing on the provider's last page. Only the app's own links.
 */
export function DesktopBackPage() {
  const { t } = useTranslation();
  const link = desktopLinkIn(useLocation({ select: (l) => l.hash }));
  useBackToApp(link);
  return (
    <AuthShell>
      <div className="auth__form">
        <header className="auth__ask">
          <AgentAvatar name="agentes.chat" size="lg" expression={link ? "happy" : undefined} />
          <div className="auth__bubble" aria-live="polite">
            <h1 className="auth__title">{t(link ? "auth.desktop.back" : "auth.desktop.expired")}</h1>
          </div>
        </header>
        {link && (
          <div className="auth__step">
            <OpenAppButton link={link} />
          </div>
        )}
      </div>
    </AuthShell>
  );
}
