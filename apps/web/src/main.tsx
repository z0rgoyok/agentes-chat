import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import "./styles.css";
import { authConfigQuery, createApiClient, createSnapshot, keys, type Me, meQuery, outbox } from "@agenteschat/client";
import { ErrorBoundary } from "@agenteschat/client/lib/error-boundary";
import { errorText } from "@agenteschat/client/lib/errors";
import { holdSkies, installTitleTips, trackInput } from "@agenteschat/ui";
import { AppProviders, type AppServices } from "./app/providers";
import { createQueryClient } from "./app/query-client";
import { createBetterAuthClient } from "./auth/better-auth";
import { copyPillAddresses } from "./chat/link-pill-copy";
import { ErrorScreen } from "./components/ErrorScreen";
import { withComposerDraftsSignOut } from "./hooks/useComposerDraft";
import { loadI18n, savedLocale } from "./i18n";
import { accountInLink, followAccountChanges, takeAccountMove, watchAccount, withoutAccount } from "./lib/accounts";
import { startAppIcon } from "./lib/app-icon";
import {
  checkAppVersion,
  createVersionWatch,
  fetchIndexHtml,
  loadedEntry,
  reloadForNewVersion,
  startVersionWatch,
  VERSION_CHECK_MS,
} from "./lib/app-version";
import {
  applyDesktopDevice,
  askForPhone,
  asksForPhone,
  desktopPlatform,
  desktopRenderer,
  inDesktopApp,
} from "./lib/desktop";
import { tolerateForeignDomEdits } from "./lib/dom-guard";
import { announceConfirmation, emailConfirmedToast } from "./lib/email-confirmation";
import { catchEarlyErrors, reportError, setErrorScope, startErrorReports } from "./lib/error-reports";
import { pageScrollReset } from "./lib/page-scroll";
import { showReturnNotices } from "./lib/return-notices";
import { snapshotStore } from "./lib/snapshot-store";
import { installSounds } from "./lib/sounds";
import { STORAGE_KEYS, sessionStore } from "./lib/storage";
import { createToastStore } from "./lib/toast";
import { withWebPushSignOut } from "./lib/web-push";
import { routeTree } from "./routeTree.gen";

// Errors from the very start wait for the server to say where reports go (ADR 0104), asked before anything that can
// fail to load (the locale's chunk): a boot that breaks is reported too.
catchEarlyErrors();
tolerateForeignDomEdits();
const api = createApiClient();
const authConfig = api.account.authConfig();
void authConfig.then(
  (config) => startErrorReports(config.errorReports ?? null),
  () => startErrorReports(null),
);
// The language's file is the app's own too: index.html's boot fallback reloads or says so, and the error is reported.
const i18n = await loadI18n(savedLocale()).catch((error: unknown) => {
  window.__agentesBootFailed?.();
  throw error;
});
document.documentElement.lang = i18n.language;
// In the desktop app (ADR 0036): the site draws the window's title bar (desktop.css), with room for a Mac's
// buttons only there; and "this Mac" is this computer's own name.
const platform = desktopPlatform();
if (platform) {
  document.documentElement.dataset.desktop = platform;
  applyDesktopDevice(i18n, platform);
  if (asksForPhone(window.location.search)) askForPhone();
  // Painted in software (Linux's WebKitGTK): the skies stand still, or their frames keep a core busy (holdSkies), and
  // desktop.css drops the blurs and endless loops.
  const renderer = desktopRenderer();
  if (renderer) document.documentElement.dataset.desktopRenderer = renderer;
  if (renderer === "cpu") holdSkies();
}
// Focus rings only while the keys move the focus (`data-pointer` on <html>, read by the stylesheet).
trackInput();
// Every `title` and icon-only control says its words in the product's tooltip, not the browser's.
installTitleTips();
const toasts = createToastStore();
// The app's sounds (ADR 0070): a click or a key switches audio on; the person's choice is in Sua conta.
installSounds();
// The app icon this device picked (ADR 0179): the tab's, or the desktop app's Dock.
startAppIcon();

/** A 401 anywhere means the session ended: back to sign-in, then here again. */
function onUnauthorized() {
  if (window.location.pathname.startsWith("/login")) return;
  const redirect = window.location.pathname + window.location.search;
  queryClient.clear();
  void router.navigate({ to: "/login", search: { redirect } });
  toasts.show(i18n.t("common.signedOut"));
}

const queryClient = createQueryClient({
  onUnauthorized,
  onMutationError: (message) => toasts.show(message, "error"),
  describeError: (error) => errorText(i18n.t, error, i18n.language),
});

// The answer above is the cache's: the sign-in guards don't ask again.
void queryClient.prefetchQuery({ ...authConfigQuery(api), queryFn: () => authConfig });

// The last lists and chats saved on this device show at once; everything revalidates as usual.
const snapshot = createSnapshot(queryClient, snapshotStore);
snapshot.start();
// Another of the browser's accounts took this tab (ADR 0183), by the workspace menu or by the address the desktop app
// opened (`?as=`): what the one before saved or left waiting to send stays behind.
const accountMoved = takeAccountMove();
const asAccount = accountInLink(window.location.search);
if (accountMoved || (asAccount && inDesktopApp())) sessionStore.remove(STORAGE_KEYS.outbox);
followAccountChanges();
watchAccount(api, () => queryClient.getQueryData<Me | null>(keys.me)?.user.id ?? null);
// What waits for the connection survives a reload of this tab: a new version loaded after a deploy, for one.
outbox.keep(queryClient, {
  read: () => sessionStore.get(STORAGE_KEYS.outbox),
  write: (value) => sessionStore.set(STORAGE_KEYS.outbox, value),
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") void snapshot.flush();
});
/** Opening never waits longer than this for the snapshot (a slow disk loads from the server instead). */
const SNAPSHOT_WAIT_MS = 300;

const pageScroll = pageScrollReset();
const router = createRouter({
  routeTree,
  context: { queryClient, api },
  defaultPreload: "intent",
  defaultPreloadStaleTime: 0,
  scrollRestoration: true,
  scrollToTopSelectors: pageScroll.selectors,
  // No View Transitions: they freeze the whole page while the next one renders (the sidebar's pill
  // stalled mid-slide). Each page's main fades in on mount instead (layout.css).
});

router.subscribe("onBeforeLoad", pageScroll.track);

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

// What an error report says about where it happened: the route's pattern, the workspace and the person, by id.
router.subscribe("onResolved", () => {
  const match = router.state.matches.at(-1);
  setErrorScope({
    route: match?.routeId,
    orgId: (match?.params as { orgId?: string } | undefined)?.orgId,
    userId: queryClient.getQueryData<Me | null>(keys.me)?.user.id,
  });
});

// A deploy while this tab is open: say so, and the next page change loads the new app.
const versionWatch = startVersionWatch(
  createVersionWatch({
    loaded: loadedEntry(),
    fetchHtml: fetchIndexHtml,
    onStale: () =>
      toasts.show(i18n.t("common.newVersion"), "info", {
        label: i18n.t("common.reload"),
        run: () => window.location.reload(),
      }),
  }),
);
router.subscribe("onBeforeNavigate", ({ toLocation, fromLocation }) => {
  if (versionWatch.stale && fromLocation && toLocation.href !== fromLocation.href) {
    window.location.assign(toLocation.href);
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void checkAppVersion();
});
window.addEventListener("online", () => void checkAppVersion());
document.addEventListener("copy", copyPillAddresses);
setInterval(() => void checkAppVersion(), VERSION_CHECK_MS);

// Back from a provider's sign-in that didn't connect (a connector, the GitHub App, a mailbox): why, once.
showReturnNotices(i18n.t, toasts.show);

const services: AppServices = {
  api,
  // Signing out also stops this browser's notifications for the account (ADR 0071) and forgets unsent texts.
  auth: withComposerDraftsSignOut(
    withWebPushSignOut(
      createBetterAuthClient(window.location.origin, () => i18n.language),
      api,
    ),
  ),
  queryClient,
  i18n,
  toasts,
};

// The confirmation email's link: wherever `/` then goes, the person hears how it went.
const confirmation = emailConfirmedToast(window.location.search);
if (confirmation) {
  window.history.replaceState(null, "", window.location.pathname);
  void announceConfirmation(confirmation, {
    auth: services.auth,
    t: i18n.t,
    show: toasts.show,
    me: () => queryClient.fetchQuery({ ...meQuery(api), staleTime: 0 }),
  });
}

const root = document.getElementById("root");
if (!root) throw new Error("#root element missing from index.html");

// The address names an account. In the desktop app, whose window the app itself steers, the browser moves to it
// before anything is read; refused (not signed in on this window any more), the page opens as whoever is. In a
// browser a link never moves the account by itself: whoever opened the address (the service worker, for a clicked
// notification) moved it first, and the name only keeps the account before's saved start out of this load.
if (asAccount) {
  const { pathname, search, hash } = window.location;
  window.history.replaceState(window.history.state, "", withoutAccount(pathname, search, hash));
}
const arrived =
  asAccount && inDesktopApp() ? api.account.switchDeviceAccount(asAccount).catch(() => {}) : Promise.resolve();
const restored = arrived
  .then(() => (accountMoved || asAccount ? snapshotStore.remove().then(() => false) : snapshot.restore()))
  .catch(() => false)
  .then((found) => {
    // The saved `me` let the app open without asking: ask now (no session: sign-in, and the snapshot goes).
    if (!found) return;
    outbox.show(queryClient);
    void queryClient
      .fetchQuery({ ...meQuery(api), staleTime: 0 })
      .then((me) => {
        if (!me) onUnauthorized();
      })
      .catch(() => {});
  });
/** A render error a boundary caught (the error screen) or none did: logged as React would, and reported. */
const renderError = (error: unknown) => {
  console.error(error);
  reportError(error);
};

// A page's code from before a deploy is gone: the new version, with the boot sky in between (ErrorScreen).
window.addEventListener("vite:preloadError", () => void reloadForNewVersion());

// The account the address names comes first, however long its answer takes: the page never opens as another one.
void arrived
  .then(() => Promise.race([restored, new Promise((resolve) => setTimeout(resolve, SNAPSHOT_WAIT_MS))]))
  .then(() => {
    createRoot(root, { onCaughtError: renderError, onUncaughtError: renderError }).render(
      <StrictMode>
        {/* Above the router's own boundary: a provider that throws (theme, toasts, sign-in) gets the crash screen. */}
        <ErrorBoundary
          fallback={(error) => (
            <I18nextProvider i18n={i18n}>
              <ErrorScreen error={error as Error} reset={() => window.location.reload()} />
            </I18nextProvider>
          )}
        >
          <AppProviders services={services}>
            <RouterProvider router={router} />
          </AppProviders>
        </ErrorBoundary>
      </StrictMode>,
    );
  });
