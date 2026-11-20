import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  APP_ICONS,
  MADE_ICON_COLORS,
  MADE_ICON_FACES,
  MADE_ICON_LOOKS,
  MADE_ICON_POSES,
  MADE_ICON_SKIES,
  madeIconId,
  madeIconOf,
  madeIcons,
  PHONE_APP_ICON,
} from "@agenteschat/client/lib/app-icons";
import { iconOfNativeName, nativeIconName, phoneIcons } from "../src/features/me/app-icon-names";

interface Node {
  $?: Record<string, string>;
  [child: string]: unknown;
}
interface Manifest {
  manifest: { application: { activity?: Node[]; "activity-alias"?: Node[] }[] };
}

// The config plugin is plain CommonJS (expo prebuild loads it); its pure parts are tested here.
const plugin = require("../plugins/with-app-icons") as {
  ICONS: string[];
  SHIPPED: string;
  MADE: { skies: string[]; colors: string[]; faces: string[]; looks: string[]; poses: string[] };
  MADE_IDS: string[];
  iosName: (id: string) => string;
  androidAlias: (id: string) => string;
  androidRes: (id: string) => string;
  launcherAliases: (manifest: Manifest) => Manifest;
};

const ASSETS = join(import.meta.dir, "..", "assets", "app-icons");
const filter = (...names: [string, string][]) => ({
  action: names.filter(([k]) => k === "action").map(([, n]) => ({ $: { "android:name": n } })),
  category: names.filter(([k]) => k === "category").map(([, n]) => ({ $: { "android:name": n } })),
});
/** Expo's MainActivity: the launcher's filter and one for links. */
const manifest = (): Manifest => ({
  manifest: {
    application: [
      {
        activity: [
          {
            $: { "android:name": ".MainActivity", "android:exported": "true" },
            "intent-filter": [
              filter(["action", "android.intent.action.MAIN"], ["category", "android.intent.category.LAUNCHER"]),
              filter(["action", "android.intent.action.VIEW"], ["category", "android.intent.category.BROWSABLE"]),
            ],
          },
        ],
        "activity-alias": [{ $: { "android:name": ".SomethingElse" } }],
      },
    ],
  },
});

describe("app icons on the phone (ADR 0179)", () => {
  test("the plugin, the app and the shared list name the same icons", () => {
    expect(plugin.ICONS).toEqual([...APP_ICONS]);
    // The phone ships the agent leaning in (Espiando): the app's own icon, the others picked by name.
    expect(plugin.SHIPPED).toBe(PHONE_APP_ICON);
    expect(PHONE_APP_ICON).toBe("peekNight");
    for (const id of APP_ICONS) {
      expect(nativeIconName(id, "ios")).toBe(id === PHONE_APP_ICON ? null : plugin.iosName(id));
      expect(nativeIconName(id, "android")).toBe(plugin.androidAlias(id));
      expect(iconOfNativeName(nativeIconName(id, "ios"), "ios")).toBe(id);
      expect(iconOfNativeName(nativeIconName(id, "android"), "android")).toBe(id);
    }
    expect(iconOfNativeName("AppIcon-gone", "ios")).toBe(PHONE_APP_ICON);
    expect(plugin.androidRes("peekNight")).toBe("ic_launcher_peek_night");
  });

  test("Android's launcher entry moves to one alias per icon, only the shipped one on", () => {
    const out = plugin.launcherAliases(manifest());
    const app = out.manifest.application[0];
    const main = app?.activity?.[0];
    // The links' filter stays on MainActivity; the launcher's leaves it.
    expect(main?.["intent-filter"]).toEqual([
      filter(["action", "android.intent.action.VIEW"], ["category", "android.intent.category.BROWSABLE"]),
    ]);
    const aliases = app?.["activity-alias"] ?? [];
    expect(aliases.slice(0, 6).map((a) => a.$?.["android:name"])).toEqual([
      ".SomethingElse",
      ".AppIconNight",
      ".AppIconMoon",
      ".AppIconSky",
      ".AppIconPeekNight",
      ".AppIconPeekSky",
    ]);
    const ours = aliases.slice(1);
    // The ready ones, then every icon a person can make, as the app lists them for the module.
    expect(ours.map((a) => a.$?.["android:name"])).toEqual(phoneIcons().map((i) => `.${nativeIconName(i, "android")}`));
    // Only the shipped one (Espiando on the night sky, the fourth) is on, with the app's own icon.
    expect(ours.map((a) => a.$?.["android:enabled"])).toEqual(ours.map((_, i) => (i === 3 ? "true" : "false")));
    expect(ours[5]?.$?.["android:icon"]).toBe("@mipmap/ic_launcher_made_night_sky_round");
    expect(ours[3]?.$?.["android:icon"]).toBe("@mipmap/ic_launcher");
    expect(ours[0]?.$?.["android:icon"]).toBe("@mipmap/ic_launcher_night");
    for (const alias of ours) {
      expect(alias.$?.["android:targetActivity"]).toBe(".MainActivity");
      expect(alias["intent-filter"]).toEqual([
        filter(["action", "android.intent.action.MAIN"], ["category", "android.intent.category.LAUNCHER"]),
      ]);
    }
    // A second prebuild gives the same manifest.
    expect(plugin.launcherAliases(structuredClone(out))).toEqual(out);
  });

  test("the icons a person makes: the plugin, the app and the shared list name the same", () => {
    expect(plugin.MADE).toEqual({
      skies: [...MADE_ICON_SKIES],
      colors: [...MADE_ICON_COLORS],
      faces: [...MADE_ICON_FACES],
      looks: [...MADE_ICON_LOOKS],
      poses: [...MADE_ICON_POSES],
    });
    const made = madeIcons();
    // Facing: 2 skies × 8 colors × 21 faces and accessories. Leaning: 2 × 8 × 10 faces.
    expect(made).toHaveLength(336 + 160);
    expect(
      made.filter((icon) => icon.pose === "peek").every((icon) => MADE_ICON_FACES.includes(icon.look as never)),
    ).toBe(true);
    expect(plugin.MADE_IDS).toEqual(made.map(madeIconId));
    expect(new Set(made.map((icon) => nativeIconName(icon, "android"))).size).toBe(496);
    for (const icon of made) {
      const id = madeIconId(icon);
      expect(madeIconOf(id)).toEqual(icon);
      expect(nativeIconName(icon, "ios")).toBe(plugin.iosName(id));
      expect(nativeIconName(icon, "android")).toBe(plugin.androidAlias(id));
      expect(iconOfNativeName(nativeIconName(icon, "ios"), "ios")).toEqual(icon);
      expect(iconOfNativeName(nativeIconName(icon, "android"), "android")).toEqual(icon);
    }
    expect(plugin.iosName("made-sky-rose-heart")).toBe("AppIcon-made-sky-rose-heart");
    expect(plugin.androidAlias("made-sky-rose-heart")).toBe("AppIconMadeSkyRoseHeart");
    expect(plugin.androidRes("made-sky-rose-heart")).toBe("ic_launcher_made_sky_rose_heart");
    expect(plugin.iosName("made-sky-rose-heart-peek")).toBe("AppIcon-made-sky-rose-heart-peek");
    expect(plugin.androidAlias("made-sky-rose-heart-peek")).toBe("AppIconMadeSkyRoseHeartPeek");
    expect(plugin.androidRes("made-sky-rose-heart-peek")).toBe("ic_launcher_made_sky_rose_heart_peek");
    expect(madeIconOf("made-sky-rose-heart-peek")).toEqual({ sky: "sky", color: "rose", look: "heart", pose: "peek" });
    expect(madeIconOf("made-sky-rose-nothing")).toBeNull();
    // Leaning, the agent wears nothing.
    expect(madeIconOf("made-sky-rose-crown-peek")).toBeNull();
    expect(madeIconOf("made-sky-rose-heart-up")).toBeNull();
    expect(madeIconOf("night")).toBeNull();
    for (const sky of MADE_ICON_SKIES) {
      expect(existsSync(join(ASSETS, "made", `${sky}.png`))).toBe(true);
      expect(existsSync(join(ASSETS, "made", `${sky}-peek.png`))).toBe(true);
    }
  });

  test("every icon has the files the app and the plugin read", () => {
    const missing: string[] = [];
    for (const id of APP_ICONS) {
      const files = [
        "ios.png",
        "ios-dark.png",
        "ios-tinted.png",
        "android-foreground.png",
        "android-background.png",
        "android-monochrome.png",
        "preview.png",
        "preview-dark.png",
        ...(id === PHONE_APP_ICON ? [] : ["android-legacy.png"]),
      ];
      for (const file of files) if (!existsSync(join(ASSETS, id, file))) missing.push(`${id}/${file}`);
    }
    expect(missing).toEqual([]);
  });
});
