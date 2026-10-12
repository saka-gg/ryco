import {
  FORK_ORIGIN_COPY,
  forkOriginAccessibleLabel,
  forkOriginCheckoutLine,
  forkOriginHeadline,
  forkOriginProviderLine,
  type ForkOriginTimelineEntry,
} from "@ryco/client-runtime/state/session";
import type { ThreadAvailability } from "@ryco/client-runtime/state/threads";
import type { MessageId, ThreadId } from "@ryco/contracts";

/** The fork-origin divider as the native timeline shows it; every line is shared copy. */
export interface ForkOriginRowModel {
  readonly headline: string;
  /** The source to open from the headline; null unless it is on this node. */
  readonly sourceThreadId: ThreadId | null;
  /** The reply the fork ends at: the source opens scrolled to it. Null without a link. */
  readonly sourceMessageId: MessageId | null;
  /** Shown under the headline instead of a link once the source is known to be gone. */
  readonly sourceUnavailable: string | null;
  readonly providerLine: string;
  readonly checkoutLine: string;
  readonly notices: ReadonlyArray<string>;
  readonly accessibilityLabel: string;
}

/**
 * The headline keeps the title recorded at fork time in every state, so a deleted source still
 * reads as where the fork came from. Only a source known to be missing says it is gone; while
 * availability is unknown the divider is plain text with no claim either way.
 */
export function buildForkOriginRowModel(input: {
  readonly marker: ForkOriginTimelineEntry;
  /** Whether the source is on the node (`selectThreadAvailabilityByRef`). */
  readonly source: ThreadAvailability;
}): ForkOriginRowModel {
  const { marker, source } = input;
  const accessibilityLabel = forkOriginAccessibleLabel(marker);
  const available = source === "available";
  const missing = source === "missing";
  return {
    headline: forkOriginHeadline(marker),
    sourceThreadId: available ? marker.sourceThreadId : null,
    sourceMessageId: available ? marker.sourceMessageId : null,
    sourceUnavailable: missing ? FORK_ORIGIN_COPY.sourceUnavailable : null,
    providerLine: forkOriginProviderLine(marker),
    checkoutLine: forkOriginCheckoutLine(marker),
    notices: marker.notices,
    accessibilityLabel: missing
      ? `${accessibilityLabel}. ${FORK_ORIGIN_COPY.sourceUnavailable.replace(/\.+$/, "")}`
      : accessibilityLabel,
  };
}
