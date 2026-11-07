/*
 * How the 3D body lies, from the device's orientation and the frames it
 * sends. Plain math, no three.js: the device panel computes it on every
 * render while the viewer chunk may not be loaded yet.
 */

/**
 * Quarter turns, counterclockwise, from the body's screen to the frame's
 * picture: 0 when the frame turns with the body (an iOS framebuffer stays
 * portrait), 1 or 3 when the frame arrives upright for a body lying on its
 * side (Android turns its own frames).
 */
export type DeviceUvTurns = 0 | 1 | 3;

/**
 * How the 3D body lies for an orientation and the frames it receives.
 *
 * An iOS simulator keeps a portrait framebuffer when it turns, so the body
 * turns with its picture on it, as the 2D chassis does. Android turns its own
 * frames and records no orientation: a landscape frame means the device lies
 * on its side, and the picture is mapped upright onto the turned body.
 */
export function deviceTurn3d(
  rotationDegrees: number,
  frame: { readonly width: number; readonly height: number } | null,
): { readonly angle: number; readonly uvTurns: DeviceUvTurns } {
  // CSS turns clockwise; three.js turns counterclockwise about the screen normal.
  let angle = (-rotationDegrees * Math.PI) / 180;
  const frameLandscape = frame !== null && frame.width > frame.height;
  if (!frameLandscape) return { angle, uvTurns: 0 };
  let turns = ((Math.round(angle / (Math.PI / 2)) % 4) + 4) % 4;
  if (turns % 2 === 0) {
    angle += Math.PI / 2;
    turns = (turns + 1) % 4;
  }
  return { angle, uvTurns: turns === 1 ? 1 : 3 };
}
