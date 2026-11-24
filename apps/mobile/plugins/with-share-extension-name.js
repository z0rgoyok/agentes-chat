/**
 * Expo config plugin: the iOS share extension shows the app's own name in the share sheet.
 *
 * expo-share-intent takes one option, `iosShareExtensionName`, for both the extension's Xcode target and the name
 * people read. Given the app's name, it found the app's own target by that name, took the extension for already
 * there and made none: no build had the share extension. So the option is left out (the target keeps its default
 * name, "ShareExtension"), and this plugin writes the name people read into the extension's Info.plist.
 *
 * Listed before expo-share-intent: a project's changes run from the last plugin to the first, so this one runs once
 * the extension's files are written.
 */
const fs = require("node:fs");
const path = require("node:path");
const { withXcodeProject } = require("expo/config-plugins");

/** The folder and file expo-share-intent writes for its default target name. */
const INFO_PLIST = path.join("ShareExtension", "ShareExtension-Info.plist");

const xml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The extension's Info.plist with `name` as the name people read; throws when the plist has none to replace. */
function withDisplayName(plist, name) {
  const key = /(<key>CFBundleDisplayName<\/key>\s*<string>)[^<]*(<\/string>)/;
  if (!key.test(plist)) {
    throw new Error("with-share-extension-name: no CFBundleDisplayName in the extension's Info.plist");
  }
  return plist.replace(key, (_, before, after) => `${before}${xml(name)}${after}`);
}

module.exports = function withShareExtensionName(config) {
  return withXcodeProject(config, (mod) => {
    const file = path.join(mod.modRequest.platformProjectRoot, INFO_PLIST);
    // No file: the extension wasn't made, which is the mistake this plugin exists for. Said before Xcode runs.
    if (!fs.existsSync(file)) throw new Error(`with-share-extension-name: the share extension has no ${INFO_PLIST}`);
    fs.writeFileSync(file, withDisplayName(fs.readFileSync(file, "utf8"), mod.name));
    return mod;
  });
};

module.exports.withDisplayName = withDisplayName;
