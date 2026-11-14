import ExpoModulesCore
import UIKit

/// The app icon a person picks (ADR 0179). The others are the asset catalog's `AppIcon-<id>` sets, which
/// plugins/with-app-icons.js writes and lists for the build; `nil` is the app's own. iOS confirms a change with an
/// alert of its own, which apps can't turn off.
public class AppIconModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AppIcon")

    // `names` is Android's (its launcher entries); iOS knows its icons by name alone.
    AsyncFunction("supported") { (_: [String]) -> Bool in
      UIApplication.shared.supportsAlternateIcons
    }.runOnQueue(.main)

    AsyncFunction("get") { (_: [String]) -> String? in
      UIApplication.shared.alternateIconName
    }.runOnQueue(.main)

    AsyncFunction("set") { (_: [String], name: String?, promise: Promise) in
      guard UIApplication.shared.alternateIconName != name else {
        promise.resolve(nil)
        return
      }
      UIApplication.shared.setAlternateIconName(name) { error in
        if let error {
          promise.reject("ERR_APP_ICON", error.localizedDescription)
        } else {
          promise.resolve(nil)
        }
      }
    }.runOnQueue(.main)
  }
}
