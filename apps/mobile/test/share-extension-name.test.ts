import { describe, expect, test } from "bun:test";
import config from "../app.config";

// The config plugin is plain CommonJS (expo prebuild loads it); only its pure part is tested here.
const { withDisplayName } = require("../plugins/with-share-extension-name") as {
  withDisplayName: (plist: string, name: string) => string;
};

const PLIST = `<plist version="1.0">
  <dict>
    <key>CFBundleName</key>
    <string>$(PRODUCT_NAME)</string>
    <key>CFBundleDisplayName</key>
    <string>agentes - Share Extension</string>
    <key>CFBundleIdentifier</key>
    <string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
  </dict>
</plist>`;

describe("the share extension's name", () => {
  test("the share sheet reads the app's name, and nothing else in the plist changes", () => {
    const out = withDisplayName(PLIST, "agentes");
    expect(out).toContain("<key>CFBundleDisplayName</key>\n    <string>agentes</string>");
    expect(out).toContain("<string>$(PRODUCT_NAME)</string>");
    expect(out.replace("<string>agentes</string>", "<string>agentes - Share Extension</string>")).toBe(PLIST);
  });

  test("a name with XML's own characters is written safely", () => {
    expect(withDisplayName(PLIST, "a & <b>")).toContain("<string>a &amp; &lt;b&gt;</string>");
  });

  test("a plist with no name to replace is an error, not a silent pass", () => {
    expect(() => withDisplayName("<plist><dict></dict></plist>", "agentes")).toThrow();
  });

  test("the extension keeps its own target name: the app's name there leaves the project with no extension", () => {
    const plugins = config({ config: {} } as never).plugins ?? [];
    const entry = plugins.find((p) => Array.isArray(p) && p[0] === "expo-share-intent") as [string, object] | undefined;
    expect(entry).toBeDefined();
    expect(entry?.[1]).not.toHaveProperty("iosShareExtensionName");
    // The plugins that edit the extension come before the one that makes it (the last listed runs first).
    const names = plugins.map((p) => (Array.isArray(p) ? p[0] : p));
    const share = names.indexOf("expo-share-intent");
    expect(names.indexOf("./plugins/with-share-extension-name")).toBeLessThan(share);
    expect(names.indexOf("./plugins/with-ios-manual-signing")).toBeLessThan(share);
    expect(names.indexOf("./plugins/with-share-extension-name")).toBeGreaterThanOrEqual(0);
  });
});
