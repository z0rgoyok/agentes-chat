import { type HostLook, useAuthConfig } from "@agenteschat/client";
import { DOCS_SITE } from "@agenteschat/i18n/docs";
import { Logo } from "@agenteschat/ui";
import { type ReactNode, useRef } from "react";
import { useTranslation } from "react-i18next";
import { AuthHorizon } from "@/components/Sky";
import { useWorkspaceAccent } from "@/lib/theme";
import { LanguageSelect } from "./LanguageSelect";
import "./auth.css";

/**
 * Sign in, sign up and new password: one calm question at a time in a narrow
 * column, the logo on top, the language beside it (signed out: the next sign-in sends it) and the sky's horizon at
 * the bottom. `languages={false}` for a signed-in screen in that look, already in the person's language.
 */
export function AuthShell({ children, languages = true }: { children: ReactNode; languages?: boolean }) {
  // A registered host (ADR 0194): its look in place of the product's, here only.
  const host = useAuthConfig().data?.host ?? null;
  return (
    <AuthFrame host={host} languages={languages}>
      {children}
    </AuthFrame>
  );
}

/** `AuthShell`'s look for a known `host` (null: the product's own), asking the server nothing. */
export function AuthFrame({
  host = null,
  languages = true,
  children,
}: {
  host?: HostLook | null;
  languages?: boolean;
  children: ReactNode;
}) {
  const col = useRef<HTMLElement>(null);
  const { t } = useTranslation();
  return (
    <div className={host ? "auth auth--host" : "auth"}>
      {/* Signed out only: a `languages={false}` screen shows inside a workspace, whose shell paints its own accent. */}
      {host && languages && <HostAccent accent={host.accent} />}
      <AuthHorizon clear={() => [col.current]} />
      <span className="auth__logo">{host ? <HostLockup host={host} /> : <Logo size={24} />}</span>
      {languages && (
        <span className="auth__lang">
          <LanguageSelect signedIn={false} align="end" />
        </span>
      )}
      <main className="auth__col" ref={col}>
        {children}
        {host?.poweredBy && (
          <p className="auth__powered">
            <a className="ac-link" href={DOCS_SITE}>
              {t("auth.poweredBy")}
            </a>
          </p>
        )}
      </main>
    </div>
  );
}

/** A registered host's accent on the document while a page before sign-in shows (`useWorkspaceAccent`). */
function HostAccent({ accent }: { accent: string | null }) {
  useWorkspaceAccent(accent);
  return null;
}

/** A registered host's logo, or its name alone in the heading face when it has none. */
function HostLockup({ host }: { host: HostLook }) {
  return host.logoUrl ? (
    <img className="auth__host-logo" src={host.logoUrl} alt={host.name} />
  ) : (
    <span className="auth__host-name">{host.name}</span>
  );
}

/** Centered card of the invitation and onboarding pages. */
export function CenteredLayout({ narrow, children }: { narrow?: boolean; children: ReactNode }) {
  return (
    <div className="center">
      <Logo size={24} />
      <main className={narrow ? "center__card center__card--narrow" : "center__card"}>{children}</main>
    </div>
  );
}
