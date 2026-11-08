import type { SourceControlLabel } from "@ryco/contracts";
import { memo, useMemo } from "react";
import { labelChipColors } from "@ryco/shared/sourceControlLabelColors";
import { cn } from "~/lib/utils";

export const LabelChip = memo(function LabelChip(props: {
  label: SourceControlLabel | string;
  className?: string;
}) {
  const label: SourceControlLabel =
    typeof props.label === "string" ? { name: props.label } : props.label;

  const style = useMemo(() => labelChipColors(label.color), [label.color]);

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-1.5 py-0.5 font-medium text-[10px]",
        style === null ? "border-border/60 bg-muted/40 text-muted-foreground" : null,
        props.className,
      )}
      style={style ?? undefined}
      title={label.description ?? label.name}
    >
      {label.name}
    </span>
  );
});
