import { memo } from "react";

import { cn } from "~/lib/utils";
import { reasoningTone, type ModelTuningSummary } from "./modelTuning.logic";
import { RollingText, useTravelDirection } from "./RollingText";
import { SpeedTierIcon, speedToneClassName } from "./SpeedTierIcon";

/**
 * The tuning readout inside the composer's model pill: effort in its tone, a
 * bolt while Fast is on (two for Ultrafast), and the context window when the model lets you
 * pick one. Each part rolls in the direction it changed.
 */
export const ModelTriggerTraits = memo(function ModelTriggerTraits(props: {
  summary: ModelTuningSummary;
  /** Narrow footers drop the context tag; the picker still shows it. */
  compact?: boolean;
}) {
  const { level, speed, contextWindowLabel } = props.summary;
  const tone = reasoningTone(level?.id);
  const levelDirection = useTravelDirection(level?.index ?? -1);
  const contextDirection = useTravelDirection(contextWindowRank(contextWindowLabel));
  const showContext = !props.compact && contextWindowLabel !== null;
  if (!level && speed === "standard" && !showContext) return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5" data-slot="model-trigger-traits">
      {level ? (
        <span
          data-reasoning-tone={tone}
          className="font-medium text-(--reasoning-tone-text) transition-colors"
        >
          <RollingText
            text={level.label}
            direction={levelDirection}
            {...(tone === "ultracode" ? { itemClassName: "reasoning-tone-shimmer" } : {})}
          />
        </span>
      ) : null}
      {speed !== "standard" ? (
        <SpeedTierIcon
          key={speed}
          tier={speed}
          filled
          className={cn("model-trigger-pop size-3 shrink-0", speedToneClassName(speed))}
        />
      ) : null}
      {showContext ? (
        <span className="model-trigger-pop rounded-[4px] px-1 py-px font-medium text-[10px] text-muted-foreground tabular-nums leading-tight ring-1 ring-border ring-inset">
          <RollingText text={contextWindowLabel} direction={contextDirection} />
        </span>
      ) : null}
    </span>
  );
});

/** Orders context labels by size ("200k" < "1M") so the tag rolls the right way. */
function contextWindowRank(label: string | null): number {
  if (!label) return -1;
  const match = /^(\d+(?:\.\d+)?)\s*([km])?/i.exec(label);
  if (!match) return 0;
  const unit = match[2]?.toLowerCase();
  return Number(match[1]) * (unit === "m" ? 1_000_000 : unit === "k" ? 1_000 : 1);
}
