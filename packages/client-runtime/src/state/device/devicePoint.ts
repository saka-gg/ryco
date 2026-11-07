/**
 * Where a press on a device preview lands on the device: the preview letterboxes the frame
 * (`object-fit: contain`), and the device takes points, not frame pixels. Shared by web's
 * simulator panel and the phone's device viewer.
 *
 * @module devicePoint
 */
import type { DeviceDescriptor } from "@ryco/contracts";

export interface DevicePoint {
  readonly x: number;
  readonly y: number;
}

/**
 * The device's point size for a frame of `frameWidth × frameHeight` pixels: Android emulators
 * take display pixels (the geometry, turned to the frame's orientation, since streamed video
 * can be smaller than the display; the frame itself without one); iOS simulators take points,
 * from the device's geometry or the usual scale (2 for tablets, 3 for phones) when it is unknown.
 */
export function devicePointSize(
  device: Pick<DeviceDescriptor, "platform" | "geometry"> | null | undefined,
  frameWidth: number,
  frameHeight: number,
): { readonly pointWidth: number; readonly pointHeight: number } {
  if (device?.platform === "android-emulator") {
    const geometry = device.geometry;
    if (!geometry) return { pointWidth: frameWidth, pointHeight: frameHeight };
    // A rotation can reach the frames before the next descriptor does.
    const turned = geometry.pointWidth > geometry.pointHeight !== frameWidth > frameHeight;
    return turned
      ? { pointWidth: geometry.pointHeight, pointHeight: geometry.pointWidth }
      : { pointWidth: geometry.pointWidth, pointHeight: geometry.pointHeight };
  }
  const scale = device?.geometry?.scale ?? (frameWidth > 1_400 ? 2 : 3);
  return {
    pointWidth: device?.geometry?.pointWidth ?? frameWidth / scale,
    pointHeight: device?.geometry?.pointHeight ?? frameHeight / scale,
  };
}

/** The device point under (`canvasX`, `canvasY`) of a contained frame, or null on the letterbox. */
export function canvasPointToDevicePoint(
  input: {
    readonly frameWidth: number;
    readonly frameHeight: number;
    readonly displayWidth: number;
    readonly displayHeight: number;
    readonly pointWidth: number;
    readonly pointHeight: number;
  },
  canvasX: number,
  canvasY: number,
): DevicePoint | null {
  const scale = Math.min(
    input.displayWidth / input.frameWidth,
    input.displayHeight / input.frameHeight,
  );
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const width = input.frameWidth * scale;
  const height = input.frameHeight * scale;
  const x = canvasX - (input.displayWidth - width) / 2;
  const y = canvasY - (input.displayHeight - height) / 2;
  if (x < 0 || y < 0 || x > width || y > height) return null;
  return {
    x: Math.round((x / width) * input.pointWidth),
    y: Math.round((y / height) * input.pointHeight),
  };
}
