/**
 * Ryco's app icon variants: the R mark on four tiles, picked per device in Settings → Appearance.
 *
 * `light` is the app's own icon (each desktop flavor keeps its own artwork for it). The others are
 * generated from the stable artwork by `scripts/generate-app-icon-variants.py`, which reads the
 * colors below, so this file is the one place they are defined:
 *
 * - desktop: `apps/desktop/resources/app-icons/<asset>-{macos.png,windows.ico,linux.png}`
 * - iPhone: `apps/mobile/assets/app-icons/<asset>.png`, alternate icon sets named by
 *   {@link iosAlternateAppIconName}
 *
 * No runtime dependencies: desktop main, the web app and the phone app all read it.
 */
import type { AppIconVariant } from "@ryco/contracts";

export type { AppIconVariant };

/** The R's ink in the shipped artwork. */
export const APP_ICON_INK = "#141414";
/** The tile of the default icon. */
export const APP_ICON_PAPER = "#ffffff";
/** The website's accent, "ignition" orange (`marketing/src/index.css` `--color-accent`). */
export const APP_ICON_ACCENT = "#ff5c28";

export interface AppIconVariantSpec {
  readonly label: string;
  readonly description: string;
  /** The tile's color. */
  readonly tile: string;
  /** The R's color. */
  readonly mark: string;
  /** File stem of the generated icons; null for the app's own icon. */
  readonly asset: string | null;
}

export const APP_ICON_VARIANTS = [
  "light",
  "dark",
  "ember",
  "ignition",
] as const satisfies ReadonlyArray<AppIconVariant>;

export const DEFAULT_APP_ICON_VARIANT: AppIconVariant = "light";

export const APP_ICON_VARIANT_SPECS: Readonly<Record<AppIconVariant, AppIconVariantSpec>> = {
  light: {
    label: "Light",
    description: "Black R on white",
    tile: APP_ICON_PAPER,
    mark: APP_ICON_INK,
    asset: null,
  },
  dark: {
    label: "Dark",
    description: "White R on black",
    tile: APP_ICON_INK,
    mark: APP_ICON_PAPER,
    asset: "dark",
  },
  ember: {
    label: "Ember",
    description: "Orange R on black",
    tile: APP_ICON_INK,
    mark: APP_ICON_ACCENT,
    asset: "ember",
  },
  ignition: {
    label: "Ignition",
    description: "Black R on orange",
    tile: APP_ICON_ACCENT,
    mark: APP_ICON_INK,
    asset: "ignition",
  },
};

export function isAppIconVariant(value: unknown): value is AppIconVariant {
  return (APP_ICON_VARIANTS as ReadonlyArray<unknown>).includes(value);
}

/** The variant a stored value names, or the default for anything else. */
export function normalizeAppIconVariant(value: unknown): AppIconVariant {
  return isAppIconVariant(value) ? value : DEFAULT_APP_ICON_VARIANT;
}

/** The iOS alternate icon set for a variant (`UIApplication.setAlternateIconName`); null for the primary icon. */
export function iosAlternateAppIconName(variant: AppIconVariant): string | null {
  const asset = APP_ICON_VARIANT_SPECS[variant].asset;
  return asset === null ? null : `AppIcon-${asset}`;
}

/** The variant iOS reports as current; an unknown name (a newer build's) reads as the default. */
export function appIconVariantFromIosName(name: string | null | undefined): AppIconVariant {
  if (!name) return DEFAULT_APP_ICON_VARIANT;
  return (
    APP_ICON_VARIANTS.find((variant) => iosAlternateAppIconName(variant) === name) ??
    DEFAULT_APP_ICON_VARIANT
  );
}

/**
 * The R as drawn in the 1024-point icon grid, fitted to the shipped artwork, so previews can
 * draw a variant at any size without shipping its pictures. The tile spans
 * {@link APP_ICON_PREVIEW_TILE} in the same grid.
 */
export const APP_ICON_MARK_PATH =
  "M468.9 307.2C413.1 311.9 370 340.6 345.8 388.9C340.6 399.2 335 416 332.7 428.8L330.8 439L330.3 576.6L330 714.3L332 716.3L336.1 712.6C338.5 710.6 355.3 695.6 373.7 679.3L407.2 649.6L407.5 547.6L407.8 445.4L410.6 437.1C419.7 410.7 438.8 392.1 465.4 384L471.1 382.3L530 381.8C562.5 381.6 591.5 381.7 594.5 382.1L600 382.8L611.4 389.7L614.4 394.5C616 397.2 617.8 401.7 618.4 404.7L619.3 409.9L618.4 416.5C617.8 420 615.9 426 614.1 429.7L610.8 436.5L604 443.4L597.4 450.1L589.6 453.9L581.8 457.6L575.8 458.3C541.1 462.2 519.7 472 496.9 494.6C485.2 506.1 481.8 510.7 454.6 550.8L433.9 581.2L434.5 583.5C434.8 584.8 437.4 588.2 440.3 591.2C443.1 594.1 448 599.7 451.2 603.5C456.5 609.7 469.1 624.3 504.8 665.2C511.1 672.1 521.8 684.5 528.9 692.5C535.8 700.4 543.6 709.2 546.3 712L551 717.1L648.5 717.1L648.5 715.8C648.5 715.1 643.8 708.9 638 702C626.3 688.1 625.8 687.5 573.3 625.6C529.4 573.6 528.4 572.4 528.4 571C528.4 568.7 538.4 556.2 545.9 549.3L553.8 541.9L569.7 533.9L576.7 532.8C580.5 532.1 588.2 530.7 593.8 529.5C639.7 520.9 679.9 481 690.5 433.8L692.8 424L692.7 408.9L692.7 393.9L690 383.8C684.7 363.7 676.5 349.5 661.6 335.3C646.9 321.4 633.4 314.1 613.7 309.5L604 307.3L538.6 307.1C502.7 307 471.3 307 468.9 307.2Z";

/** The tile in the 1024-point grid: macOS's 824-point icon body, its corners about 22.5% round. */
export const APP_ICON_PREVIEW_TILE = { x: 100, y: 100, size: 824, radius: 185 } as const;
