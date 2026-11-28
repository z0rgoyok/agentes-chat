import { noAnswer } from "@agenteschat/client/lib/errors";
import { AgentSticker, Button, PixelSpinner } from "@agenteschat/ui";
import { type ErrorComponentProps, Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useBrowserOffline } from "@/chat/offline";
import { AgentAvatar } from "@/components/AgentAvatar";
import { AuthFrame } from "@/components/AuthLayout";
import { DesktopDragStrip } from "@/components/DesktopDragStrip";
import { BootSplash } from "@/components/Sky";
import { useServerBack } from "@/hooks/useServerBack";
import { onVersionReload, reloadFresh, reloadIfStale, reloadingForNewVersion } from "@/lib/app-version";
import { inDesktopApp } from "@/lib/desktop";
import { onReportTaken, reportError, reportTaken, shortErrorId } from "@/lib/error-reports";
import { firstScreenPainted } from "@/lib/vitals";

/**
 * A page that broke, in place of the router's own screen: a short message, a reload, and the code of its report
 * (ADR 0104) for whoever asks for help, once the report is on its way. Without reports there is no code to give. It
 * stands in for the root's own component, so in the desktop app it brings the strip the window drags by and lifts
 * the app's cover. Two failures are no crash, so no report and no code: a request that got no answer, or only the
 * proxy's (the server restarting, the network gone), which opens again by itself once the server answers, and a
 * page's file from before a deploy, the boot sky while the new version loads. A crash in a tab a deploy left behind
 * reloads into the new version too.
 *
 * It is drawn in the sign-in's look (`NoticeScreen`), as the other screens outside a workspace are, through
 * `AuthFrame`, which asks the server nothing: this screen also stands in when the app's providers broke.
 */
export function ErrorScreen({ error }: ErrorComponentProps) {
  const { t } = useTranslation();
  const [id] = useState(() => reportError(error));
  const sent = useSyncExternalStore(onReportTaken, () => reportTaken(id));
  const unreachable = noAnswer(error);
  const offline = useBrowserOffline();
  useServerBack(unreachable);
  // The sky only while the reload is on its way: a person who stayed (a page asked before leaving) gets the crash back.
  const reloading = useSyncExternalStore(onVersionReload, reloadingForNewVersion);
  useEffect(firstScreenPainted, []);
  useEffect(() => {
    if (!unreachable) void reloadIfStale();
  }, [unreachable]);
  if (reloading) return <BootSplash />;
  const reload = () => window.location.reload();
  const strip = inDesktopApp() && <DesktopDragStrip />;
  if (unreachable) {
    return (
      <NoticeScreen
        strip={strip}
        face={offline ? "offline" : "unreachable"}
        title={t(offline ? "empty.offlineTitle" : "empty.unreachableTitle")}
        text={t(offline ? "empty.offlineText" : "empty.unreachableText")}
        action={
          <Button variant="primary" size="lg" icon="refresh" onClick={reload}>
            {t("common.retry")}
          </Button>
        }
      >
        {/* It opens again by itself (useServerBack): the orbit says it is waiting. */}
        <span className="auth__line" role="status">
          <PixelSpinner size={14} />
          {t("empty.waitingConnection")}
        </span>
      </NoticeScreen>
    );
  }
  return (
    <NoticeScreen
      strip={strip}
      face="crash"
      title={t("empty.crashTitle")}
      text={t("empty.crashText")}
      action={
        // The newest version, never the browser's copy of this one: the crash may be fixed there.
        <Button variant="primary" size="lg" icon="refresh" onClick={() => void reloadFresh()}>
          {t("common.reload")}
        </Button>
      }
    >
      {id && sent && <SupportCode code={shortErrorId(id)} />}
    </NoticeScreen>
  );
}

/** An address that leads nowhere (the root's not-found), in the same look: the way back to the start. */
export function NotFoundScreen() {
  const { t } = useTranslation();
  return (
    <NoticeScreen
      face="notFound"
      title={t("empty.notFoundTitle")}
      text={t("empty.notFoundText")}
      action={
        <Button asChild variant="primary" size="lg">
          <Link to="/">{t("empty.goHome")}</Link>
        </Button>
      }
    />
  );
}

type Face = "crash" | "unreachable" | "offline" | "notFound";

/**
 * The screen itself: the logo, the horizon, and in the column the agent saying what happened, the title, one line,
 * the way out and, under it, what else there is to know (the report's code, the wait).
 */
function NoticeScreen({
  strip,
  face,
  title,
  text,
  action,
  children,
}: {
  strip?: ReactNode;
  face: Face;
  title: string;
  text: string;
  action: ReactNode;
  children?: ReactNode;
}) {
  return (
    <AuthFrame languages={false}>
      {strip}
      <div className="auth__notice">
        <NoticeFace face={face} />
        <h1>{title}</h1>
        <p>{text}</p>
        {action}
        {children}
      </div>
    </AuthFrame>
  );
}

/**
 * The agent, in the product's own look: dizzy when the page broke, asleep while the server restarts, looking around
 * with no internet, with a question mark at an address that leads nowhere. Decorative: the title says it.
 */
function NoticeFace({ face }: { face: Face }) {
  return (
    <span className="auth__face" aria-hidden="true">
      {face === "crash" || face === "notFound" ? (
        <AgentSticker mood={face === "crash" ? "dizzy" : "thinking"} size={112} seed="notice" />
      ) : (
        <AgentAvatar name="" size="xl" state={face === "unreachable" ? "sleeping" : "thinking"} />
      )}
    </span>
  );
}

/** The report's short code on a line of its own, with a button that copies it (the text stays selectable). */
function SupportCode({ code }: { code: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () => {
    navigator.clipboard?.writeText(code).then(
      () => {
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1400);
      },
      // Clipboard refused: nothing copied, the code is still there to select.
      () => {},
    );
  };
  return (
    <span className="auth__line">
      {t("empty.supportCode")} <b>{code}</b>
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        icon={copied ? "check" : "copy"}
        className="auth__line-copy"
        aria-label={copied ? t("common.copied") : t("common.copy")}
        title={t("common.copy")}
        onClick={copy}
      />
    </span>
  );
}
