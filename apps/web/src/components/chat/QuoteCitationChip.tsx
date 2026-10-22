import {
  QUOTE_CITATION_MAX_COMMENT_LENGTH,
  quoteCitationLabel,
  quoteCitationSourceKey,
  truncateQuotePreview,
  type QuoteCitation,
} from "@ryco/shared/quoteCitations";
import { XIcon } from "lucide-react";
import { use, useState } from "react";

import { cn } from "~/lib/utils";
import { useQuoteSourceJumpStore } from "../../quoteSourceJumpStore";
import {
  COMPOSER_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
} from "../composerInlineChip";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { QuoteCitationContext } from "./quoteCitationContext";
import { QuoteChipIcon, QuoteCommentIcon, QuoteEditIcon } from "./quoteCitationIcons";
import { useOpenQuoteSource } from "./useOpenQuoteSource";

const TOOLTIP_QUOTE_LENGTH = 280;

function useQuoteSourceUnavailable(citation: QuoteCitation): boolean {
  const sourceKey = quoteCitationSourceKey(citation);
  return useQuoteSourceJumpStore((store) => store.unavailableSourceKeys.has(sourceKey));
}

function quoteChipAriaLabel(label: string, unavailable: boolean): string {
  return unavailable
    ? `Quoted text, source no longer available: ${label}`
    : `Show quoted text in conversation: ${label}`;
}

/** The chip's face: the quote icon, the preview, and a mark when it has a comment. */
function QuoteCitationChipFace(props: { readonly citation: QuoteCitation }) {
  return (
    <>
      <QuoteChipIcon className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME} />
      <span className={cn(COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME, "max-w-48")}>
        {quoteCitationLabel(props.citation)}
      </span>
      {props.citation.comment !== undefined ? (
        <QuoteCommentIcon className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME} />
      ) : null}
    </>
  );
}

function QuoteCitationTooltipPopup(props: {
  readonly citation: QuoteCitation;
  readonly unavailable: boolean;
}) {
  const { citation } = props;
  return (
    <TooltipPopup side="top" className="max-w-80 whitespace-normal leading-tight">
      <span className="flex flex-col gap-1.5 py-0.5">
        <span className="line-clamp-6 whitespace-pre-wrap border-l-2 border-border pl-2 text-muted-foreground">
          {truncateQuotePreview(citation.selector.exact.trim(), TOOLTIP_QUOTE_LENGTH)}
        </span>
        {citation.comment !== undefined ? (
          <span className="line-clamp-6 whitespace-pre-wrap">{citation.comment}</span>
        ) : null}
        {props.unavailable ? (
          <span className="text-muted-foreground">Source no longer available</span>
        ) : null}
      </span>
    </TooltipPopup>
  );
}

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
  const unavailable = useQuoteSourceUnavailable(citation);

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
              aria-label={quoteChipAriaLabel(quoteCitationLabel(citation), unavailable)}
              onClick={() => openSource(citation)}
            />
          }
        >
          <QuoteCitationChipFace citation={citation} />
        </TooltipTrigger>
        <QuoteCitationTooltipPopup citation={citation} unavailable={unavailable} />
      </Tooltip>
    </span>
  );
}

/**
 * A quote in the composer, before it is sent. Its face opens the passage like
 * a sent quote; the pencil edits the comment that goes with it, and the cross
 * takes the quote out of the prompt.
 */
export function QuoteCitationDraftChip(props: {
  readonly citation: QuoteCitation;
  /** The thread on screen; a quote from another thread opens its own first. */
  readonly currentThreadKey: string | null;
  /** Off while the editor is disabled: the chip still opens its source. */
  readonly editable: boolean;
  /** Replaces the quote's comment; a blank one removes it. Throws a RangeError, worded for the user. */
  readonly onSaveComment: (comment: string) => void;
  readonly onRemove: () => void;
  /** Where focus goes once the comment editor closes: back into the prompt. */
  readonly onRestoreFocus: () => void;
}) {
  const { citation } = props;
  const openSource = useOpenQuoteSource(props.currentThreadKey);
  const unavailable = useQuoteSourceUnavailable(citation);
  const [commentOpen, setCommentOpen] = useState(false);
  const label = quoteCitationLabel(citation);
  const hasComment = citation.comment !== undefined;

  return (
    <span
      className={cn(COMPOSER_INLINE_CHIP_CLASS_NAME, unavailable && "text-muted-foreground")}
      contentEditable={false}
      spellCheck={false}
      data-composer-quote-chip="true"
      data-source-unavailable={unavailable ? "true" : undefined}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="inline-flex min-w-0 cursor-pointer items-center gap-1 rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              aria-label={quoteChipAriaLabel(label, unavailable)}
              onClick={() => openSource(citation)}
            />
          }
        >
          <QuoteCitationChipFace citation={citation} />
        </TooltipTrigger>
        <QuoteCitationTooltipPopup citation={citation} unavailable={unavailable} />
      </Tooltip>
      {props.editable ? (
        <>
          <Popover open={commentOpen} onOpenChange={setCommentOpen}>
            <PopoverTrigger
              aria-label={hasComment ? `Edit comment on ${label}` : `Add comment to ${label}`}
              className={COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME}
            >
              <QuoteEditIcon className="size-3" />
            </PopoverTrigger>
            {commentOpen ? (
              <PopoverPopup
                side="top"
                align="start"
                aria-label="Comment on quote"
                className="w-80 max-w-[calc(100vw-1rem)]"
                viewportClassName="p-0"
                finalFocus={() => {
                  props.onRestoreFocus();
                  return false;
                }}
              >
                <QuoteCitationCommentEditor
                  citation={citation}
                  onSave={(comment) => {
                    props.onSaveComment(comment);
                    setCommentOpen(false);
                  }}
                  onCancel={() => setCommentOpen(false)}
                />
              </PopoverPopup>
            ) : null}
          </Popover>
          <button
            type="button"
            aria-label={`Remove quote ${label}`}
            className={COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME}
            onClick={props.onRemove}
          >
            <XIcon aria-hidden className="size-3" />
          </button>
        </>
      ) : null}
    </span>
  );
}

/**
 * The comment on one quote. It sits inside the composer's form, so it is no
 * form of its own and handles its keys itself: Enter saves, Shift+Enter adds
 * a line, Escape leaves the comment as it was. No key reaches the composer.
 */
function QuoteCitationCommentEditor(props: {
  readonly citation: QuoteCitation;
  readonly onSave: (comment: string) => void;
  readonly onCancel: () => void;
}) {
  const [comment, setComment] = useState(props.citation.comment ?? "");
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    try {
      props.onSave(comment);
    } catch (cause) {
      setError(cause instanceof RangeError ? cause.message : "The comment could not be saved.");
    }
  };

  return (
    <div
      className="flex flex-col"
      data-quote-comment-editor="true"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape") {
          event.preventDefault();
          props.onCancel();
        }
      }}
      onPaste={(event) => event.stopPropagation()}
    >
      <div className="line-clamp-2 border-b border-border/70 px-3 pt-2.5 pb-2 text-xs text-muted-foreground">
        {quoteCitationLabel(props.citation)}
      </div>
      {/* The popup's first field: it takes focus as the popup opens. */}
      <textarea
        aria-label="Comment on quote"
        placeholder="Add a note for the agent about this quote"
        value={comment}
        maxLength={QUOTE_CITATION_MAX_COMMENT_LENGTH}
        rows={2}
        className="block field-sizing-content max-h-48 min-h-14 w-full resize-none bg-transparent px-3 py-2 text-[13px] leading-[1.55] text-foreground outline-none placeholder:text-muted-foreground/70"
        onChange={(event) => {
          setComment(event.target.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
          event.preventDefault();
          save();
        }}
      />
      <div className="flex min-h-9 items-center gap-1.5 px-2 pb-2">
        <div className="min-w-0 flex-1 truncate text-xs text-destructive" aria-live="polite">
          {error}
        </div>
        <Button size="xs" variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button size="xs" onClick={save}>
          Save
        </Button>
      </div>
    </div>
  );
}
