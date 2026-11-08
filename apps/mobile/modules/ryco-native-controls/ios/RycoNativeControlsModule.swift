import ExpoModulesCore
import UIKit

public final class RycoNativeControlsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("RycoNativeControls")

    // Upstream's screenshot/showcase-rig functions (getShowcaseScene,
    // markShowcaseReady, prepareShowcaseCapture, getShowcasePairingUrl) are
    // omitted: the showcase rig is stripped from the Ryco MVP.
    // The composer offers Take Photo only where UIKit has a camera: presenting
    // a camera picker without one (the Simulator) raises and ends the app.
    Function("isCameraAvailable") { () -> Bool in
      UIImagePickerController.isSourceTypeAvailable(.camera)
    }

    View(RycoHeaderButtonView.self) {
      Prop("label") { (view: RycoHeaderButtonView, label: String) in
        view.setLabel(label)
      }
      Prop("systemImage") { (view: RycoHeaderButtonView, systemImage: String) in
        view.setSystemImage(systemImage)
      }

      Events("onTriggered")
    }
  }
}
