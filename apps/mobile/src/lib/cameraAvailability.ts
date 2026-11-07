import { requireOptionalNativeModule } from "expo";

interface RycoNativeControlsModule {
  readonly isCameraAvailable?: () => boolean;
}

/**
 * Whether this device can take a photo. iOS answers from UIKit (a Simulator
 * has no camera, and presenting one there ends the app); a build without the
 * check, or another platform, assumes a camera.
 */
export function isCameraCaptureAvailable(): boolean {
  try {
    const native = requireOptionalNativeModule<RycoNativeControlsModule>("RycoNativeControls");
    return typeof native?.isCameraAvailable === "function" ? native.isCameraAvailable() : true;
  } catch {
    return true;
  }
}
