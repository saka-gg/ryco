// FILE: ForkOriginMarkerRow.tsx
// Purpose: The divider a forked thread shows between its inherited history and
//          its own: where it came from (a link back to the source reply), how
//          its provider continues, and which files it works on.
// Layer: Web UI, desktop and tablet only. The frozen phone tier never renders
//        it (`MessagesTimeline` drops the row there). Copy is shared with the
//        native app through `@ryco/client-runtime/state/session`.

import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  FORK_ORIGIN_COPY,
  forkOriginCheckoutLine,
  forkOriginHeadline,
  forkOriginProviderLine,
  type ForkOriginTimelineEntry,
} from "@ryco/client-runtime/state/session";
import type { EnvironmentId } from "@ryco/contracts";
import { useRouter } from "@tanstack/react-router";
import { GitForkIcon } from "lucide-react";
import { memo, useMemo } from "react";

import { selectThreadAvailabilityByRef, useStore, type AppState } from "../../store";
import { buildThreadRouteParams } from "../../threadRoutes";

export const ForkOriginMarkerRow = memo(function ForkOriginMarkerRow(props: {
  readonly marker: ForkOriginTimelineEntry;
  readonly environmentId: EnvironmentId;
}) {
  const { marker, environmentId } = props;
  const sourceRef = useMemo(
    () => scopeThreadRef(environmentId, marker.sourceThreadId),
    [environmentId, marker.sourceThreadId],
  );
  // Unknown until the machine's shell snapshot arrives: never call a source
  // missing just because this client has not heard of it yet (shared rule).
  const source = useStore(
    useMemo(
      () => (state: AppState) => selectThreadAvailabilityByRef(state, sourceRef),
      [sourceRef],
    ),
  );
  const router = useRouter({ warn: false });
  const openSource = () => {
    if (!router) return;
    // The deep link loads the source's history around the reply and highlights it.
    void router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(sourceRef),
      search: { messageId: marker.sourceMessageId },
    });
  };
  const title = `“${marker.sourceTitle}”`;
  const details = [
    ...(source === "missing" ? [FORK_ORIGIN_COPY.sourceUnavailable] : []),
    forkOriginProviderLine(marker),
    forkOriginCheckoutLine(marker),
    ...marker.notices,
  ];

  return (
    <div
      role="group"
      aria-label={forkOriginHeadline(marker)}
      className="flex w-full min-w-0 max-w-full flex-col gap-1 overflow-hidden py-2"
      data-fork-origin-id={marker.activityId}
      data-fork-origin-provider-context={marker.providerContext}
      data-fork-origin-checkout={marker.checkout.kind}
      data-fork-origin-source={source}
    >
      <div className="flex w-full min-w-0 items-center gap-2 sm:gap-3">
        <span className="h-px min-w-2 flex-1 bg-border/60" aria-hidden />
        <span className="inline-flex min-w-0 max-w-[calc(100%_-_2.5rem)] items-center gap-1.5 text-[11px] leading-4 text-muted-foreground/75">
          <GitForkIcon className="size-3.5 shrink-0" aria-hidden />
          <span className="shrink-0 font-medium">{FORK_ORIGIN_COPY.forkedFrom}</span>
          {source === "available" && router ? (
            <button
              type="button"
              onClick={openSource}
              aria-label={`Open ${title} at the reply this fork starts from`}
              className="min-w-0 truncate rounded-sm font-medium text-foreground/80 underline decoration-border underline-offset-2 outline-none transition-colors hover:text-foreground hover:decoration-foreground/40 focus-visible:ring-1 focus-visible:ring-ring/60"
              data-fork-origin-source-link
            >
              {title}
            </button>
          ) : (
            <span className="min-w-0 truncate font-medium">{title}</span>
          )}
        </span>
        <span className="h-px min-w-2 flex-1 bg-border/60" aria-hidden />
      </div>
      <div className="mx-auto flex max-w-xl flex-col gap-0.5 px-2 text-center text-[11px] leading-4 text-muted-foreground/60">
        {details.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
    </div>
  );
});
