import { Logo } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { AppsDownloadSection } from "@/components/AppsDownload";
import { LanguageSelect } from "@/components/LanguageSelect";
import { useDocumentTitle } from "@/lib/desktop";

/** Public entry point for the same managed releases offered in Settings. */
export function DownloadPage() {
  const { t } = useTranslation();
  useDocumentTitle("Tich Rooms");
  return (
    <div className="dlp">
      <header className="dlp__bar">
        <Link to="/" aria-label={t("legal.home")}>
          <Logo size={24} />
        </Link>
        <LanguageSelect signedIn={false} align="end" />
      </header>
      <main className="dlp__main">
        <h1>Tich Rooms</h1>
        <AppsDownloadSection />
      </main>
    </div>
  );
}
