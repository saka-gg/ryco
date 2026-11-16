package expo.modules.ryconativecontrols

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class RycoNativeControlsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("RycoNativeControls")

    // Upstream's screenshot/showcase-rig functions (getShowcaseScene, markShowcaseReady,
    // prepareShowcaseCapture, getShowcasePairingUrl) are omitted: the showcase rig is stripped from the Ryco MVP.

    View(RycoHeaderButtonView::class) {
      Prop("label") { view: RycoHeaderButtonView, label: String ->
        view.setLabel(label)
      }
      Prop("systemImage") { view: RycoHeaderButtonView, systemImage: String ->
        view.setSystemImage(systemImage)
      }

      Events("onTriggered")
    }
  }
}
