/**
 * Expo config plugin: the app icons a person may pick on their phone (ADR 0179), besides the one the app ships with
 * (`ios.icon` and `android.adaptiveIcon` in app.config.ts). Their files are assets/app-icons/<id>/, written by
 * packages/ui/scripts/app-icons.mjs; the ids are packages/client's `APP_ICONS` (a test keeps them equal).
 * - iOS: one `AppIcon-<id>` set per icon in the asset catalog, in light, dark and tinted (iOS 18), named in
 *   ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES so the build lists them in Info.plist; the app switches with
 *   `setAlternateIconName` (modules/app-icon).
 * - Android: there is no call for it, so the launcher's entry moves from MainActivity to one `activity-alias` per icon
 *   (`.AppIcon<Id>`, only the shipped one on), each with its adaptive icon (back, front and one-color layers, and a
 *   PNG for Android 7); the app turns the picked one on and the others off.
 */
const fs = require("node:fs");
const path = require("node:path");
const { IOSConfig, withAndroidManifest, withDangerousMod, withXcodeProject } = require("expo/config-plugins");

const ICONS = ["night", "moon", "sky", "peekNight", "peekSky"];
/** The shipped icon is the app's own (`AppIcon`, `ic_launcher`); these are the others. */
const OTHERS = ICONS.slice(1);
const ASSETS = "assets/app-icons";

/** The icon's name in the iOS asset catalog (the shipped one is `AppIcon`, named `null` to UIKit). */
const iosName = (id) => `AppIcon-${id}`;
/** Its launcher entry on Android, relative to the app's package. */
const androidAlias = (id) => `AppIcon${id[0].toUpperCase()}${id.slice(1)}`;
/** Its resources on Android (lowercase and underscores): `peekNight` → `ic_launcher_peek_night`. */
const androidRes = (id) => `ic_launcher_${id.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}`;

/** The asset catalog's Contents.json for one icon's three looks (as Expo writes the shipped one's). */
function iosContents(files) {
  return {
    images: files.map(({ filename, appearance }) => ({
      filename,
      idiom: "universal",
      platform: "ios",
      size: "1024x1024",
      ...(appearance ? { appearances: [{ appearance: "luminosity", value: appearance }] } : {}),
    })),
    info: { author: "expo", version: 1 },
  };
}

const IOS_LOOKS = [
  { file: "ios.png", appearance: null },
  { file: "ios-dark.png", appearance: "dark" },
  { file: "ios-tinted.png", appearance: "tinted" },
];

function withIosIcons(config) {
  const withFiles = withDangerousMod(config, [
    "ios",
    async (c) => {
      const { projectRoot, platformProjectRoot, projectName } = c.modRequest;
      const catalog = path.join(platformProjectRoot, projectName, "Images.xcassets");
      for (const id of OTHERS) {
        const dir = path.join(catalog, `${iosName(id)}.appiconset`);
        fs.mkdirSync(dir, { recursive: true });
        const files = IOS_LOOKS.map(({ file, appearance }) => {
          const filename = `App-Icon${appearance ? `-${appearance}` : ""}-1024x1024@1x.png`;
          fs.copyFileSync(path.join(projectRoot, ASSETS, id, file), path.join(dir, filename));
          return { filename, appearance };
        });
        fs.writeFileSync(path.join(dir, "Contents.json"), `${JSON.stringify(iosContents(files), null, 2)}\n`);
      }
      return c;
    },
  ]);
  return withXcodeProject(withFiles, (c) => {
    const project = c.modResults;
    const { target } = IOSConfig.XcodeUtils.getApplicationNativeTarget({
      project,
      projectName: c.modRequest.projectName,
    });
    for (const [, build] of IOSConfig.XcodeUtils.getBuildConfigurationsForListId(
      project,
      target.buildConfigurationList,
    )) {
      build.buildSettings.ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES = `"${OTHERS.map(iosName).join(" ")}"`;
    }
    return c;
  });
}

const LAUNCHER = "android.intent.category.LAUNCHER";
const isLauncher = (filter) => (filter.category ?? []).some((c) => c.$?.["android:name"] === LAUNCHER);

/**
 * The manifest with the launcher's entry moved from MainActivity to one alias per icon (the shipped one on, with the
 * app's own `ic_launcher`). Run again, it gives the same: the aliases it made are replaced, nothing else is touched.
 */
function launcherAliases(manifest) {
  const app = manifest.manifest.application?.[0];
  const main = app?.activity?.find((a) => a.$?.["android:name"] === ".MainActivity");
  if (!main) throw new Error("with-app-icons: no .MainActivity in AndroidManifest.xml");
  main["intent-filter"] = (main["intent-filter"] ?? []).filter((f) => !isLauncher(f));
  const others = (app["activity-alias"] ?? []).filter((a) => !String(a.$?.["android:name"]).startsWith(".AppIcon"));
  app["activity-alias"] = [
    ...others,
    ...ICONS.map((id, i) => ({
      $: {
        "android:name": `.${androidAlias(id)}`,
        "android:targetActivity": ".MainActivity",
        "android:enabled": i === 0 ? "true" : "false",
        "android:exported": "true",
        "android:icon": i === 0 ? "@mipmap/ic_launcher" : `@mipmap/${androidRes(id)}`,
        "android:roundIcon": i === 0 ? "@mipmap/ic_launcher_round" : `@mipmap/${androidRes(id)}`,
      },
      "intent-filter": [
        {
          action: [{ $: { "android:name": "android.intent.action.MAIN" } }],
          category: [{ $: { "android:name": LAUNCHER } }],
        },
      ],
    })),
  ];
  return manifest;
}

/** One icon's adaptive icon (Android 8+); its layers are 432 px, Android's largest, in drawable-nodpi. */
const adaptiveXml = (res) => `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/${res}_background"/>
    <foreground android:drawable="@drawable/${res}_foreground"/>
    <monochrome android:drawable="@drawable/${res}_monochrome"/>
</adaptive-icon>
`;

function withAndroidIcons(config) {
  const withAliases = withAndroidManifest(config, (c) => {
    c.modResults = launcherAliases(c.modResults);
    return c;
  });
  return withDangerousMod(withAliases, [
    "android",
    async (c) => {
      const { projectRoot, platformProjectRoot } = c.modRequest;
      const res = path.join(platformProjectRoot, "app", "src", "main", "res");
      const put = (dir, name, from) => {
        fs.mkdirSync(path.join(res, dir), { recursive: true });
        fs.copyFileSync(from, path.join(res, dir, name));
      };
      for (const id of OTHERS) {
        const name = androidRes(id);
        const from = (file) => path.join(projectRoot, ASSETS, id, file);
        for (const layer of ["background", "foreground", "monochrome"])
          put("drawable-nodpi", `${name}_${layer}.png`, from(`android-${layer}.png`));
        put("mipmap-xxxhdpi", `${name}.png`, from("android-legacy.png"));
        fs.mkdirSync(path.join(res, "mipmap-anydpi-v26"), { recursive: true });
        fs.writeFileSync(path.join(res, "mipmap-anydpi-v26", `${name}.xml`), adaptiveXml(name));
      }
      return c;
    },
  ]);
}

const withAppIcons = (config) => withAndroidIcons(withIosIcons(config));

module.exports = withAppIcons;
module.exports.ICONS = ICONS;
module.exports.iosName = iosName;
module.exports.androidAlias = androidAlias;
module.exports.androidRes = androidRes;
module.exports.launcherAliases = launcherAliases;
module.exports.iosContents = iosContents;
