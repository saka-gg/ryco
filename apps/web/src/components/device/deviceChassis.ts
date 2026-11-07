// The chassis numbers are adapted from Emanuele-web04/synara commit dd88d927 (MIT);
// see THIRD_PARTY_NOTICES.md.
/*
 * The device chassis both views draw: the SVG frame of the 2D view
 * (`DeviceFrame.tsx`) and the extruded body of the 3D view
 * (`scene3d/deviceBody.ts`). One set of numbers, so a device has the same
 * bezel, screen corner and side buttons in either view.
 *
 * Plain data and path math: no React and no three.js, so either view can
 * import it without pulling in the other.
 */

export type DeviceKind = "iPhone" | "androidPhone" | "iPad";

export type ChassisNub = {
  side: "left" | "right" | "top";
  /** Offset along the edge in device pixels. Negative on `top` measures from the right. */
  at: number;
  len: number;
  name: string;
};

export type ChassisSpec = {
  pixelW: number;
  pixelH: number;
  screenRadius: number;
  /** The three concentric band widths, outermost first. */
  frame: number;
  silver: number;
  grey: number;
  /** How far the side buttons protrude past the outer band. */
  nubProtrude: number;
  nubs: ChassisNub[];
};

export const CHASSIS_SPECS: Readonly<Record<DeviceKind, ChassisSpec>> = {
  iPhone: {
    pixelW: 1206,
    pixelH: 2622,
    screenRadius: 186,
    frame: 34,
    silver: 8,
    grey: 12,
    nubProtrude: 27,
    nubs: [
      { side: "left", at: 507, len: 102, name: "action" },
      { side: "left", at: 690, len: 192, name: "volumeUp" },
      { side: "left", at: 927, len: 192, name: "volumeDown" },
      { side: "right", at: 813, len: 303, name: "power" },
    ],
  },
  androidPhone: {
    pixelW: 1080,
    pixelH: 2400,
    screenRadius: 100,
    frame: 22,
    silver: 6,
    grey: 8,
    nubProtrude: 18,
    nubs: [
      { side: "right", at: 480, len: 130, name: "power" },
      { side: "right", at: 670, len: 240, name: "volumeRocker" },
    ],
  },
  iPad: {
    pixelW: 1668,
    pixelH: 2420,
    screenRadius: 58,
    frame: 64,
    silver: 12,
    grey: 16,
    nubProtrude: 20,
    nubs: [
      { side: "right", at: 202, len: 104, name: "volumeUp" },
      { side: "right", at: 328, len: 104, name: "volumeDown" },
      { side: "top", at: -148, len: 126, name: "power" },
    ],
  },
};

/** The bezel: every band between the screen and the outer edge, in device pixels. */
export function chassisEdge(spec: ChassisSpec): number {
  return spec.frame + spec.silver + spec.grey;
}

/** What a squircle is traced onto: an SVG path builder, a canvas path or a three.js `Shape`. */
export interface PathSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void;
}

/**
 * Continuous ("squircle") rounded rectangle. Each corner is three cubic Béziers
 * rather than an arc — that curvature ramp is what makes it read as an Apple
 * device instead of a rounded rect. The magic numbers are fixed multiples of the
 * corner radius and are not derivable from anything simpler.
 *
 * Traced clockwise in a y-down space (counterclockwise in three.js's y-up
 * space, which is the winding its shapes expect for a front face).
 */
export function traceSquircle(
  sink: PathSink,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
): void {
  const r = Math.min(radius, Math.min(w, h) / 3.06);
  const c1 = 1.528665 * r;
  const c2 = 1.088311 * r;
  const c3 = 0.868407 * r;
  const c4 = 0.631494 * r;
  const c5 = 0.372375 * r;
  const c6 = 0.16906 * r;
  const c7 = 0.066987 * r;
  const right = x + w;
  const bottom = y + h;

  sink.moveTo(x + c1, y);
  sink.lineTo(right - c1, y);
  sink.bezierCurveTo(right - c2, y, right - c3, y, right - c4, y + c7);
  sink.bezierCurveTo(right - c5, y + c6, right - c6, y + c5, right - c7, y + c4);
  sink.bezierCurveTo(right, y + c3, right, y + c2, right, y + c1);
  sink.lineTo(right, bottom - c1);
  sink.bezierCurveTo(right, bottom - c2, right, bottom - c3, right - c7, bottom - c4);
  sink.bezierCurveTo(right - c6, bottom - c5, right - c5, bottom - c6, right - c4, bottom - c7);
  sink.bezierCurveTo(right - c3, bottom, right - c2, bottom, right - c1, bottom);
  sink.lineTo(x + c1, bottom);
  sink.bezierCurveTo(x + c2, bottom, x + c3, bottom, x + c4, bottom - c7);
  sink.bezierCurveTo(x + c5, bottom - c6, x + c6, bottom - c5, x + c7, bottom - c4);
  sink.bezierCurveTo(x, bottom - c3, x, bottom - c2, x, bottom - c1);
  sink.lineTo(x, y + c1);
  sink.bezierCurveTo(x, y + c2, x, y + c3, x + c7, y + c4);
  sink.bezierCurveTo(x + c6, y + c5, x + c5, y + c6, x + c4, y + c7);
  sink.bezierCurveTo(x + c3, y, x + c2, y, x + c1, y);
}

/** The squircle as SVG path data. */
export function squirclePath(x: number, y: number, w: number, h: number, radius: number): string {
  const n = (v: number) => +v.toFixed(3);
  const parts: string[] = [];
  traceSquircle(
    {
      moveTo: (px, py) => parts.push(`M${n(px)} ${n(py)}`),
      lineTo: (px, py) => parts.push(`L${n(px)} ${n(py)}`),
      bezierCurveTo: (a, b, c, d, e, f) =>
        parts.push(`C${n(a)} ${n(b)} ${n(c)} ${n(d)} ${n(e)} ${n(f)}`),
    },
    x,
    y,
    w,
    h,
    radius,
  );
  parts.push("Z");
  return parts.join("");
}
