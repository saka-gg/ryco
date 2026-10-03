import type { ContextHandoffEndpointSnapshot } from "@ryco/contracts";
import { ArrowLeftRightIcon, ArrowRightIcon } from "lucide-react";
import { memo } from "react";

import {
  ContextHandoffEndpointLabel,
  contextHandoffEndpointAccessibleLabel,
} from "./ContextHandoffEndpointLabel";

export const PendingContextHandoffChip = memo(function PendingContextHandoffChip(props: {
  source: ContextHandoffEndpointSnapshot;
  target: ContextHandoffEndpointSnapshot;
}) {
  const accessibleLabel = `Next message will hand off context from ${contextHandoffEndpointAccessibleLabel(props.source)} to ${contextHandoffEndpointAccessibleLabel(props.target)}`;

  return (
    <div
      role="status"
      aria-label={accessibleLabel}
      title={accessibleLabel}
      data-pending-context-handoff="true"
      data-pending-context-handoff-source={props.source.providerInstanceId}
      data-pending-context-handoff-target={props.target.providerInstanceId}
      className="selection-glass-surface inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] leading-4 text-muted-foreground shadow-sm"
    >
      <ArrowLeftRightIcon className="size-3.5 shrink-0" aria-hidden />
      <span className="shrink-0 font-medium">Next message hands off context</span>
      <span className="text-muted-foreground/45" aria-hidden>
        ·
      </span>
      <ContextHandoffEndpointLabel endpoint={props.source} className="max-w-32 sm:max-w-44" />
      <ArrowRightIcon className="size-3.5 shrink-0 text-muted-foreground/55" aria-hidden />
      <ContextHandoffEndpointLabel
        endpoint={props.target}
        className="max-w-32 font-medium text-foreground/85 sm:max-w-44"
      />
    </div>
  );
});
