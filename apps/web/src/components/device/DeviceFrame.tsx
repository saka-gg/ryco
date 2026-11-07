// Adapted from Emanuele-web04/synara commit dd88d927 (MIT); see THIRD_PARTY_NOTICES.md.
// FILE: DeviceFrame.tsx
// Purpose: SVG chassis for the simulator preview, with working hardware buttons.
// Layer: Device pane presentation primitive
// Exports: DeviceScreen, DeviceFrame, DeviceSilhouette, deviceKindFor, screenGeometry
// Depends on: device contracts for the button names.
//
// Drawn rather than composited from Apple's bezel artwork: those images are
// licensed for marketing use, must be used unmodified, and explicitly may not
// be turned into buttons — which is exactly what the side nubs below are — and
// a fixed image is one device, while this pane frames anything from an iPhone
// to a 13" iPad. The frame is an SVG of concentric squircle bands sized from
// the device's own pixel dimensions, so one drawing fits every aspect.
//
// The chassis contains the live canvas and its empty or connecting state.

import type { DeviceFamily, DeviceHardwareButton } from "@ryco/contracts";
import { memo, useId, useMemo, type CSSProperties, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  CHASSIS_SPECS,
  chassisEdge,
  squirclePath,
  type ChassisNub,
  type DeviceKind,
} from "./deviceChassis";

export type { DeviceKind } from "./deviceChassis";

type Nub = ChassisNub;
const DEVICE_SPECS = CHASSIS_SPECS;

const SHADOW: CSSProperties = {
  filter: "drop-shadow(0 2px 6px rgb(0 0 0 / 0.2)) drop-shadow(0 12px 32px rgb(0 0 0 / 0.25))",
};

/** Screen pixels per device point, per kind. */
export const RESOLUTION_SCALE: Record<DeviceKind, number> = {
  iPhone: 3,
  androidPhone: 1,
  iPad: 2,
};

/**
 * Which chassis to draw a device in.
 *
 * `family` comes from the simulator's device type profile and is authoritative
 * wherever it exists. The name is the fallback for a backend that could not
 * read the profile, and it only holds for as long as every Apple tablet has
 * "iPad" in its name.
 */
export function deviceKindFor(device: {
  platform: string;
  name: string;
  family?: DeviceFamily | undefined;
}): DeviceKind {
  if (device.platform.startsWith("android")) return "androidPhone";
  if (device.family) return device.family === "tablet" ? "iPad" : "iPhone";
  return device.name.toLowerCase().includes("ipad") ? "iPad" : "iPhone";
}

function metrics(kind: DeviceKind, pixelW?: number, pixelH?: number) {
  const spec = DEVICE_SPECS[kind];
  const rawW = pixelW ?? spec.pixelW;
  const rawH = pixelH ?? spec.pixelH;
  // Ryco can receive low-resolution preview geometry. Keep the physical bands
  // and button positions at Synara's reference scale without changing input.
  const drawingScale = Math.max(1, spec.pixelW / rawW, spec.pixelH / rawH);
  const screenW = rawW * drawingScale;
  const screenH = rawH * drawingScale;
  const edge = chassisEdge(spec);
  const margin = edge + spec.nubProtrude;
  return {
    spec,
    edge,
    margin,
    screenW,
    screenH,
    W: screenW + 2 * margin,
    H: screenH + 2 * margin,
  };
}

/**
 * Where the live screen sits inside the frame box. Percentages, so the caller
 * can size the box however it likes and the screen follows.
 */
export function screenGeometry(kind: DeviceKind = "iPhone", pixelW?: number, pixelH?: number) {
  const { spec, margin, screenW, screenH, W, H } = metrics(kind, pixelW, pixelH);
  return {
    aspect: W / H,
    insetXPct: (100 * margin) / W,
    insetYPct: (100 * margin) / H,
    // Percentage radii on both axes, so the corners stay circular under any aspect.
    screenBorderRadius: `${(100 * spec.screenRadius) / screenW}% / ${(100 * spec.screenRadius) / screenH}%`,
  };
}

function framePaths(kind: DeviceKind, pixelW?: number, pixelH?: number) {
  const { spec, edge, W, H } = metrics(kind, pixelW, pixelH);

  const bandAt = (inset: number) =>
    squirclePath(
      spec.nubProtrude + inset,
      spec.nubProtrude + inset,
      W - 2 * (spec.nubProtrude + inset),
      H - 2 * (spec.nubProtrude + inset),
      spec.screenRadius + (edge - inset),
    );

  const p = spec.nubProtrude;
  const nub = (side: Nub["side"], at: number, len: number) => {
    const capTop = at + 6;
    const capBottom = at + len - 6;
    switch (side) {
      case "left":
        return {
          fill: `M0 ${at}h${p}v${len}H0z`,
          edge: `M${p} ${at}H6Q0 ${at} 0 ${capTop}V${capBottom}Q0 ${at + len} 6 ${at + len}H${p}`,
        };
      case "right":
        return {
          fill: `M${W - p} ${at}H${W}v${len}H${W - p}z`,
          edge: `M${W - p} ${at}H${W - 6}Q${W} ${at} ${W} ${capTop}V${capBottom}Q${W} ${at + len} ${W - 6} ${at + len}H${W - p}`,
        };
      case "top": {
        // A negative `at` is measured from the right edge.
        const x = at >= 0 ? at : W + at - len;
        return {
          fill: `M${x} 0v${p}h${len}V0z`,
          edge: `M${x} ${p}V6Q${x} 0 ${x + 6} 0H${x + len - 6}Q${x + len} 0 ${x + len} 6V${p}`,
        };
      }
    }
  };

  const nubs = spec.nubs.map(({ side, at, len }) => nub(side, at, len));

  return {
    W,
    H,
    outer: bandAt(0),
    grey: bandAt(spec.silver),
    black: bandAt(spec.silver + spec.grey),
    cutout: bandAt(edge),
    nubFill: nubs.map((shape) => shape.fill).join(""),
    nubEdge: nubs.map((shape) => shape.edge).join(""),
  };
}

type LayerProps = {
  kind?: DeviceKind;
  pixelWidth?: number | undefined;
  pixelHeight?: number | undefined;
  className?: string;
  style?: CSSProperties;
};

export const DeviceFrame = memo(function DeviceFrame({
  kind = "iPhone",
  pixelWidth,
  pixelHeight,
  className,
  style,
}: LayerProps) {
  const gradientId = useId();
  const { W, H, outer, grey, black, cutout, nubFill, nubEdge } = useMemo(
    () => framePaths(kind, pixelWidth, pixelHeight),
    [kind, pixelWidth, pixelHeight],
  );

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className={className}
      style={style}
      aria-hidden
      focusable={false}
    >
      <defs>
        {/* The tight 45/55 stop pair is the specular line down the band. */}
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#e8e8ec" />
          <stop offset="45%" stopColor="#bcbcc0" />
          <stop offset="55%" stopColor="#b4b4b8" />
          <stop offset="100%" stopColor="#e2e2e6" />
        </linearGradient>
      </defs>
      <path d={`${outer} ${cutout}`} fill={`url(#${gradientId})`} fillRule="evenodd" />
      <path d={`${grey} ${cutout}`} fill="#4a4a4e" fillRule="evenodd" />
      <path d={`${black} ${cutout}`} fill="#000" fillRule="evenodd" />
      <path d={cutout} fill="none" stroke="#2a2a2c" strokeWidth={3} />
      <path
        d={outer}
        fill="none"
        stroke="#000"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
      />
      <path d={nubFill} fill="#4a4a4e" />
      <path
        d={nubEdge}
        fill="none"
        stroke="#000"
        strokeWidth={1.5}
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
});

/** Solid black body behind the screen. Carries the drop shadow. */
export const DeviceSilhouette = memo(function DeviceSilhouette({
  kind = "iPhone",
  pixelWidth,
  pixelHeight,
  className,
  style,
}: LayerProps) {
  const { W, H, outer, nubFill } = useMemo(
    () => framePaths(kind, pixelWidth, pixelHeight),
    [kind, pixelWidth, pixelHeight],
  );
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className={className}
      style={style}
      aria-hidden
      focusable={false}
    >
      <path d={`${outer} ${nubFill}`} fill="#000" />
    </svg>
  );
});

/**
 * Every nub the frame draws, and what pressing it does.
 *
 * `button` is what the press sends. Nubs without a mapped action remain
 * decorative rather than offering a control that cannot be injected.
 *
 * Apple puts volume up and down on two separate buttons. Android draws a
 * single volume rocker; it remains decorative because one hit area cannot
 * distinguish volume up from volume down.
 */
export const NUB_ACTIONS: Record<
  string,
  { readonly label: string; readonly button?: DeviceHardwareButton; readonly hint?: string }
> = {
  volumeUp: { label: "Volume up", button: "volume-up" },
  volumeDown: { label: "Volume down", button: "volume-down" },
  power: { label: "Lock", button: "lock" },
};

/** Direction a pressed nub travels: always into the chassis. */
const NUB_PRESS_IN: Record<Nub["side"], string> = {
  left: "active:translate-x-[1.5px]",
  right: "active:-translate-x-[1.5px]",
  top: "active:translate-y-[1.5px]",
};

/**
 * Hit rectangles for the drawn nubs, as percentages of the frame box. The SVG
 * already draws the hardware; these are the invisible controls laid over it,
 * deep enough (the full chassis margin) that a few pixels of protruding metal
 * are not the only thing to click.
 */
function nubHitRects(kind: DeviceKind, pixelW?: number, pixelH?: number) {
  const { spec, margin, W, H } = metrics(kind, pixelW, pixelH);
  return spec.nubs.map(({ side, at, len, name }) => {
    const depth = { x: (100 * margin) / W, y: (100 * margin) / H };
    const style: CSSProperties =
      side === "top"
        ? {
            top: 0,
            height: `${depth.y}%`,
            left: `${(100 * (at >= 0 ? at : W + at - len)) / W}%`,
            width: `${(100 * len) / W}%`,
          }
        : {
            [side]: 0,
            width: `${depth.x}%`,
            top: `${(100 * at) / H}%`,
            height: `${(100 * len) / H}%`,
          };
    return { name, side, style };
  });
}

export const DeviceScreen = memo(function DeviceScreen({
  children,
  kind = "iPhone",
  pixelWidth,
  pixelHeight,
  className,
  buttonsDisabled,
  rotationDegrees = 0,
  onPressButton,
}: {
  children: ReactNode;
  kind?: DeviceKind;
  pixelWidth?: number | undefined;
  pixelHeight?: number | undefined;
  className?: string;
  buttonsDisabled?: boolean;
  /**
   * Turn the whole device, clockwise in degrees (a multiple of 90). The guest
   * keeps drawing into its portrait framebuffer with the interface turned
   * inside it, so this rotates the assembled device, screen and buttons
   * together, as a person turning a phone would, rather than re-deriving a
   * landscape chassis.
   */
  rotationDegrees?: number;
  onPressButton?: ((button: DeviceHardwareButton) => void) | undefined;
}) {
  const geo = useMemo(
    () => screenGeometry(kind, pixelWidth, pixelHeight),
    [kind, pixelWidth, pixelHeight],
  );
  const nubs = useMemo(
    () => nubHitRects(kind, pixelWidth, pixelHeight),
    [kind, pixelWidth, pixelHeight],
  );
  const landscape = Math.abs(rotationDegrees % 180) === 90;
  const screenStyle = useMemo<CSSProperties>(
    () => ({
      left: `${geo.insetXPct}%`,
      top: `${geo.insetYPct}%`,
      width: `${100 - 2 * geo.insetXPct}%`,
      height: `${100 - 2 * geo.insetYPct}%`,
      borderRadius: geo.screenBorderRadius,
    }),
    [geo],
  );

  return (
    <div
      data-device-kind={kind}
      className={cn(
        // No overflow clip: the chassis shadow reaches ~32px past the device,
        // and clipping it left a hard horizontal cut where the control rail
        // began. Padding keeps the device off the pane edges, and the sizing
        // below already stops the frame itself from escaping the box.
        "flex h-full min-h-0 items-center justify-center p-6 [container-type:size]",
        className,
      )}
    >
      <div
        data-device-rotation={rotationDegrees}
        className="relative transition-transform duration-300 ease-out motion-reduce:transition-none"
        style={{
          // Turned, the device's height runs across the pane, so the fit is
          // measured against the transposed axis; without this the rotated
          // device shrinks to whatever its untumbled height allowed.
          height: landscape
            ? `min(100cqw, calc(100cqh / ${geo.aspect}))`
            : `min(100cqh, calc(100cqw / ${geo.aspect}))`,
          aspectRatio: geo.aspect,
          transform: `rotate(${rotationDegrees}deg)`,
        }}
      >
        <DeviceSilhouette
          kind={kind}
          pixelWidth={pixelWidth}
          pixelHeight={pixelHeight}
          className="pointer-events-none absolute inset-0 h-full w-full select-none"
          style={SHADOW}
        />
        <div className="absolute overflow-hidden bg-black" style={screenStyle}>
          {children}
        </div>
        <DeviceFrame
          kind={kind}
          pixelWidth={pixelWidth}
          pixelHeight={pixelHeight}
          className="pointer-events-none absolute inset-0 h-full w-full select-none"
        />
        {/*
          The frame draws the hardware; this lays the controls over it.
          Simulator.app's side buttons are clickable and so are the ones backed
          by a real press, which is why each carries an accessible name and a
          focus ring even though its face is the SVG's. A nub with no button is
          rendered as a plain hover target instead: it explains itself rather
          than inviting a click that the backend would only refuse.
        */}
        {nubs.map(({ name, side, style }) => {
          const action = NUB_ACTIONS[name];
          if (!action) return null;
          const press = action.button;
          const interactive = press !== undefined && onPressButton !== undefined;
          if (!interactive && !action.hint) return null;
          return (
            <Tooltip key={name}>
              <TooltipTrigger
                render={
                  interactive ? (
                    <button
                      type="button"
                      aria-label={action.label}
                      disabled={buttonsDisabled}
                      onClick={() => onPressButton?.(press)}
                      className={cn(
                        "absolute cursor-pointer rounded-full outline-none",
                        "transition-transform duration-220 motion-reduce:transition-none",
                        NUB_PRESS_IN[side],
                        "focus-visible:ring-2 focus-visible:ring-ring/80",
                        "disabled:pointer-events-none",
                      )}
                      style={style}
                    />
                  ) : (
                    // Not a button: it has nothing to activate, so it takes no
                    // tab stop and offers no press affordance — only the
                    // tooltip that says why.
                    <span
                      aria-label={action.label}
                      className="absolute cursor-default rounded-full"
                      style={style}
                    />
                  )
                }
              />
              <TooltipPopup side={side === "top" ? "top" : side}>
                {action.hint ? `${action.label} — ${action.hint}` : action.label}
              </TooltipPopup>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
});
