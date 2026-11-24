import ExpoModulesCore
import UIKit

/// A transparent view nobody can touch that tells JavaScript whether the window is regular width and where the iPhone
/// Duo's fold crosses it, in its own points (ADR 0212): `onRegions` with `{ wide, fold: { x, y, width, height, active }
/// | null }`, sent only when something changed. The fold is the first division region taller than wide (the device
/// folded like a book) that crosses the view, inactive ones included, so the app can tell a fold is there before the
/// device bends; only an active one moves the panes.
final class DuoRegionsView: ExpoView {
  let onRegions = EventDispatcher()

  private struct Fold: Equatable {
    let frame: CGRect
    let active: Bool
  }

  private struct Regions: Equatable {
    let wide: Bool
    let fold: Fold?
  }

  /// What JavaScript was told last; nil sends the next reading whatever it is.
  private var sent: Regions?
  /// The size the regions were last read at.
  private var readSize: CGSize?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    isUserInteractionEnabled = false
    if #available(iOS 17.0, *) {
      registerForTraitChanges([UITraitHorizontalSizeClass.self], action: #selector(UIView.setNeedsUpdateConstraints))
    }
  }

  // It has no constraints of its own, and UIKit runs `updateConstraints()` only for views that take part in them.
  override class var requiresConstraintBasedLayout: Bool {
    true
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    guard window != nil else { return }
    sent = nil
    setNeedsUpdateConstraints()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    guard bounds.size != readSize else { return }
    readSize = bounds.size
    setNeedsUpdateConstraints()
  }

  // UIKit tracks the reserved regions read here and runs it again when they change: the device folded, or opened flat.
  override func updateConstraints() {
    if window != nil {
      send(Regions(wide: traitCollection.horizontalSizeClass == .regular, fold: readFold()))
    }
    super.updateConstraints()
  }

  private func readFold() -> Fold? {
    // iOS 27.1's API, in the SDK of Xcode 27.1 (Swift 6.4): an older Xcode builds the view without it (no fold, the
    // size class still read). Xcode 26.4 to 26.6 already bring Swift 6.3, so the check asks for 6.4; Xcode 27.0 has
    // Swift 6.4 but not this SDK, so the app builds with 27.1 or later.
    #if compiler(>=6.4)
    if #available(iOS 27.1, *) {
      let region = reservedRegions(kind: .division, options: .includeInactive).first { candidate in
        candidate.frame.height > candidate.frame.width && crosses(candidate.frame)
      }
      if let region {
        return Fold(frame: region.frame, active: region.isActive)
      }
    }
    #endif
    return nil
  }

  /// Whether a frame in this view's points overlaps it (a flat device's inactive fold may have no width).
  private func crosses(_ frame: CGRect) -> Bool {
    frame.minX < bounds.maxX && frame.maxX > bounds.minX && frame.minY < bounds.maxY && frame.maxY > bounds.minY
  }

  private func send(_ regions: Regions) {
    guard regions != sent else { return }
    sent = regions
    var fold: Any = NSNull()
    if let region = regions.fold {
      let frame: [String: Any] = [
        "x": Double(region.frame.minX),
        "y": Double(region.frame.minY),
        "width": Double(region.frame.width),
        "height": Double(region.frame.height),
        "active": region.active,
      ]
      fold = frame
    }
    onRegions(["wide": regions.wide, "fold": fold])
  }
}
