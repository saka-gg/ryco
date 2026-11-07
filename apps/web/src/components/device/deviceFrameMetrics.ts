import type { DeviceDescriptor } from "@ryco/contracts";

import { deviceKindFor, RESOLUTION_SCALE, screenGeometry } from "./DeviceFrame";

/** The pixel size the chassis is drawn for, from discovery geometry or the stream. */
export function deviceFrameMetrics(
  device: DeviceDescriptor,
  dimensions?: { readonly width: number; readonly height: number } | null,
) {
  const kind = deviceKindFor(device);
  const scale = device.geometry?.scale ?? RESOLUTION_SCALE[kind];
  const pixelWidth = device.geometry
    ? Math.round(device.geometry.pointWidth * scale)
    : dimensions?.width;
  const pixelHeight = device.geometry
    ? Math.round(device.geometry.pointHeight * scale)
    : dimensions?.height;
  const { aspect } = screenGeometry(kind, pixelWidth, pixelHeight);
  const orientation = device.orientation ?? "portrait";
  const sideways = orientation === "landscape-left" || orientation === "landscape-right";
  /** Width over height of the device as drawn, turned with the device. */
  const drawnAspect = sideways ? 1 / aspect : aspect;
  return { kind, pixelWidth, pixelHeight, drawnAspect };
}
