import { memo } from "react";

import { cn } from "~/lib/utils";
import { SlidingTabs } from "../ui/sliding-tabs";

export type ContextPickerTab = {
  id: string;
  label: string;
  count?: number;
};

export const ContextPickerTabs = memo(function ContextPickerTabs(props: {
  tabs: ReadonlyArray<ContextPickerTab>;
  activeId: string;
  onSelect: (id: string) => void;
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
});
