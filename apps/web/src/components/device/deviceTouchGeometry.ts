import type { DeviceOrientation } from "@ryco/contracts";

/**
 * How far the pane turns the device for each orientation, clockwise in CSS
 * degrees. `landscape-left` is a counterclockwise quarter turn of the device,
 * so the chassis turns -90°; the guest draws its interface upright inside it.
 */
export const DEVICE_ORIENTATION_ROTATION: Readonly<Record<DeviceOrientation, number>> = {
  portrait: 0,
  "landscape-left": -90,
  "portrait-upside-down": 180,
  "landscape-right": 90,
};

/**
 * A pointer position in an element's own, untransformed layout box.
 *
 * The device can be turned with a CSS rotation of its chassis, and may be
 * scaled by its container, so client coordinates cannot simply be offset by
 * the bounding rectangle: that is the rotated box. This undoes the rotation
 * about the box centre and the uniform scale, leaving coordinates in the
 * element's `layoutWidth × layoutHeight` space. Positions outside the element
 * come back outside that range; callers decide what leaving means.
 */
export function clientPointToLayoutPoint(
  input: {
    readonly rect: {
      readonly left: number;
      readonly top: number;
      readonly width: number;
      readonly height: number;
    };
    readonly layoutWidth: number;
    readonly layoutHeight: number;
    /** The element's total rotation in degrees, clockwise; multiples of 90. */
    readonly rotationDegrees: number;
  },
  clientX: number,
  clientY: number,
): { readonly x: number; readonly y: number } | null {
  const { rect, layoutWidth, layoutHeight } = input;
  if (layoutWidth <= 0 || layoutHeight <= 0) return null;
  const turns = (((Math.round(input.rotationDegrees / 90) % 4) + 4) % 4) as 0 | 1 | 2 | 3;
  const sideways = turns % 2 === 1;
  const scale = rect.width / (sideways ? layoutHeight : layoutWidth);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const dx = (clientX - (rect.left + rect.width / 2)) / scale;
  const dy = (clientY - (rect.top + rect.height / 2)) / scale;
  // Rotate the offset back by the element's rotation (screen y points down).
  const [ux, uy] =
    turns === 0 ? [dx, dy] : turns === 1 ? [dy, -dx] : turns === 2 ? [-dx, -dy] : [-dy, dx];
  return { x: ux + layoutWidth / 2, y: uy + layoutHeight / 2 };
}
