import { Button, Card, ComputerPortrait, ProviderLogo } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { usePhoneStores } from "@/lib/phone-apps";
import "./apps-download.css";

/** Downloads of the managed Tich Rooms phone apps. */
export function AppsDownloadSection() {
  const { t } = useTranslation();
  const stores = usePhoneStores();
  return (
    <div className="gapps">
      {stores.length > 0 && (
        <Card padded aria-labelledby="gapps-phone">
          <div className="ac-faceline">
            <span className="gapps__phones" aria-hidden="true">
              <ComputerPortrait kind="android" state="online" />
            </span>
            <div className="gapps__main">
              <h2 id="gapps-phone" className="gapps__title ac-captop">
                {t("appsDownload.phone")}
              </h2>
              <p className="gapps__text">{t("appsDownload.androidText")}</p>
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
