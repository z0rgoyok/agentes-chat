import type { ConfigContext, ExpoConfig } from "expo/config";
import versions from "./versions.json";

/**
 * The app's Expo config. Builds: the "Android build" and "iOS build" workflows on GitHub Actions, or EAS (see
 * README.md). The native projects are made from this file by `expo prebuild` and never committed.
 * - `EXPO_PUBLIC_API_URL`: the server the app talks to by default (production); people can pick their own.
 * - `EAS_PROJECT_ID`: overrides the EAS project, for those who build with EAS; defaults to ours on expo.dev.
 * - `APP_VARIANT`: "development" | "preview" | "production" (from eas.json or the workflow), so the three install
 *   side by side.
 * - `GOOGLE_SERVICES_JSON`: path to Firebase's google-services.json, for push on Android (FCM).
 * - `ANDROID_PACKAGE`: overrides the managed Android application ID.
 * - `ANDROID_VERSION_CODE`: the build's version code, set by the Android workflow (EAS numbers its own builds).
 * - `APPLE_TEAM_ID`: the Apple team that signs the iOS app and its share extension (a build setting, never in the
 *   repo).
 * - `IOS_BUNDLE_ID`: overrides the managed iOS bundle identifier.
 * - `IOS_BUILD_NUMBER`: the build's number on iOS, set by the iOS workflow.
 * - `APP_PLATFORM`: "ios" | "android", set by each build workflow (EAS says it in `EAS_BUILD_PLATFORM`): which of the
 *   two versions in versions.json the build takes.
 *
 * The New Architecture is the only one since SDK 55, so there is no `newArchEnabled` flag any more
 * (the SDK 58 config type no longer has it). Edge-to-edge on Android is likewise always on.
 */
const variant = process.env.APP_VARIANT ?? "production";
/**
 * The app's version in each store, raised on its own by that store's build workflow (ios.yml, android.yml: `release` =
 * fix/feature/major, as the desktop app's), so a release of one never moves the other's.
 */
const platform = process.env.APP_PLATFORM ?? process.env.EAS_BUILD_PLATFORM;
const version = platform === "android" ? versions.android : versions.ios;
const suffix = variant === "production" ? "" : `.${variant}`;
const iosBundleIdentifier = process.env.IOS_BUNDLE_ID ?? `chat.agentes.app${suffix}`;
const apiUrl = process.env.EXPO_PUBLIC_API_URL ?? "https://app.agentes.chat";
// Links to this host open the app (universal links / App Links); the server publishes the matching /.well-known
// files (apps/server/src/app-links.ts).
const linkHost = new URL(apiUrl).host;

/**
 * The website's pages that open the app on Android (its intent filters; `*` is any text), the same list the server
 * gives iOS (`APP_LINK_PATHS` in apps/server/src/app-links.ts, a test keeps them equal): what the app has a screen for
 * (`appLinkFromUrl`, src/features/links/app-links.ts). Settings sections are listed one by one: Android can't
 * leave a page out of a filter, and billing (Stripe returns there) must stay the website's. A change here reaches
 * phones only with a new build.
 */
export const APP_LINK_PATTERNS = [
  "/invite/*",
  "/reset-password",
  "/signup",
  "/org/*/home",
  "/org/*/dashboards",
  "/org/*/dashboards/*",
  "/org/*/c/*",
  "/org/*/dm/*",
  "/org/*/threads",
  "/org/*/threads/*",
  "/org/*/agents/*",
  "/org/*/approvals",
  "/org/*/proposals",
  "/org/*/task-manager",
  "/org/*/notifications",
  "/org/*/issues",
  "/org/*/issues/*",
  "/org/*/routines",
  "/org/*/search",
  "/org/*/drive",
  "/org/*/drive/*",
  "/org/*/wiki",
  "/org/*/wiki/*",
  "/org/*/members",
  "/org/*/settings",
  "/org/*/settings/account",
  "/org/*/settings/notifications",
  "/org/*/settings/apps",
  "/org/*/settings/general",
  "/org/*/settings/members",
  "/org/*/settings/invites",
  "/org/*/settings/audit",
  "/org/*/settings/access",
  "/org/*/settings/connectors",
  "/org/*/settings/skills",
  "/org/*/settings/keys",
  "/org/*/settings/storage",
  "/org/*/settings/computers",
  "/org/*/settings/devices",
  "/org/*/settings/usage",
  "/org/*/settings/import",
  "/org/*/settings/media",
  "/org/*/settings/approvals",
  "/org/*/settings/right_hand",
  "/org/*/settings/roles",
  "/org/*/settings/vault",
  "/org/*/settings/about",
  "/org/*/settings/computers/*",
  "/org/*/settings/devices/*",
];
/** The app icons (ADR 0179), one folder each: packages/ui/scripts/app-icons.mjs writes them. */
const ICONS = "./assets/app-icons";
// Our EAS project on expo.dev (not a secret: it only names the project).
const projectId = process.env.EAS_PROJECT_ID ?? "8514d5b3-87e0-4980-89a0-4c692f6f4702";
// expo-image-picker and expo-camera both set iOS's camera text: one text for both uses.
const CAMERA_USE = "To take pictures for your conversations and scan QR codes.";

/**
 * Paths the app no longer has (the old Início and Conversas routes), sent to Conversas (`/`) so a stale link,
 * notification or restored URL never lands on "not found". expo-router applies these to deep links and to
 * in-app navigation alike. (`/search` is the search tab again.)
 */
export const LEGACY_REDIRECTS = [
  { source: "/chats", destination: "/" },
  { source: "/home", destination: "/" },
];

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: variant === "production" ? "Tich Rooms" : `Tich Rooms ${variant}`,
  slug: "agentes",
  scheme: "agenteschat",
  version,
  // Upright everywhere (the plugin below); only the agent's screen, in control, lies down (`useSideways`).
  orientation: "default",
  // The icon the app ships with (ADR 0179): the agent leaning in, Espiando, on the night sky (packages/client's
  // `PHONE_APP_ICON`); the others a person may pick are added by ./plugins/with-app-icons. All of them come from
  // packages/ui/scripts/app-icons.mjs.
  icon: `${ICONS}/peekNight/ios.png`,
  userInterfaceStyle: "automatic",
  ios: {
    bundleIdentifier: iosBundleIdentifier,
    ...(process.env.APPLE_TEAM_ID ? { appleTeamId: process.env.APPLE_TEAM_ID } : {}),
    ...(process.env.IOS_BUILD_NUMBER ? { buildNumber: process.env.IOS_BUILD_NUMBER } : {}),
    // Light, dark and tinted (iOS 18).
    icon: {
      light: `${ICONS}/peekNight/ios.png`,
      dark: `${ICONS}/peekNight/ios-dark.png`,
      tinted: `${ICONS}/peekNight/ios-tinted.png`,
    },
    supportsTablet: false,
    usesAppleSignIn: true,
    associatedDomains: [`applinks:${linkHost}`],
    config: { usesNonExemptEncryption: false },
  },
  android: {
    package: process.env.ANDROID_PACKAGE ?? `app.tich.rooms${suffix}`,
    // Firebase's config comes from the build's environment, so the public repo carries none and a self-built app
    // brings its own Firebase project.
    ...(process.env.GOOGLE_SERVICES_JSON ? { googleServicesFile: process.env.GOOGLE_SERVICES_JSON } : {}),
    ...(process.env.ANDROID_VERSION_CODE ? { versionCode: Number(process.env.ANDROID_VERSION_CODE) } : {}),
    // Two layers (the night sky, the agent), so the launcher's mask and motion cut them like the iOS icon, and the
    // agent alone in one color for Android 13's themed icons.
    adaptiveIcon: {
      foregroundImage: `${ICONS}/peekNight/android-foreground.png`,
      backgroundImage: `${ICONS}/peekNight/android-background.png`,
      monochromeImage: `${ICONS}/peekNight/android-monochrome.png`,
      backgroundColor: "#03101f",
    },
    predictiveBackGestureEnabled: false,
    // Never read the phone's photos or play in the background: the image picker is Android's photo picker, Salvar em
    // Fotos only adds (MediaStore needs no permission for it) and voice messages stop when the app leaves. Google
    // Play asks a justification for the media reads and a video for a media-playback foreground service, so keep
    // them out even if a library's manifest brings them.
    blockedPermissions: [
      "android.permission.READ_MEDIA_IMAGES",
      "android.permission.READ_MEDIA_VIDEO",
      "android.permission.READ_MEDIA_VISUAL_USER_SELECTED",
      "android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK",
    ],
    intentFilters: [
      {
        action: "VIEW",
        autoVerify: true,
        data: APP_LINK_PATTERNS.map((pattern) => ({
          scheme: "https",
          host: linkHost,
          pathPattern: pattern.replace(/\*/g, ".*"),
        })),
        category: ["BROWSABLE", "DEFAULT"],
      },
    ],
  },
  // Native permission texts (the OS shows them before the app's i18n runs). Only ready languages
  // (@agenteschat/i18n/locale), here and in `supportedLocales`: the stores list these as the app's languages.
  locales: {
    en: "./assets/locales/en.json",
    "pt-BR": "./assets/locales/pt-BR.json",
    es: "./assets/locales/es.json",
    fr: "./assets/locales/fr.json",
    de: "./assets/locales/de.json",
    it: "./assets/locales/it.json",
    nl: "./assets/locales/nl.json",
    ja: "./assets/locales/ja.json",
    ko: "./assets/locales/ko.json",
    "zh-Hans": "./assets/locales/zh-Hans.json",
    id: "./assets/locales/id.json",
    tr: "./assets/locales/tr.json",
    pl: "./assets/locales/pl.json",
    ru: "./assets/locales/ru.json",
  },
  plugins: [
    ["expo-router", { redirects: LEGACY_REDIRECTS }],
    ["expo-screen-orientation", { initialOrientation: "PORTRAIT_UP" }],
    "expo-secure-store",
    // Every ready language, so Android 13+ and iOS offer it as the app's own language.
    [
      "expo-localization",
      {
        supportedLocales: ["en", "pt-BR", "es", "fr", "de", "it", "nl", "ja", "ko", "zh-Hans", "id", "tr", "pl", "ru"],
      },
    ],
    "expo-web-browser",
    "expo-apple-authentication",
    [
      "expo-splash-screen",
      {
        // The first frame of the animated splash (src/features/launch): same image, size and background as
        // the app (white in light), so the hand-over doesn't show. Keep LOGO in launch/logic.ts in step.
        image: "./assets/images/splash-icon.png",
        imageWidth: 120,
        resizeMode: "contain",
        backgroundColor: "#ffffff",
        dark: { image: "./assets/images/splash-icon.png", backgroundColor: "#0f0f0e" },
      },
    ],
    [
      // Pushes come straight from Firebase and from Apple with the system's own token (ADR 0152, ADR 0178). The
      // plugin's `aps-environment` entitlement stays as it is: the profile that signs an iPhone build decides which
      // of Apple's push environments its tokens belong to (a store build's is production), and the app reads that
      // from the profile when it registers (src/lib/push.ts).
      "expo-notifications",
      {
        icon: "./assets/images/notification-icon.png",
        color: "#0063d1",
      },
    ],
    // Android release builds signed with the upload key from the environment (the Android build workflow).
    "./plugins/with-android-release-signing",
    // The app icons a person may pick (ADR 0179): iOS's alternate icons and Android's launcher aliases.
    "./plugins/with-app-icons",
    [
      "expo-image-picker",
      {
        photosPermission: "To send pictures in your conversations.",
        cameraPermission: CAMERA_USE,
      },
    ],
    [
      // Escanear QR code (Seu servidor): QR codes only, so no microphone.
      "expo-camera",
      { cameraPermission: CAMERA_USE, microphonePermission: false, recordAudioAndroid: false },
    ],
    [
      // Mensagens de voz (ADR 0100): the app records only while the person holds or locks the button.
      "expo-audio",
      // No background playback (the plugin's default is on): it would add a media-playback foreground service.
      {
        microphonePermission: "To record voice messages in your conversations.",
        recordAudioAndroid: true,
        enableBackgroundPlayback: false,
      },
    ],
    // The agents at work in the Dynamic Island and on the Lock Screen (ADR 0210): a widget extension
    // (`<bundle id>.ExpoWidgetsTarget`, in the app group `group.<bundle id>`) for the Live Activity the server starts,
    // updates and ends by push; `frequentUpdates` lets those pushes come as often as an agent moves on.
    ["expo-widgets", { enablePushNotifications: true, frequentUpdates: true }],
    // The share extension reads as the app in the share sheet. Before expo-share-intent, so it runs once the
    // extension's files are written (a project's changes run from the last plugin to the first).
    "./plugins/with-share-extension-name",
    // The agents a person sends to, among the share sheet's suggestions (ADR 0213): the app declares the intent it
    // donates, the extension the suggestions it takes and passes the one picked on to the app. Also before
    // expo-share-intent, for the same reason.
    "./plugins/with-share-suggestions",
    [
      // "Compartilhar com…": the app in the system's share sheet (an iOS share extension and Android's send intents),
      // for photos, videos, files, links and text; what arrives opens the agent picker (src/features/share). The
      // extension shares the app's URL scheme; it reaches phones only with a new native build. No
      // `iosShareExtensionName`: it also names the extension's Xcode target, and the app's name there is the app's
      // own target, so the extension was never made (plugins/with-share-extension-name.js gives it its name).
      "expo-share-intent",
      {
        iosActivationRules: {
          NSExtensionActivationSupportsText: true,
          NSExtensionActivationSupportsWebURLWithMaxCount: 1,
          NSExtensionActivationSupportsWebPageWithMaxCount: 1,
          NSExtensionActivationSupportsImageWithMaxCount: 10,
          NSExtensionActivationSupportsMovieWithMaxCount: 10,
          NSExtensionActivationSupportsFileWithMaxCount: 10,
        },
        androidIntentFilters: ["text/*", "image/*", "video/*", "application/*"],
        androidMultiIntentFilters: ["image/*", "video/*", "*/*"],
      },
    ],
    [
      // Salvar em Fotos: add-only access (the read text matches expo-image-picker's). No granular reads on Android:
      // saveToPhotos asks write-only, which needs none from Android 13 on.
      "expo-media-library",
      {
        photosPermission: "To send pictures in your conversations.",
        savePhotosPermission: "To save pictures from your conversations to Photos.",
        granularPermissions: [],
      },
    ],
  ],
  experiments: { typedRoutes: false },
  extra: {
    apiUrl,
    variant,
    ...(projectId ? { eas: { projectId } } : {}),
  },
  runtimeVersion: { policy: "appVersion" },
});
