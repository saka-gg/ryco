/**
 * Turning a device a quarter turn at a time, shared by the server's `rotate`
 * button and the pane's rotate controls.
 *
 * @module deviceOrientation
 */
import type { DeviceOrientation } from "@ryco/contracts/device";

/** Counterclockwise, as Simulator.app's Rotate Left (⌘←) and its toolbar button. */
export const ROTATE_LEFT: Readonly<Record<DeviceOrientation, DeviceOrientation>> = {
  portrait: "landscape-left",
  "landscape-left": "portrait-upside-down",
  "portrait-upside-down": "landscape-right",
  "landscape-right": "portrait",
};

/** Clockwise, as Simulator.app's Rotate Right (⌘→). */
export const ROTATE_RIGHT: Readonly<Record<DeviceOrientation, DeviceOrientation>> = {
  portrait: "landscape-right",
  "landscape-right": "portrait-upside-down",
  "portrait-upside-down": "landscape-left",
  "landscape-left": "portrait",
};
