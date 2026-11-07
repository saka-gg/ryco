// The profile structure follows pingdotgg/t3code commit 6577c6b6
// (`packages/client-runtime/src/device/shapeProfile.ts`, MIT); see THIRD_PARTY_NOTICES.md.
import { CHASSIS_SPECS, chassisEdge, type DeviceKind } from "../deviceChassis";

/*
 * The 3D body of a device, in scene units where the screen is
 * `DEVICE_SCREEN_HEIGHT` tall in portrait. Built from the same chassis numbers
 * as the 2D frame, so the bezel, screen corner and side buttons agree, and from
 * the device's own screen aspect. Depth and the camera layout come from the
 * real devices' proportions; nothing here is taken from a vendor's artwork or
 * models.
 *
 * Plain data: no three.js, so the viewer chunk alone carries the renderer.
 */

export const DEVICE_SCREEN_HEIGHT = 2.2;

export type DeviceScreenCutout =
  | { readonly kind: "none" }
  /** A pill floating below the top edge. Fractions of the screen. */
  | {
      readonly kind: "island";
      readonly width: number;
      readonly height: number;
      readonly top: number;
    }
  /** A tab hanging from the top edge, with rounded lower corners. */
  | { readonly kind: "notch"; readonly width: number; readonly height: number }
  /** A round front camera in the screen. */
  | { readonly kind: "punch-hole"; readonly radius: number; readonly top: number };

export interface DeviceCameraModule {
  /** The raised plate, in scene units, measured from the back's top left as seen from behind. */
  readonly width: number;
  readonly height: number;
  readonly insetX: number;
  readonly insetY: number;
  readonly radius: number;
  readonly lensRadius: number;
  /** Lens centres, relative to the plate's centre, as seen from behind (x right, y up). */
  readonly lenses: ReadonlyArray<readonly [number, number]>;
  readonly flash: readonly [number, number] | null;
}

export interface DeviceSideButton {
  readonly side: "left" | "right" | "top";
  /** Centre along the edge, from the screen's centre (y up; x right on `top`). */
  readonly offset: number;
  readonly length: number;
}

export interface DeviceBodySpec {
  readonly kind: DeviceKind;
  /** Screen width over height in portrait. */
  readonly aspect: number;
  readonly screenWidth: number;
  readonly screenHeight: number;
  readonly screenRadius: number;
  readonly bezel: number;
  readonly depth: number;
  readonly buttonProtrude: number;
  readonly buttons: readonly DeviceSideButton[];
  readonly cutout: DeviceScreenCutout;
  readonly camera: DeviceCameraModule;
  /** A front camera drawn in the bezel (tablets), or null. */
  readonly bezelCamera: boolean;
  readonly colors: {
    readonly frame: number;
    readonly back: number;
    readonly metalness: number;
    readonly roughness: number;
  };
}

/** Thickness over screen height: iPhone 8.75 mm on ~146 mm, Pixel 8.5 on ~148, iPad Pro 13" 5.1 on ~265. */
const DEPTH_RATIO: Record<DeviceKind, number> = {
  iPhone: 0.058,
  androidPhone: 0.056,
  iPad: 0.02,
};

/**
 * iPhones before the 14 Pro have a notch, and so does the 16e. Everything
 * since (the 14 Pro, every 15, 16, 17, Air) has the floating island.
 */
function iPhoneCutout(name: string): DeviceScreenCutout {
  const lower = name.toLowerCase();
  if (/\bse\b/.test(lower)) return { kind: "none" };
  const notch = /iphone (?:x|xs|xr|11|12|13)\b|iphone 14(?! pro)|iphone \d+e\b/.test(lower);
  return notch
    ? { kind: "notch", width: 0.415, height: 0.038 }
    : { kind: "island", width: 0.313, height: 0.0425, top: 0.0126 };
}

/**
 * The rear camera by model name. The descriptor names no device type, so a
 * simulator the user renamed ("QA phone") gets the three-lens plate of the
 * Pro models, which most default simulators are; a name that says Air or a
 * plain numbered model ("iPhone 17", "iPhone 16e") gets that layout.
 */
function iPhoneCamera(name: string, width: number): DeviceCameraModule {
  const lower = name.toLowerCase();
  const plainModel = /iphone \d+[a-z]?\b/.test(lower) && !/\bpro\b/.test(lower);
  if (!plainModel && !/\bair\b/.test(lower)) {
    // Three lenses in a triangle on a square plate.
    return {
      width: 0.47,
      height: 0.47,
      insetX: 0.05,
      insetY: 0.05,
      radius: 0.11,
      lensRadius: 0.078,
      lenses: [
        [-0.105, 0.105],
        [-0.105, -0.105],
        [0.105, 0],
      ],
      flash: [0.115, 0.15],
    };
  }
  if (/\bair\b/.test(lower)) {
    // One lens on a bar across the top.
    return {
      width: width - 0.09,
      height: 0.25,
      insetX: 0.045,
      insetY: 0.06,
      radius: 0.11,
      lensRadius: 0.075,
      lenses: [[-(width - 0.09) / 2 + 0.14, 0]],
      flash: [-(width - 0.09) / 2 + 0.3, 0],
    };
  }
  // Two lenses on an upright pill.
  return {
    width: 0.25,
    height: 0.47,
    insetX: 0.06,
    insetY: 0.06,
    radius: 0.125,
    lensRadius: 0.078,
    lenses: [
      [0, 0.105],
      [0, -0.105],
    ],
    flash: null,
  };
}

const ANDROID_CAMERA: DeviceCameraModule = {
  width: 0.24,
  height: 0.47,
  insetX: 0.07,
  insetY: 0.07,
  radius: 0.12,
  lensRadius: 0.068,
  lenses: [
    [0, 0.11],
    [0, -0.11],
  ],
  flash: null,
};

const TABLET_CAMERA: DeviceCameraModule = {
  width: 0.2,
  height: 0.2,
  insetX: 0.08,
  insetY: 0.08,
  radius: 0.07,
  lensRadius: 0.052,
  lenses: [[0, 0]],
  flash: null,
};

/** The side buttons of the 2D frame, moved onto the 3D body's edges. */
function sideButtons(kind: DeviceKind, unitsPerPixel: number): DeviceSideButton[] {
  const spec = CHASSIS_SPECS[kind];
  const margin = chassisEdge(spec) + spec.nubProtrude;
  const boxH = spec.pixelH + 2 * margin;
  const boxW = spec.pixelW + 2 * margin;
  // Only nubs that are hardware on the real device; decorative ones too.
  return spec.nubs.map(({ side, at, len }) => {
    if (side === "top") {
      const start = at >= 0 ? at : boxW + at - len;
      return {
        side,
        offset: (start + len / 2 - boxW / 2) * unitsPerPixel,
        length: len * unitsPerPixel,
      };
    }
    return {
      side,
      offset: (boxH / 2 - (at + len / 2)) * unitsPerPixel,
      length: len * unitsPerPixel,
    };
  });
}

/**
 * The body for a device of `kind` whose screen is `aspect` wide over tall in
 * portrait (`min / max` of its pixel size), named `name` for the details that
 * only the model tells apart (the iPhone's notch or island and camera).
 */
export function deviceBodySpec(kind: DeviceKind, aspect: number, name: string): DeviceBodySpec {
  const spec = CHASSIS_SPECS[kind];
  const portraitAspect =
    Number.isFinite(aspect) && aspect > 0
      ? Math.min(aspect, 1 / aspect)
      : spec.pixelW / spec.pixelH;
  const screenHeight = DEVICE_SCREEN_HEIGHT;
  const screenWidth = screenHeight * portraitAspect;
  // The 2D frame's numbers are pixels of its reference screen height.
  const unitsPerPixel = screenHeight / spec.pixelH;
  const bezel = chassisEdge(spec) * unitsPerPixel;
  const screenRadius = spec.screenRadius * unitsPerPixel;
  const common = {
    kind,
    aspect: portraitAspect,
    screenWidth,
    screenHeight,
    screenRadius,
    bezel,
    depth: DEPTH_RATIO[kind] * screenHeight,
    buttonProtrude: Math.max(0.012, spec.nubProtrude * unitsPerPixel * 0.7),
    buttons: sideButtons(kind, unitsPerPixel),
  };
  switch (kind) {
    case "iPhone":
      return {
        ...common,
        cutout: iPhoneCutout(name),
        camera: iPhoneCamera(name, screenWidth + 2 * bezel),
        bezelCamera: false,
        colors: { frame: 0xb9b8b4, back: 0x3b3f46, metalness: 0.92, roughness: 0.3 },
      };
    case "androidPhone":
      return {
        ...common,
        cutout: { kind: "punch-hole", radius: 0.0125, top: 0.026 },
        camera: ANDROID_CAMERA,
        bezelCamera: false,
        colors: { frame: 0x6c7176, back: 0x33403e, metalness: 0.7, roughness: 0.38 },
      };
    case "iPad":
      return {
        ...common,
        cutout: { kind: "none" },
        camera: TABLET_CAMERA,
        bezelCamera: true,
        colors: { frame: 0xa9adb3, back: 0xa9adb3, metalness: 0.78, roughness: 0.4 },
      };
  }
}
