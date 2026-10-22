import { scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  quoteCitationLabel,
  quoteCitationSourceKey,
  type QuoteCitation,
} from "@ryco/shared/quoteCitations";
import { useRouter } from "@tanstack/react-router";
import { MessageSquareTextIcon, TextQuoteIcon } from "lucide-react";
import { use } from "react";

import { cn } from "~/lib/utils";
import { useQuoteSourceJumpStore } from "../../quoteSourceJumpStore";
import { selectThreadAvailabilityByRef, useStore } from "../../store";
import {
  COMPOSER_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
} from "../composerInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { QuoteCitationContext } from "./quoteCitationContext";

const TOOLTIP_QUOTE_LENGTH = 280;

function tooltipQuote(citation: QuoteCitation): string {
  const quote = citation.selector.exact.trim();
  return quote.length > TOOLTIP_QUOTE_LENGTH ? `${quote.slice(0, TOOLTIP_QUOTE_LENGTH)}…` : quote;
}

/**
 * A quoted passage in a sent message. Clicking it brings the passage into
 * view in its thread and highlights it; once the passage cannot be found,
 * the chip quietly says so.
 */
export function QuoteCitationChip(props: { readonly citation: QuoteCitation }) {
  const { citation } = props;
  const context = use(QuoteCitationContext);
  // Absent outside a router (isolated renders); same-thread jumps need none.
  const router: ReturnType<typeof useRouter> | null = useRouter({ warn: false });
  const sourceKey = quoteCitationSourceKey(citation);
  const unavailable = useQuoteSourceJumpStore((store) =>
    store.unavailableSourceKeys.has(sourceKey),
  );
  const label = quoteCitationLabel(citation);

  const openSource = () => {
    const jumps = useQuoteSourceJumpStore.getState();
    const threadRef = scopeThreadRef(citation.environmentId, citation.threadId);
    if (scopedThreadKey(threadRef) !== context?.currentThreadKey) {
      if (
        router === null ||
        selectThreadAvailabilityByRef(useStore.getState(), threadRef) === "missing"
      ) {
        jumps.markUnavailable(citation);
        return;
      }
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: citation.environmentId, threadId: citation.threadId },
      });
    }
    jumps.jump(citation);
  };

  return (
    <span className="inline-flex align-middle leading-none">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className={cn(
                COMPOSER_INLINE_CHIP_CLASS_NAME,
                "cursor-pointer hover:bg-accent/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                unavailable && "text-muted-foreground",
              )}
              data-quote-citation-chip="true"
              data-source-unavailable={unavailable ? "true" : undefined}
              aria-label={
                unavailable
                  ? `Quoted text, source no longer available: ${label}`
                  : `Show quoted text in conversation: ${label}`
              }
              onClick={openSource}
            />
          }
        >
          <TextQuoteIcon aria-hidden className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME} />
          <span className={cn(COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME, "max-w-48")}>{label}</span>
          {citation.comment !== undefined ? (
            <MessageSquareTextIcon aria-hidden className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME} />
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="top" className="max-w-80 whitespace-normal leading-tight">
          <span className="flex flex-col gap-1.5 py-0.5">
            <span className="line-clamp-6 whitespace-pre-wrap border-l-2 border-border pl-2 text-muted-foreground">
              {tooltipQuote(citation)}
            </span>
            {citation.comment !== undefined ? (
              <span className="line-clamp-6 whitespace-pre-wrap">{citation.comment}</span>
            ) : null}
            {unavailable ? (
              <span className="text-muted-foreground">Source no longer available</span>
            ) : null}
          </span>
        </TooltipPopup>
      </Tooltip>
    </span>
  );
}
