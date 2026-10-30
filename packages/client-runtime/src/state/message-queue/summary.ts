import { quoteCitationsToInlineText } from "@ryco/shared/quoteCitations";

/*
 * A queued message's chip label. Apart from the queue's ordering logic
 * (`./logic.ts`), which the app's boot runs: the label reads quote chips
 * through the quote citation parser, which only the composer and the queue's
 * views need, so it loads with them instead of with every launch.
 */

export interface QueuedMessageSummaryInput {
  readonly trimmedPrompt: string;
  readonly imageCount: number;
  readonly terminalContextCount: number;
  readonly fileReferenceCount?: number;
  /** Page elements picked in the project browser. */
  readonly browserElementCount?: number;
}

const QUEUED_MESSAGE_SUMMARY_MAX_CHARS = 120;

export function summarizeQueuedMessage(input: QueuedMessageSummaryInput): string {
  // A quote chip reads as its quoted preview, not as its token.
  const text = quoteCitationsToInlineText(input.trimmedPrompt).trim();
  if (text.length > 0) {
    return text.length > QUEUED_MESSAGE_SUMMARY_MAX_CHARS
      ? `${text.slice(0, QUEUED_MESSAGE_SUMMARY_MAX_CHARS - 1)}…`
      : text;
  }
  if (input.imageCount > 0)
    return input.imageCount === 1 ? "1 image" : `${input.imageCount} images`;
  if (input.terminalContextCount > 0) {
    return input.terminalContextCount === 1
      ? "1 terminal context"
      : `${input.terminalContextCount} terminal contexts`;
  }
  const fileReferenceCount = input.fileReferenceCount ?? 0;
  if (fileReferenceCount > 0) {
    return fileReferenceCount === 1 ? "1 file reference" : `${fileReferenceCount} file references`;
  }
  const browserElementCount = input.browserElementCount ?? 0;
  if (browserElementCount > 0) {
    return browserElementCount === 1 ? "1 page element" : `${browserElementCount} page elements`;
  }
  return "Queued message";
}
