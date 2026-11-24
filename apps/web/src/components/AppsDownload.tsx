import { formatBytes } from "@agenteschat/client/lib/files";
import { Button, Card, ComputerPortrait, type PortraitKind, ProviderLogo } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { DownloadButtons, useDesktopDownloads } from "@/components/devices/parts";
import { useDesktopHere } from "@/hooks/useDesktopHere";
import { inDesktopApp } from "@/lib/desktop";
import { usePhoneStores } from "@/lib/phone-apps";
import "./apps-download.css";

/**
 * Configurações › Apps do agentes.chat: the desktop app for the computer this page is open on (its build, version and
 * size, the other systems in a menu, the public `/download` page for the install steps), and the phone apps
 * (`usePhoneStores`). Inside the desktop app, the computer part says so instead of offering it again.
 */
export function AppsDownloadSection() {
  const { t, i18n } = useTranslation();
  const here = useDesktopHere();
  const { latest, mine } = useDesktopDownloads();
  const release = mine ? latest[mine.id].data : null;
  const kind: PortraitKind = here?.target === "windows" ? "windows" : here?.target === "linux" ? "linux" : "mac";
  const inApp = inDesktopApp();
  const stores = usePhoneStores();
  return (
    <div className="gapps">
      <Card padded aria-labelledby="gapps-computer">
        <div className="ac-faceline">
          <ComputerPortrait kind={kind} state="online" />
          <div className="gapps__main">
            <h2 id="gapps-computer" className="gapps__title ac-captop">
              {t("appsDownload.computer")}
            </h2>
            <p className="gapps__text">{t(inApp ? "appsDownload.inApp" : "appsDownload.computerText")}</p>
            {!inApp && (
              <div className="gapps__acts">
                <DownloadButtons primary />
                {release && (
                  <span className="gapps__meta">
                    {release.size
                      ? t("install.page.versionSize", {
                          version: release.version,
                          size: formatBytes(i18n.language, release.size),
                        })
                      : t("install.page.version", { version: release.version })}
                  </span>
                )}
              </div>
            )}
            <a className="ac-link gapps__more" href="/download" target="_blank" rel="noopener noreferrer">
              {t("appsDownload.howTo")}
            </a>
          </div>
        </div>
      </Card>
      {stores.length > 0 && (
        <Card padded aria-labelledby="gapps-phone">
          <div className="ac-faceline">
            <span className="gapps__phones" aria-hidden="true">
              {stores.some((s) => s.mark === "apple") && <ComputerPortrait kind="iphone" state="online" />}
              <ComputerPortrait kind="android" state="online" />
            </span>
            <div className="gapps__main">
              <h2 id="gapps-phone" className="gapps__title ac-captop">
                {t("appsDownload.phone")}
              </h2>
              <p className="gapps__text">{t("appsDownload.phoneText")}</p>
              <div className="gapps__acts">
                {stores.map((s) => (
                  <Button key={s.id} asChild size="sm">
                    <a href={s.href} target="_blank" rel="noopener noreferrer">
                      <ProviderLogo id={s.mark} size="xs" />
                      {t(`appsDownload.${s.id}`)}
                    </a>
                  </Button>
                ))}
              </div>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
