import { memo, useId } from "react";

import { Switch } from "../ui/switch";

function compareHint(props: {
  enabled: boolean;
  count: number;
  minimum: number;
  max: number;
  full: boolean;
}): string {
  if (!props.enabled) return "Shift-click to pick several";
  if (props.full) return `Up to ${props.max} models`;
  if (props.count < props.minimum) {
    return props.minimum > 1 ? "Pick at least two models" : "Pick a model";
  }
  return `${props.count} of ${props.max} · each in its own worktree`;
}

/**
 * The picker's "Compare models" switch: on, every pick adds or removes a
 * model, and a send starts one thread per model, each in its own worktree.
 */
export const ModelPickerCompareBar = memo(function ModelPickerCompareBar(props: {
  enabled: boolean;
  count: number;
  /** How many a send needs (`modelMultiSelectMinimum`). */
  minimum: number;
  max: number;
  /** The last pick was refused because the selection is full. */
  full: boolean;
  onEnabledChange: (enabled: boolean) => void;
}) {
  const labelId = useId();
  return (
    <div
      className="flex items-center gap-2 border-t px-3 py-1.5 text-xs"
      data-slot="model-picker-compare"
    >
      <span id={labelId} className="shrink-0 font-medium">
        Compare models
      </span>
      <span
        className="min-w-0 flex-1 truncate text-muted-foreground"
        aria-live="polite"
        data-slot="model-picker-compare-hint"
      >
        {compareHint(props)}
      </span>
      <Switch
        aria-labelledby={labelId}
        checked={props.enabled}
        onCheckedChange={(checked) => props.onEnabledChange(checked)}
      />
    </div>
  );
});
