/**
 * Expo config plugin: the agents in the system's share sheet (ADR 0213).
 *
 * The app donates each message a person sends to an agent (modules/share-suggestions), and iOS offers those
 * conversations at the top of the share sheet, beside the person's contacts. For that the app declares the intent it
 * donates (`NSUserActivityTypes`), the share extension declares the suggestions it takes (`IntentsSupported`), and
 * the extension passes the one picked on to the app: expo-share-intent's extension opens the app with a link, and this
 * plugin adds the picked conversation to it (`&to=<id>`), read by src/features/share/suggestions.ts.
 *
 * Listed before expo-share-intent, as plugins/with-share-extension-name.js is: a project's changes run from the last
 * plugin to the first, so this one runs once the extension's files are written. When expo-share-intent changes those
 * files so this no longer applies, the build stops here instead of shipping an extension without suggestions.
 */
const fs = require("node:fs");
const path = require("node:path");
const { withInfoPlist, withXcodeProject } = require("expo/config-plugins");

/** The intent the app donates and the extension takes. */
const INTENT = "INSendMessageIntent";

/** The files expo-share-intent writes for its default target name. */
const INFO_PLIST = path.join("ShareExtension", "ShareExtension-Info.plist");
const CONTROLLER = path.join("ShareExtension", "ShareViewController.swift");

/** The extension's link to the app, as expo-share-intent writes it. */
const LINK = 'URL(string: "\\(shareProtocol)://dataUrl=\\(sharedKey)?nonce=\\(nonce)#\\(type)")!';
const LINK_WITH_PICK =
  'URL(string: "\\(shareProtocol)://dataUrl=\\(sharedKey)?nonce=\\(nonce)\\(pickedSuggestion)#\\(type)")!';

/** Where the helper goes: right before the controller's last type, inside its class. */
const BEFORE = "\n  enum RedirectType {";

const PICKED = `
  /// The conversation picked among the share sheet's suggestions (ADR 0213), as \`&to=<id>\` on the link to the app;
  /// empty when the share didn't come through one.
  private var pickedSuggestion: String {
    guard let intent = extensionContext?.intent as? INSendMessageIntent,
      let id = intent.conversationIdentifier,
      let value = id.addingPercentEncoding(withAllowedCharacters: .alphanumerics)
    else { return "" }
    return "&to=\\(value)"
  }
`;

/** The extension's Info.plist taking the share sheet's suggestions; throws when it has no attributes to add them to. */
function withIntentsSupported(plist) {
  if (plist.includes("<key>IntentsSupported</key>")) return plist;
  const attributes = /(<key>NSExtensionAttributes<\/key>\s*<dict>)/;
  if (!attributes.test(plist)) {
    throw new Error("with-share-suggestions: no NSExtensionAttributes in the extension's Info.plist");
  }
  return plist.replace(
    attributes,
    (head) =>
      `${head}\n\t\t\t<key>IntentsSupported</key>\n\t\t\t<array>\n\t\t\t\t<string>${INTENT}</string>\n\t\t\t</array>`,
  );
}

/** The extension's controller putting the picked suggestion on its link; throws when the link isn't as expected. */
function withPickedSuggestion(swift) {
  if (swift.includes("pickedSuggestion")) return swift;
  if (!swift.includes(LINK) || !swift.includes(BEFORE) || !swift.includes("import UIKit")) {
    throw new Error("with-share-suggestions: the share extension's link to the app is not where this plugin expects");
  }
  return swift
    .replace("import UIKit", "import Intents\nimport UIKit")
    .replace(LINK, LINK_WITH_PICK)
    .replace(BEFORE, `${PICKED}${BEFORE}`);
}

/** The app's Info.plist declaring the intent it donates, keeping what other plugins declared. */
function withActivityType(infoPlist) {
  const types = Array.isArray(infoPlist.NSUserActivityTypes) ? infoPlist.NSUserActivityTypes : [];
  return types.includes(INTENT) ? infoPlist : { ...infoPlist, NSUserActivityTypes: [...types, INTENT] };
}

module.exports = function withShareSuggestions(config) {
  const withApp = withInfoPlist(config, (mod) => {
    mod.modResults = withActivityType(mod.modResults);
    return mod;
  });
  return withXcodeProject(withApp, (mod) => {
    const root = mod.modRequest.platformProjectRoot;
    for (const [file, edit] of [
      [INFO_PLIST, withIntentsSupported],
      [CONTROLLER, withPickedSuggestion],
    ]) {
      const full = path.join(root, file);
      if (!fs.existsSync(full)) throw new Error(`with-share-suggestions: the share extension has no ${file}`);
      fs.writeFileSync(full, edit(fs.readFileSync(full, "utf8")));
    }
    return mod;
  });
};

module.exports.withIntentsSupported = withIntentsSupported;
module.exports.withPickedSuggestion = withPickedSuggestion;
module.exports.withActivityType = withActivityType;
