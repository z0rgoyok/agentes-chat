import ExpoModulesCore

/// The iPhone Duo's layout for the app's two panes (ADR 0212). React Native exposes neither the fold's reserved region
/// nor the window's size class, so `DuoRegionsView` reads both where UIKit tracks them and tells JavaScript.
public class DuoLayoutModule: Module {
  public func definition() -> ModuleDefinition {
    Name("DuoLayout")

    View(DuoRegionsView.self) {
      Events("onRegions")
    }
  }
}
