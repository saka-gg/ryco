import { ZapIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import type { SpeedTier } from "./modelTuning.logic";

/** Lucide's `zap` bolt, so the doubled glyph matches the single one. */
const BOLT_PATH =
  "M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z";

/** The text colour class a tier is shown in; Standard has none of its own. */
export function speedToneClassName(tier: SpeedTier): string | undefined {
  if (tier === "ultrafast") return "text-(--ultrafast-mode-tone)";
  if (tier === "fast") return "text-(--fast-mode-tone)";
  return undefined;
}

/**
 * A bolt for Fast (and for the Standard state of the speed button), two
 * staggered bolts for Ultrafast. `filled` paints the bolt in its stroke colour.
 */
export function SpeedTierIcon(props: { tier: SpeedTier; filled?: boolean; className?: string }) {
  const className = cn(props.className, props.filled && "fill-current");
  if (props.tier !== "ultrafast") return <ZapIcon aria-hidden="true" className={className} />;
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      data-speed-glyph="ultrafast"
    >
      <path d={BOLT_PATH} transform="translate(-1.6 -0.6) scale(0.7)" />
      <path d={BOLT_PATH} transform="translate(8.6 7.6) scale(0.7)" />
    </svg>
  );
}
