import {
  hostLook,
  isAgentesCloud,
  MisconfiguredError,
  normalizeHost,
  requestLocale,
  ValidationError,
} from "@agenteschat/engine";
import { helpDocsUrl } from "@agenteschat/i18n/help";
import { appLocale } from "@agenteschat/i18n/locale";
import type { AgentesModule, Edition, ModuleContext } from "@agenteschat/modules";
import { OpenAPIHono } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import { serveStatic } from "hono/bun";
import { requestId } from "hono/request-id";
import composeFile from "../../../docker-compose.yml" with { type: "text" };
import installScript from "../../../install.sh" with { type: "text" };
import { registerAppLinks } from "./app-links";
import { registerManagedDownloads } from "./managed-downloads";
import { authHandler, signInPageUrl } from "./auth";
import { apiBodyLimit } from "./http/body-limit";
import { errorPages, isPageRequest } from "./http/error-page";
import { apiError, domainErrorResponse, routeOf, validationHook } from "./http/errors";
import { busyResponse } from "./load-shed";
import { createLogger, type Logger, loggedPath } from "./logger";
import { ownHosts } from "./operator/hosts";
import { directPushSenders, relayServeSender } from "./push-senders";
import { timeRoutes } from "./route-times";
import { accessRoutes } from "./routes/app/access";
import { accountRoutes } from "./routes/app/account";
import { actionRoutes } from "./routes/app/actions";
import { agentImportRoutes } from "./routes/app/agent-imports";
import { agentRoutes } from "./routes/app/agents";
import { approvalRoutes } from "./routes/app/approvals";
import { appRoutes } from "./routes/app/apps";
import { artifactRoutes } from "./routes/app/artifacts";
import { auditRoutes } from "./routes/app/audit";
import { billingRoutes } from "./routes/app/billing";
import { browserRoutes } from "./routes/app/browser";
import { browserProfileRoutes } from "./routes/app/browser-profiles";
import { calendarRoutes } from "./routes/app/calendar";
import { channelRoutes } from "./routes/app/channels";
import { chatRoutes } from "./routes/app/chat";
import { codeSessionRoutes } from "./routes/app/code-sessions";
import { connectorRoutes } from "./routes/app/connectors";
import { customConnectorRoutes } from "./routes/app/connectors-custom";
import { type AppDeps, agentDetailsGate, readOnlyWhileDeleting } from "./routes/app/context";
import { dashboardRoutes } from "./routes/app/dashboards";
import { databaseRoutes } from "./routes/app/databases";
import { desktopRoutes } from "./routes/app/desktop";
import { deviceWaitRoutes } from "./routes/app/device-waits";
import { dmRoutes } from "./routes/app/dms";
import { feedbackRoutes, registerFeedbackFiles, registerFeedbackInbox } from "./routes/app/feedback";
import { gifKeyRoutes } from "./routes/app/gif-key";
import { gifRoutes } from "./routes/app/gifs";
import { imageRoutes } from "./routes/app/images";
import { integrationAppRoutes } from "./routes/app/integration-apps";
import { inviteRoutes } from "./routes/app/invites";
import { issueRoutes } from "./routes/app/issues";
import { jevRoutes } from "./routes/app/jev";
import { knowledgeRoutes } from "./routes/app/knowledge";
import { liveRoutes } from "./routes/app/live";
import { machineAccountRoutes } from "./routes/app/machine-accounts";
import { mailRoutes } from "./routes/app/mail";
import { managementRoutes } from "./routes/app/management";
import { memoryRoutes } from "./routes/app/memory";
import { missionRoutes } from "./routes/app/missions";
import { notificationRoutes } from "./routes/app/notifications";
import { personUsageRoutes } from "./routes/app/person-usage";
import { planUsageRoutes } from "./routes/app/plan-usage";
import { problemReportRoutes } from "./routes/app/problem-reports";
import { pushRoutes } from "./routes/app/push";
import { questionRoutes } from "./routes/app/questions";
import { referralRoutes } from "./routes/app/referrals";
import { roleRoutes } from "./routes/app/roles";
import { routineRoutes } from "./routes/app/routines";
import { sandboxRoutes } from "./routes/app/sandboxes";
import { secretRoutes } from "./routes/app/secrets";
import { skillRoutes } from "./routes/app/skills";
import { storageRoutes } from "./routes/app/storage";
import { surfaceRoutes } from "./routes/app/surfaces";
import { teamWeekRoutes } from "./routes/app/team-week";
import { telemetryRoutes } from "./routes/app/telemetry";
import { threadRoutes } from "./routes/app/threads";
import { thumbRoutes } from "./routes/app/thumbs";
import { toolLabelRoutes } from "./routes/app/tool-labels";
import { vaultRoutes } from "./routes/app/vault";
import { speechKeyRoutes, voiceRoutes } from "./routes/app/voice";
import { waitingRoutes } from "./routes/app/waiting";
import { wikiRoutes } from "./routes/app/wiki";
import {
  createDesktopReleases,
  createNativeReleases,
  registerDesktopRoutes,
  registerNativeRoutes,
} from "./routes/desktop";
import { deviceAppRoutes, registerConnectLinkInfo, registerConnectScripts } from "./routes/devices";
import { registerFonts } from "./routes/fonts";
import { registerGitProxy } from "./routes/git";
import { githubAppRoutes, registerGitHubAppWebhook } from "./routes/github-app";
import { registerHealth } from "./routes/health";
import { registerInstance } from "./routes/instance";
import { registerIntegrationApi } from "./routes/integration-api";
import { machineAppRoutes, registerMachinePublicRoutes } from "./routes/machines";
import { type AppsRouteOptions, registerAppsRoot, registerOauthRoutes } from "./routes/oauth";
import { pushRelayRoutes } from "./routes/push-relay";
import { registerWaitlist } from "./routes/waitlist";
import { registerRoutineHooks, registerWebhookReceiver, webhookAdminRoutes } from "./routes/webhooks";

export interface AppOptions {
  edition: Edition;
  /** The package's version; the config's `APP_VERSION` (the deploy's) takes its place when set. */
  version: string;
  modules: AgentesModule[];
  pingDatabase: () => Promise<void>;
  /** True once the server is shutting down: `/api/health` answers 503. */
  draining?: () => boolean;
  /** Why this process is overloaded now (`watchLoad`), or null: the apps' reads (and `/api/health?load=1`) answer 503. */
  overloaded?: () => string | null;
  /** Needed when modules register routes. */
  moduleContext?: ModuleContext;
  /** Database, auth and adapters. Without them only system routes are mounted (some tests). */
  services?: AppDeps;
  /** AI apps (ADR 0119): how an app's metadata document is fetched; swapped in tests. */
  appsFetchDocument?: AppsRouteOptions["fetchDocument"];
  /** Directory with the built web app (Vite SPA). Skipped when absent. */
  webDir?: string;
  log?: Logger;
}

/**
 * Builds the HTTP app without starting a server, so tests can call
 * `app.request(...)` directly. The WebSocket endpoint lives next to it in
 * `Bun.serve` (see `start.ts` and `realtime/ws.ts`).
 *
 * Layout:
 * - `/api/health`         health probe
 * - `/api/fonts/*`        public: the fonts live files use, their `@font-face` CSS and files (ADR 0220)
 * - `/api/instance`       public: what this server is, for the phone and desktop apps choosing a server
 * - `/api/auth/*`         Better Auth (sign-up, sign-in, sessions, OAuth callbacks)
 * - `/api/app/*`          private API of the web and phone apps (cookie session + CSRF, ADR 0035)
 * - `/api/webhooks/*`     incoming webhooks (GitHub, Sentry), signature-checked
 * - `/api/github-app/webhook` our GitHub App's events (installs, suspensions), signature-checked
 * - `/api/git/*`          git proxy for agents' computers (their own credential, ADR 0024)
 * - `/api/machines/*`     connected computers' runner: device-code connection, uploads, install.sh, a connect link's info (ADR 0025, 0036)
 * - `/api/desktop/*`      public: the desktop app's latest build and its download (ADR 0036)
 * - `/api/native/*`       public: the packages that run agentes.chat without Docker, for the installer (ADR 0060)
 * - `/api/hooks/*`        public: a webhook routine's own address (its chosen methods, ADR 0106)
 * - `/api/waitlist`       public: join the waiting list and confirm the email (the landing page, only with LANDING_URL)
 * - `/api/partners/waitlist` public: join the partner program's waiting list (the landing page, only with LANDING_URL)
 * - `/api/oauth/*`        public: the OAuth 2.1 authorization server for AI apps (ADR 0119)
 * - `/api/v1/*`           public: integration apps' API, `agi_` bearer tokens only (ADR 0251)
 * - `/api/push-relay/v1/*` other installations' phone pushes, server to server (only with PUSH_RELAY_SERVE, ADR 0152)
 * - `/mcp`                AI apps' MCP endpoint, bearer tokens only (ADR 0119); `/.well-known/oauth-*` its discovery
 * - `/api/ws`             WebSocket (real-time)
 * - `/api/live`           WebSocket: one live file, a spreadsheet, presentation or canvas (ADR 0196)
 * - `/api/openapi.json`   OpenAPI 3.1 document; `/api/reference` interactive docs
 * - `/install`            the self-host installer, `install.sh` (`curl -fsSL <server>/install | sh`)
 * - `/i/<code>`           a new computer's installer with a connect link baked in (`/i/<code>/ps` for Windows)
 * - `/migrate.sh`         runs `agentes-runner migrate` once, without installing (`/migrate.ps1` for Windows; ADR 0055)
 * - `/install/docker-compose.yml` the compose file of this release, which the setup downloads
 * - `/sw.js`              the web app's service worker (browser push, ADR 0071)
 * - everything else       web app (single-page app), when built
 */
const APP_CSP =
  "frame-ancestors 'none'; base-uri 'self'; frame-src 'self' blob: data: https://challenges.cloudflare.com";

export function createApp(options: AppOptions) {
  const log = options.log ?? createLogger("warn");
  const version = options.services?.config.APP_VERSION ?? options.version;
  const api = new OpenAPIHono({ defaultHook: validationHook() });
  api.openAPIRegistry.registerComponent("securitySchemes", "session", {
    type: "apiKey",
    in: "cookie",
    name: "better-auth.session_token",
    description: "Session cookie set by `/api/auth/sign-in/*`.",
  });

  registerFonts(api);
  registerHealth(api, {
    version,
    // agentes.chat itself runs the self-host image: its apps must still hide what only a self-hosted server has.
    edition: options.services && isAgentesCloud(options.services.config.PUBLIC_URL) ? "cloud" : options.edition,
    modules: options.modules.map((m) => m.name),
    pingDatabase: options.pingDatabase,
    draining: options.draining,
    overloaded: options.overloaded,
  });

  if (options.services) {
    const { auth, config, db } = options.services;
    const handleAuth = authHandler(auth, db);
    const serverError = signInPageUrl(config.PUBLIC_URL, { error: "server_error" });
    api.on(["GET", "POST"], "/auth/*", async (c) => {
      const res = await handleAuth(c.req.raw);
      // A browser's own navigation that failed on our side (an OAuth callback): the sign-in page says so, never an
      // empty 500. A request the app made itself keeps its answer.
      if (res.status >= 500 && c.req.method === "GET" && c.req.header("sec-fetch-mode") === "navigate") {
        return c.redirect(serverError, 302);
      }
      return res;
    });
    const deps: AppDeps = { log, ...options.services };
    registerInstance(api, deps, version);
    registerFeedbackFiles(api, deps);
    registerFeedbackInbox(api, deps);
    api.use("/app/organizations/:orgId/agents/:agentId/:part", agentDetailsGate(deps));
    api.use("/app/organizations/:orgId/*", readOnlyWhileDeleting(deps));
    api.route("/app", accountRoutes(deps));
    api.route("/app", accessRoutes(deps));
    api.route("/app", agentRoutes(deps));
    api.route("/app", chatRoutes(deps));
    api.route("/app", gifRoutes(deps));
    api.route("/app", actionRoutes(deps));
    api.route("/app", channelRoutes(deps));
    api.route("/app", approvalRoutes(deps));
    api.route("/app", appRoutes(deps));
    api.route("/app", auditRoutes(deps));
    api.route("/app", customConnectorRoutes(deps));
    api.route("/app", connectorRoutes(deps));
    api.route("/app", mailRoutes(deps, log));
    api.route("/app", databaseRoutes(deps));
    api.route("/app", managementRoutes(deps));
    api.route("/app", knowledgeRoutes(deps));
    api.route("/app", memoryRoutes(deps));
    api.route("/app", dmRoutes(deps));
    api.route("/app", questionRoutes(deps));
    api.route("/app", browserRoutes(deps));
    api.route("/app", browserProfileRoutes(deps));
    api.route("/app", desktopRoutes(deps));
    api.route("/app", notificationRoutes(deps));
    api.route("/app", waitingRoutes(deps));
    api.route("/app", toolLabelRoutes(deps));
    api.route("/app", pushRoutes(deps));
    api.route("/app", secretRoutes(deps));
    api.route("/app", vaultRoutes(deps));
    api.route("/app", inviteRoutes(deps));
    api.route("/app", roleRoutes(deps));
    api.route("/app", storageRoutes(deps));
    api.route("/app", billingRoutes(deps));
    api.route("/app", referralRoutes(deps));
    api.route("/app", artifactRoutes(deps));
    api.route("/app", thumbRoutes(deps));
    api.route("/app", liveRoutes(deps));
    // Pictures on canvases (ADR 0197): the image models, requests and Try again.
    api.route("/app", imageRoutes(deps));
    api.route("/app", issueRoutes(deps));
    api.route("/app", threadRoutes(deps));
    api.route("/app", missionRoutes(deps));
    // Code sessions (ADR 0215): a request in its own worktree on the agent's computer, with its conversation.
    api.route("/app", codeSessionRoutes(deps));
    api.route("/app", wikiRoutes(deps));
    api.route("/app", routineRoutes(deps));
    api.route("/app", calendarRoutes(deps));
    api.route("/app", skillRoutes(deps));
    api.route("/app", agentImportRoutes(deps));
    api.route("/app", sandboxRoutes(deps));
    api.route("/app", machineAppRoutes(deps));
    api.route("/app", deviceWaitRoutes(deps));
    api.route("/app", deviceAppRoutes(deps));
    api.route("/app", machineAccountRoutes(deps));
    api.route("/app", planUsageRoutes(deps));
    api.route("/app", personUsageRoutes(deps));
    api.route("/app", teamWeekRoutes(deps));
    api.route("/app", dashboardRoutes(deps));
    api.route("/app", telemetryRoutes(deps));
    api.route("/app", problemReportRoutes(deps));
    api.route("/app", jevRoutes(deps));
    api.route("/app", feedbackRoutes(deps));
    api.route("/app", gifKeyRoutes(deps));
    api.route("/app", speechKeyRoutes(deps));
    api.route("/app", voiceRoutes(deps));
    api.route("/app", surfaceRoutes(deps));
    api.route("/app", webhookAdminRoutes(deps));
    // Integration apps (ADR 0251): Settings › Integrations, and their own public API.
    api.route("/app", integrationAppRoutes(deps));
    registerIntegrationApi(api, deps);
    api.route("/app", githubAppRoutes(deps));
    registerOauthRoutes(api, deps, { version, fetchDocument: options.appsFetchDocument });
    registerWebhookReceiver(api, deps);
    registerRoutineHooks(api, deps);
    registerGitHubAppWebhook(api, deps);
    registerMachinePublicRoutes(api, deps);
    registerConnectLinkInfo(api, deps);
    registerDesktopRoutes(
      api,
      deps,
      createDesktopReleases({
        token: deps.config.DESKTOP_RELEASES_TOKEN,
        repo: deps.config.DESKTOP_RELEASES_REPO,
        fetch: deps.extras?.desktopFetch,
      }),
    );
    registerNativeRoutes(
      api,
      deps,
      createNativeReleases({
        token: deps.config.DESKTOP_RELEASES_TOKEN,
        repo: deps.config.DESKTOP_RELEASES_REPO,
        fetch: deps.extras?.desktopFetch,
      }),
    );
    if (deps.config.LANDING_URL) registerWaitlist(api, deps);
    // The push relay for other installations' phone pushes (ADR 0152, ADR 0178), with this server's Firebase
    // account and APNs key.
    if (deps.config.PUSH_RELAY_SERVE === "on") {
      const override = deps.extras?.pushRelaySender;
      const sender = override === undefined ? relayServeSender(directPushSenders(deps.config)) : override;
      if (sender) {
        api.route(
          "/push-relay/v1",
          pushRelayRoutes({
            db: deps.db,
            sender,
            rateLimiter: deps.adapters.rateLimiter,
            trustedProxies: deps.config.TRUSTED_PROXIES,
            log,
          }),
        );
      }
    }
    if (deps.extras?.gitProxy) registerGitProxy(api, deps.extras.gitProxy);
  }

  for (const module of options.modules) {
    if (!module.registerRoutes) continue;
    if (!options.moduleContext) throw new Error(`module ${module.name} needs a moduleContext`);
    module.registerRoutes(api, options.moduleContext);
  }

  api.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "agentes.chat API",
      version,
      description: "Workspace where people and AI agents work together.",
    },
  });
  // The interactive explorer loads its bundle from a CDN; keep it off the production origin, where a
  // compromised CDN would run on the session's origin. The OpenAPI document itself stays available everywhere.
  if (options.services?.config.NODE_ENV !== "production") {
    api.get("/reference", Scalar({ url: "/api/openapi.json", pageTitle: "agentes.chat API" }));
  }

  const app = new OpenAPIHono();
  app.onError((error, c) => {
    // A typed-in address refused for being on a private network says so in the log too: a self-hoster who meant
    // to reach it sees which host and which settings allow it (ADR 0210).
    if (error instanceof ValidationError && error.code === "url.internal") {
      log.warn("outbound address refused: private network", {
        host: error.params?.host,
        route: routeOf(c),
        orgId: c.req.param("orgId"),
        allowWith: "OUTBOUND_ALLOW_HOSTS or OUTBOUND_ALLOW_CIDRS",
      });
    }
    const mapped = domainErrorResponse(error, c);
    if (mapped) return mapped;
    log.error("unhandled error", {
      method: c.req.method,
      path: loggedPath(c.req.path),
      route: routeOf(c),
      status: 500,
      requestId: c.get("requestId"),
      orgId: c.req.param("orgId"),
      userId: (c.var as { user?: { id: string } }).user?.id,
      error,
      stack: error.stack,
    });
    // Reported like any failure, but the apps can say what's wrong and who fixes it.
    if (error instanceof MisconfiguredError) return apiError(c, 500, error.code, error.message, error.params);
    return apiError(c, 500, "internal_error", "Something went wrong on our side");
  });
  // Ties a request's failure in the log to its report, and to what the client saw (`X-Request-Id`).
  app.use("/api/*", requestId());
  // Each route's p95 over the minute, on the operator's `GET /vitals` (`route-times.ts`, `process-health.ts`).
  app.use("/api/*", timeRoutes);
  app.use("/api/*", apiBodyLimit);
  // Security headers on every response: the app may not be framed (clickjacking of approval, merge and deploy
  // cards), <base> is pinned to our own origin, and HSTS is sent where the instance is served over TLS. `frame-src`
  // keeps a frame on our pages from navigating itself to another site with what it holds: an agent's page has no
  // other way out (ADR 0019), and no policy inside the page can stop that. Frames are our own blobs (pages, PDFs)
  // and the bot check.
  const httpsPublicUrl = options.services?.config.PUBLIC_URL?.startsWith("https:") ?? false;
  app.use("*", async (c, next) => {
    await next();
    const h = c.res.headers;
    if (!h.has("x-frame-options")) h.set("x-frame-options", "DENY");
    if (!h.has("content-security-policy")) h.set("content-security-policy", APP_CSP);
    if (httpsPublicUrl && !h.has("strict-transport-security")) h.set("strict-transport-security", "max-age=63072000");
  });
  // A CDN in front may cache by the path's extension, whatever the type: without this, a private
  // answer at a path that ends like a file (a skill's `data.csv`) would be served to anyone asking.
  app.use("/api/*", async (c, next) => {
    await next();
    if (!c.res.headers.has("cache-control")) c.res.headers.set("cache-control", "no-store");
  });
  // A link a person opens in a browser that the API refuses: our page, never the JSON on screen (ADR 0157).
  app.use("/api/*", errorPages(options.services?.config.PUBLIC_URL));
  // A late event loop or slow database: the apps' reads wait for a calmer moment (or, behind a proxy, another
  // process); writes carry on. A full socket count turns new sockets away only.
  const overloaded = options.overloaded;
  if (overloaded) {
    app.use("/api/app/*", async (c, next) => {
      // A link a person opened (a provider's OAuth return with its one-time code, a download, an invite) is no read.
      const read = c.req.method === "GET" && !isPageRequest(c.req.raw.headers, "GET");
      const why = read ? overloaded() : null;
      return why && why !== "sockets" ? busyResponse() : next();
    });
  }
  app.route("/api", api);
  if (options.services) {
    registerConnectScripts(app, { log, ...options.services });
    registerAppLinks(app, options.services.config);
    registerManagedDownloads(app, options.services.config.FILES_DIR);
    registerAppsRoot(app, { log, ...options.services }, { version, fetchDocument: options.appsFetchDocument });
  }
  app.notFound((c) =>
    c.req.path.startsWith("/api/") ? apiError(c, 404, "not_found", "Route not found") : c.text("Not found", 404),
  );
  for (const path of ["/install", "/install.sh"]) {
    app.get(path, (c) =>
      c.body(installScript, 200, { "content-type": "text/x-shellscript; charset=utf-8", "cache-control": "no-store" }),
    );
  }
  // The help pages moved to the public docs site: old links (`?lang=` or the browser's language) land on the same
  // page there; the browser keeps the #section across the redirect. Vary: a 301 is cached, by browsers and by a CDN
  // in front, and without `?lang=` the target is the browser's language.
  for (const path of ["/help", "/help/", "/help/:slug"]) {
    app.get(path, (c) => {
      c.header("vary", "accept-language");
      const locale = appLocale([c.req.query("lang")], true) ?? requestLocale(c.req.header("accept-language")) ?? "en";
      return c.redirect(helpDocsUrl(c.req.param("slug"), locale), 301);
    });
  }
  // The setup downloads it into a folder that has none: this build's, from any instance.
  app.get("/install/docker-compose.yml", (c) =>
    c.body(composeFile, 200, { "content-type": "application/yaml; charset=utf-8", "cache-control": "no-store" }),
  );

  if (options.webDir) {
    // The build writes each script and stylesheet compressed beside it (apps/web/scripts/compress-dist.ts): a server
    // with nothing in front of it sends 1/4 of the bytes. Pages stay plain (their HTML is rewritten for a host).
    const assets = serveStatic({ root: options.webDir, precompressed: true });
    // Client-side routing: unknown non-API paths render the web app.
    const spa = serveStatic({ root: options.webDir, path: "index.html" });
    const isApi = (path: string) => path.startsWith("/api/");
    // The runner bundle (ADR 0025): always revalidated, JavaScript, and never the SPA when missing.
    app.get("/runner/*", async (c) => {
      const res = await assets(c, async () => {});
      if (!res) return c.text("Not found", 404);
      res.headers.set("cache-control", "no-cache");
      if (c.req.path.endsWith(".mjs")) res.headers.set("content-type", "text/javascript; charset=utf-8");
      return res;
    });
    // The service worker (browser push, ADR 0071): at the root so it controls the whole app, always
    // revalidated so a new deploy's worker takes over, JavaScript, and never the SPA when missing.
    app.get("/sw.js", async (c) => {
      const res = await assets(c, async () => {});
      if (!res) return c.text("Not found", 404);
      res.headers.set("cache-control", "no-cache");
      res.headers.set("content-type", "text/javascript; charset=utf-8");
      return res;
    });
    // Emails' pictures and font: fetched by mail clients and Gmail's image proxy, so readable without a
    // session and from any origin; never the SPA when missing. A changed picture gets a new name.
    app.get("/email/*", async (c) => {
      const res = await assets(c, async () => {});
      if (!res) return c.text("Not found", 404);
      res.headers.set("cache-control", "public, max-age=31536000, immutable");
      res.headers.set("access-control-allow-origin", "*");
      return res;
    });
    // Hashed build files never change: the browser (and the Mac app's window) opens them from disk.
    // index.html is always revalidated, so a new deploy shows on the next open.
    // No page of the app belongs in a search engine's index, whatever its status: sign-in pages and made-up
    // addresses all answer with the same page. A header, never a robots.txt: a crawler kept out can't read it.
    // On a registered host (ADR 0194) the page says so on its <html> before the app knows the host, so index.html's
    // boot rules hide the product's mark. Every page from WEB_DIR passes here, the SPA fallback included.
    // On a hostname that is neither the server's own nor registered, the app's page is a 404 marked
    // data-unknown-host, and the web shows only its "not set up yet" screen. Only with the operator API on: hosts
    // register only through it, so without it every name a proxy sends is the server's own.
    const db = options.services?.db;
    const config = options.services?.config;
    const own = config ? ownHosts(config) : new Set<string>();
    const unknownHost = (host: string | undefined) => {
      const name = normalizeHost(host);
      return Boolean(config?.OPERATOR_API_TOKEN && name && !own.has(name));
    };
    const appPage = (path: string) => !path.endsWith(".html") || path === "/index.html";
    app.use("/*", async (c, next) => {
      await next();
      if (isApi(c.req.path)) return;
      const html = c.res.headers.get("content-type")?.startsWith("text/html");
      if (html && db && c.res.ok && c.req.method === "GET") {
        const host = c.req.header("host");
        const mark = (await hostLook(db, host))
          ? "data-host"
          : appPage(c.req.path) && unknownHost(host)
            ? "data-unknown-host"
            : null;
        if (mark) {
          let page = (await c.res.text()).replace("<html", `<html ${mark}`);
          // The web app manifest (ADR 0249) installs the product's name and icon; a registered host wears its own.
          if (mark === "data-host") page = page.replace(/<link rel="manifest"[^>]*>\s*/, "");
          c.res.headers.delete("content-length");
          // The address may be registered a moment later: nothing keeps this answer.
          if (mark === "data-unknown-host") c.res.headers.set("cache-control", "no-store");
          c.res = new Response(page, {
            status: mark === "data-unknown-host" ? 404 : c.res.status,
            headers: c.res.headers,
          });
        }
      }
      if (html) c.res.headers.set("x-robots-tag", "noindex");
      if (!c.res.ok || c.res.headers.has("cache-control")) return;
      if (html) c.res.headers.set("cache-control", "no-cache");
      else if (c.req.path.startsWith("/assets/"))
        c.res.headers.set("cache-control", "public, max-age=31536000, immutable");
    });
    app.use("/*", (c, next) => (isApi(c.req.path) ? next() : assets(c, next)));
    // A build file that isn't here (asked by a page from before a deploy) is a 404, never index.html: the boot fallback
    // and `vite:preloadError` then load the new version. No CDN keeps the 404.
    app.get("/assets/*", (c) => c.text("Not found", 404, { "cache-control": "no-store" }));
    // Files crawlers and agents ask every site for: one this build doesn't ship is a 404, never index.html with a 200.
    // Exact addresses at the root, never a pattern: an address inside a workspace may end like a file (a wiki page's
    // slug), and the router tests a pattern against the rest of the path, not one segment.
    const crawlerFiles = [
      "/robots.txt",
      "/llms.txt",
      "/llms-full.txt",
      "/ads.txt",
      "/app-ads.txt",
      "/humans.txt",
      "/security.txt",
      "/sitemap.xml",
      "/sitemap_index.xml",
      "/sitemap-index.xml",
    ];
    app.on("GET", crawlerFiles, (c) => c.text("Not found", 404));
    app.get("/*", (c, next) => (isApi(c.req.path) ? next() : spa(c, next)));
  }

  return app;
}
