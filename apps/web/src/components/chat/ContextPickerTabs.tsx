import { memo } from "react";

import { cn } from "~/lib/utils";
import { SlidingTabs } from "../ui/sliding-tabs";

export type ContextPickerTab<T extends string = string> = {
  id: T;
  label: string;
  count?: number;
};

function ContextPickerTabStrip<T extends string>(props: {
  tabs: ReadonlyArray<ContextPickerTab<T>>;
  activeId: T;
  onSelect: (id: T) => void;
  /** Tightens the strip for popovers, where the dialog inset is too generous. */
  density?: "default" | "compact";
}) {
  return (
    <SlidingTabs
      tabs={props.tabs}
      activeId={props.activeId}
      onSelect={props.onSelect}
      variant="pill"
      className={cn(
        "border-border border-b",
        props.density === "compact" ? "px-1.5 py-1" : "px-3 py-1.5",
      )}
    />
  );
}

export const ContextPickerTabs = memo(ContextPickerTabStrip) as typeof ContextPickerTabStrip;
