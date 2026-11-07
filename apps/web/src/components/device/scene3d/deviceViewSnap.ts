// `nearestDeviceView` is adapted from pingdotgg/t3code commit 6577c6b6 (MIT); see
// THIRD_PARTY_NOTICES.md.
import { Quaternion, Vector3 } from "three";

const Y_AXIS = new Vector3(0, 1, 0);

export type DeviceViewName = "front" | "right" | "back" | "left";

/** A view the device settles into, and how far its yaw may stay turned around it. */
export interface DeviceViewSnap {
  readonly name: DeviceViewName;
  readonly rotation: Quaternion;
  readonly yawLimit: number;
}

function yaw(angle: number): Quaternion {
  return new Quaternion().setFromAxisAngle(Y_AXIS, angle);
}

/**
 * Where a released drag settles: tilt always returns to level, and the yaw
 * keeps the device turned within a band around the nearest view. Front and
 * back hold a wide band (a quarter turn in all), the sides a narrow one, so
 * a drag that ends near a side shows the side and anything else rests at an
 * angle the person chose.
 */
export const DEVICE_VIEW_SNAPS: readonly DeviceViewSnap[] = [
  { name: "front", rotation: yaw(0), yawLimit: Math.PI / 4 },
  { name: "right", rotation: yaw(-Math.PI / 2), yawLimit: Math.PI / 12 },
  { name: "back", rotation: yaw(Math.PI), yawLimit: Math.PI / 4 },
  { name: "left", rotation: yaw(Math.PI / 2), yawLimit: Math.PI / 12 },
];

export function deviceViewRotation(name: DeviceViewName): Quaternion {
  return (DEVICE_VIEW_SNAPS.find((snap) => snap.name === name) ?? DEVICE_VIEW_SNAPS[0]!).rotation;
}

export function nearestDeviceView<T extends { rotation: Quaternion; yawLimit: number }>(
  rotation: Quaternion,
  snaps: readonly T[],
) {
  let closest: T | null = null;
  let distance = Infinity;
  for (const snap of snaps) {
    const relative = rotation.clone().multiply(snap.rotation.clone().invert());
    const turn = 2 * Math.atan2(relative.y, relative.w);
    const limited = Math.max(
      -snap.yawLimit,
      Math.min(snap.yawLimit, Math.atan2(Math.sin(turn), Math.cos(turn))),
    );
    const candidate = snap.rotation.clone().premultiply(yaw(limited));
    const nextDistance = candidate.angleTo(rotation);
    if (nextDistance < distance - 1e-8) {
      distance = nextDistance;
      closest = { ...snap, rotation: candidate };
    }
  }
  return closest;
}
