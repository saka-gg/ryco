import { memo } from "react";
import {
  ArrowLeftRightIcon,
  ArrowRightIcon,
  CircleAlertIcon,
  CircleHelpIcon,
  FolderInputIcon,
} from "lucide-react";
import {
  contextHandoffStatusSuffix,
  CWD_RELOCATION_HANDOFF_COPY,
  cwdRelocationHandoffAccessibleLabel,
  cwdRelocationHandoffHeadline,
  cwdRelocationHandoffRetryHint,
  isCwdRelocationHandoff,
  type ContextHandoffTimelineEntry,
} from "../../session-logic";

import {
  ContextHandoffEndpointLabel,
  contextHandoffEndpointAccessibleLabel,
} from "./ContextHandoffEndpointLabel";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Everything the divider says in words, for both kinds of handoff. */
export interface ContextHandoffMarkerPresentation {
  /** Screen-reader label of the whole divider. */
  readonly accessibleLabel: string;
  /** First line of the hover card. */
  readonly tooltipTitle: string;
  /** Why the handoff happened, when that is not obvious from the divider. */
  readonly tooltipDetail: string | null;
  /** What to do after a failure, when the user can act on it. */
  readonly retryHint: string | null;
}

/**
 * A model change reads as `<source> → <target>`. A working-directory relocation
 * keeps its model, so it reads as a fresh session in the new folder instead;
 * a failed one says how to try again. Handoffs recorded before they carried a
 * reason are model changes.
 */
export function describeContextHandoffMarker(
  marker: ContextHandoffTimelineEntry,
): ContextHandoffMarkerPresentation {
  if (isCwdRelocationHandoff(marker)) {
    return {
      accessibleLabel: cwdRelocationHandoffAccessibleLabel(marker),
      tooltipTitle:
        marker.status === "consumed"
          ? "Sent to a fresh session"
          : marker.status === "failed"
            ? "Couldn't continue in the new folder"
            : "Delivery uncertain",
      tooltipDetail: CWD_RELOCATION_HANDOFF_COPY.explanation,
      retryHint: cwdRelocationHandoffRetryHint(marker),
    };
  }
  const transition = `Context handoff from ${marker.sources
    .map(contextHandoffEndpointAccessibleLabel)
    .join(", ")} to ${contextHandoffEndpointAccessibleLabel(marker.target)}`;
  return {
    accessibleLabel: `${transition}. ${contextHandoffStatusSuffix(marker) ?? "Completed"}`,
    tooltipTitle:
      marker.status === "consumed"
        ? "Sent to model"
        : marker.status === "failed"
          ? "Context handoff failed"
          : "Delivery uncertain",
    tooltipDetail: null,
    retryHint: null,
  };
}

function ModelTransition({
  marker,
  emphasized,
}: {
  readonly marker: ContextHandoffTimelineEntry;
  readonly emphasized: boolean;
}) {
  return (
    <>
      <ArrowLeftRightIcon className="size-3.5 shrink-0" />
      <span className="shrink-0 font-medium">Context handoff</span>
      <span className="inline-flex min-w-0 max-w-full flex-wrap items-center justify-center gap-x-1.5 gap-y-1">
        {marker.sources.map((source, index) => (
          <span
            key={`${source.providerInstanceId}:${source.modelSlug}`}
            className="inline-flex min-w-0 items-center gap-1.5"
          >
            {index > 0 ? <span className="text-muted-foreground/45">,</span> : null}
            <ContextHandoffEndpointLabel endpoint={source} className="max-w-40 sm:max-w-56" />
          </span>
        ))}
      </span>
      <ArrowRightIcon className="size-3.5 shrink-0 text-muted-foreground/55" />
      <span className={cn("font-medium", emphasized && "text-foreground/85")}>
        <ContextHandoffEndpointLabel endpoint={marker.target} className="max-w-40 sm:max-w-56" />
      </span>
    </>
  );
}

function MarkerContents({
  marker,
  presentation,
  failed,
  uncertain,
}: {
  readonly marker: ContextHandoffTimelineEntry;
  readonly presentation: ContextHandoffMarkerPresentation;
  readonly failed: boolean;
  readonly uncertain: boolean;
}) {
  const relocation = isCwdRelocationHandoff(marker);
  return (
    <>
      <span
        className={cn(
          "h-px min-w-2 flex-1",
          failed ? "bg-destructive/35" : uncertain ? "bg-warning/40" : "bg-border/60",
        )}
        aria-hidden
      />
      <span
        className={cn(
          "flex min-w-0 max-w-[calc(100%_-_2.5rem)] flex-wrap items-center justify-center gap-x-1.5 gap-y-1 text-[11px] leading-4",
          failed
            ? "text-destructive"
            : uncertain
              ? "text-warning-foreground"
              : "text-muted-foreground/75",
        )}
        aria-hidden
      >
        {relocation ? (
          <>
            <FolderInputIcon className="size-3.5 shrink-0" />
            <span className="min-w-0 font-medium" data-context-handoff-headline>
              {cwdRelocationHandoffHeadline(marker.status)}
            </span>
          </>
        ) : (
          <ModelTransition marker={marker} emphasized={!failed && !uncertain} />
        )}
        {failed ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium">
            <CircleAlertIcon className="size-3" />
            Failed
          </span>
        ) : uncertain ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium">
            <CircleHelpIcon className="size-3" />
            Delivery uncertain
          </span>
        ) : null}
        {presentation.retryHint ? (
          <span className="min-w-0 text-muted-foreground" data-context-handoff-retry-hint>
            {presentation.retryHint}
          </span>
        ) : null}
      </span>
      <span
        className={cn(
          "h-px min-w-2 flex-1",
          failed ? "bg-destructive/35" : uncertain ? "bg-warning/40" : "bg-border/60",
        )}
        aria-hidden
      />
    </>
  );
}

export const ContextHandoffMarkerRow = memo(function ContextHandoffMarkerRow({
  marker,
  onInspect,
}: {
  marker: ContextHandoffTimelineEntry;
  onInspect?: (marker: ContextHandoffTimelineEntry, trigger: HTMLButtonElement) => void;
}) {
  const presentation = describeContextHandoffMarker(marker);
  const { accessibleLabel } = presentation;
  const failed = marker.status === "failed";
  const uncertain = marker.status === "delivery-uncertain";
  const reason = marker.reason ?? "model-change";

  if (!onInspect) {
    return (
      <div
        role="status"
        aria-label={accessibleLabel}
        title={accessibleLabel}
        className="flex w-full min-w-0 max-w-full items-center gap-2 overflow-hidden py-2 sm:gap-3"
        data-context-handoff-id={marker.handoffId}
        data-context-handoff-status={marker.status}
        data-context-handoff-reason={reason}
        data-context-handoff-source-count={marker.sources.length}
      >
        <MarkerContents
          marker={marker}
          presentation={presentation}
          failed={failed}
          uncertain={uncertain}
        />
      </div>
    );
  }

  const trigger = (
    <button
      type="button"
      aria-label={accessibleLabel}
      onClick={(event) => onInspect(marker, event.currentTarget)}
      className="group flex w-full min-w-0 max-w-full cursor-pointer items-center gap-2 overflow-hidden rounded-md py-2 outline-none transition-colors hover:bg-foreground/3 focus-visible:ring-1 focus-visible:ring-ring/60 sm:gap-3"
      data-context-handoff-id={marker.handoffId}
      data-context-handoff-status={marker.status}
      data-context-handoff-reason={reason}
      data-context-handoff-source-count={marker.sources.length}
    >
      <MarkerContents
        marker={marker}
        presentation={presentation}
        failed={failed}
        uncertain={uncertain}
      />
    </button>
  );

  return (
    <Tooltip>
      <TooltipTrigger render={trigger} />
      <TooltipPopup className="max-w-80 px-2 py-1.5" side="top">
        <div className="space-y-1 text-left">
          <p className="font-medium text-foreground">{presentation.tooltipTitle}</p>
          {presentation.tooltipDetail ? <p>{presentation.tooltipDetail}</p> : null}
          {presentation.retryHint ? (
            <p className="text-foreground">{presentation.retryHint}</p>
          ) : null}
          <p>{new Date(marker.createdAt).toLocaleString()}</p>
          {marker.inspection ? (
            <p>
              {marker.inspection.includedEntryCount ?? marker.inspection.completeEntryCount} of{" "}
              {marker.inspection.completeEntryCount} context entries
              {marker.inspection.truncated ? " · trimmed to fit" : ""}
            </p>
          ) : (
            <p>Open to inspect the available context artifact.</p>
          )}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
});
