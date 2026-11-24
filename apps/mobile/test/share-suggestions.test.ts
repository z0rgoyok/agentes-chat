import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import config from "../app.config";
import { pickedOf, pickedOfShareLink, suggestionId } from "../src/features/share/picked";

// The config plugin is plain CommonJS (expo prebuild loads it); only its pure parts are tested here.
const { withIntentsSupported, withPickedSuggestion, withActivityType } =
  require("../plugins/with-share-suggestions") as {
    withIntentsSupported: (plist: string) => string;
    withPickedSuggestion: (swift: string) => string;
    withActivityType: (plist: Record<string, unknown>) => Record<string, unknown>;
  };

const PLIST = `<plist version="1.0">
<dict>
\t<key>NSExtension</key>
\t<dict>
\t\t<key>NSExtensionAttributes</key>
\t\t<dict>
\t\t\t<key>NSExtensionActivationRule</key>
\t\t\t<dict/>
\t\t</dict>
\t\t<key>NSExtensionPointIdentifier</key>
\t\t<string>com.apple.share-services</string>
\t</dict>
</dict>
</plist>`;

/** The share extension's controller exactly as the installed expo-share-intent writes it. */
const CONTROLLER = readFileSync(
  require.resolve("expo-share-intent/plugin/build/ios/ShareExtensionViewController.swift"),
  "utf8",
);

describe("the agents in the share sheet's suggestions", () => {
  test("the extension takes the suggestions the app donates, under its attributes, once", () => {
    const out = withIntentsSupported(PLIST);
    expect(out).toMatch(
      /<key>NSExtensionAttributes<\/key>\s*<dict>\s*<key>IntentsSupported<\/key>\s*<array>\s*<string>INSendMessageIntent<\/string>\s*<\/array>/,
    );
    expect(out).toContain("<key>NSExtensionActivationRule</key>");
    expect(withIntentsSupported(out)).toBe(out);
    expect(() => withIntentsSupported("<plist><dict></dict></plist>")).toThrow();
  });

  test("the extension's link to the app carries the picked conversation, on the controller as the library writes it", () => {
    const out = withPickedSuggestion(CONTROLLER);
    expect(out).toContain("import Intents\nimport UIKit");
    expect(out).toContain("?nonce=\\(nonce)\\(pickedSuggestion)#\\(type)");
    expect(out).toContain("extensionContext?.intent as? INSendMessageIntent");
    // Inside the controller, before its last type: one helper, however many builds run the plugin.
    expect(out.indexOf("private var pickedSuggestion")).toBeLessThan(out.indexOf("enum RedirectType"));
    expect(withPickedSuggestion(out)).toBe(out);
  });

  test("a controller the library wrote differently stops the build instead of shipping no suggestions", () => {
    expect(() => withPickedSuggestion(CONTROLLER.replace("?nonce=\\(nonce)#", "#"))).toThrow();
  });

  test("the app declares the intent it donates, keeping what others declared", () => {
    expect(withActivityType({})).toEqual({ NSUserActivityTypes: ["INSendMessageIntent"] });
    const kept = withActivityType({ NSUserActivityTypes: ["chat.agentes.app.view"], Other: 1 });
    expect(kept).toEqual({ NSUserActivityTypes: ["chat.agentes.app.view", "INSendMessageIntent"], Other: 1 });
    expect(withActivityType(kept)).toBe(kept);
  });

  test("the plugin runs once the extension is written: listed before expo-share-intent", () => {
    const names = (config({ config: {} } as never).plugins ?? []).map((p) => (Array.isArray(p) ? p[0] : p));
    const at = names.indexOf("./plugins/with-share-suggestions");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThan(names.indexOf("expo-share-intent"));
  });

  test("a pick names its workspace and agent, read back from the extension's link", () => {
    const id = suggestionId("org-1", "agent-2");
    expect(pickedOf(id)).toEqual({ orgId: "org-1", agentId: "agent-2" });
    // The extension escapes everything but letters and digits.
    const link = `agenteschat://dataUrl=agenteschatShareKey?nonce=N&to=${encodeURIComponent(id).replace(/-/g, "%2D")}#media`;
    expect(pickedOfShareLink(link)).toEqual({ orgId: "org-1", agentId: "agent-2" });
  });

  test("a share without a pick, or with one that doesn't read, chooses nobody", () => {
    expect(pickedOfShareLink("agenteschat://dataUrl=agenteschatShareKey?nonce=N#media")).toBeNull();
    expect(pickedOfShareLink(null)).toBeNull();
    expect(pickedOfShareLink("agenteschat://dataUrl=k?nonce=N&to=%E0%A4%A#media")).toBeNull();
    expect(pickedOf("only-one")).toBeNull();
    expect(pickedOf("a/b/c")).toBeNull();
    expect(pickedOf("/agent")).toBeNull();
  });
});
