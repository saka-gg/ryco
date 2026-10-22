import {
  quoteCitationLabel,
  quoteCitationSourceKey,
  truncateQuotePreview,
  type QuoteCitation,
} from "@ryco/shared/quoteCitations";
import { MessageSquareTextIcon, TextQuoteIcon } from "lucide-react";
import { use } from "react";

import { cn } from "~/lib/utils";
import { useQuoteSourceJumpStore } from "../../quoteSourceJumpStore";
import {
  COMPOSER_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
} from "../composerInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { QuoteCitationContext } from "./quoteCitationContext";
import { useOpenQuoteSource } from "./useOpenQuoteSource";

const TOOLTIP_QUOTE_LENGTH = 280;

/**
 * A quoted passage in a sent message. Clicking it brings the passage into
 * view in its thread and highlights it; once the passage cannot be found,
 * the chip quietly says so.
 */
export function QuoteCitationChip(props: {
  readonly citation: QuoteCitation;
  /** The `[Quote N]` number the chip stands for; absent for a draft token. */
  readonly number?: number | null | undefined;
}) {
  const { citation } = props;
  const context = use(QuoteCitationContext);
  const openSource = useOpenQuoteSource(context?.currentThreadKey ?? null);
  const sourceKey = quoteCitationSourceKey(citation);
  const unavailable = useQuoteSourceJumpStore((store) =>
    store.unavailableSourceKeys.has(sourceKey),
  );
  const label = quoteCitationLabel(citation);

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
              data-quote-number={props.number ?? undefined}
              data-source-unavailable={unavailable ? "true" : undefined}
              aria-label={
                unavailable
                  ? `Quoted text, source no longer available: ${label}`
                  : `Show quoted text in conversation: ${label}`
              }
              onClick={() => openSource(citation)}
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
              {truncateQuotePreview(citation.selector.exact.trim(), TOOLTIP_QUOTE_LENGTH)}
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
