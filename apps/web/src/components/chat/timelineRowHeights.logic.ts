// FILE: timelineRowHeights.logic.ts
// Purpose: Heights for transcript rows the virtual list has not measured yet: a
//          content estimate from the row itself, and a bounded in-memory record of
//          what rows measured, so a thread opened again lays out at those heights.
// Layer: Web chat timeline (pure: no React, no DOM)
// Exports: estimateTimelineRowHeight, estimateMarkdownHeight, timelineRowHeightSignature,
//          isLiveTimelineRow, isRememberableTimelineRow, createTimelineRowHeightMemory,
//          timelineRowHeightMemory, timelineRowLayoutKey
//
// The constants mirror the CSS the rows render with (`index.css` `.chat-markdown*`, the
// row classes in MessagesTimeline.tsx and its row components). Sizes in rem scale with
// the font-size preference; the few fixed-pixel classes (`h-[30px]`, `text-[11px]`)
// stay in px. MessagesTimeline.rowHeights.browser.tsx measures real rows against these
// estimates; retune there when a row's markup changes.

import { isTerminalSnippetLanguage } from "@ryco/client-runtime/state/terminal";
import { htmlRenderFrameHeight } from "@ryco/shared/htmlRender";
import { LRUCache } from "@ryco/shared/lruCache";

import type { PresentationTier } from "../../lib/presentationTier";
import { isChatImageAttachment } from "../../types";
import { deriveDisplayedUserMessageForTier } from "../../lib/userMessageDisplay";
import {
  buildCollapsedProposedPlanPreviewMarkdown,
  isProposedPlanCollapsible,
  stripDisplayedPlanMarkdown,
} from "../../proposedPlan";
import { readHtmlRenderAttachment } from "./htmlRender.logic";
import { CHAPTER_TICKER_WINDOW } from "./workChapters.logic";
import { MAX_VISIBLE_CHANGED_FILES, type MessagesTimelineRow } from "./MessagesTimeline.logic";

/** What a row's height depends on besides its content. */
export interface TimelineRowLayout {
  /** Width of a `[data-timeline-root]` row column, in CSS px. */
  readonly rowWidthPx: number;
  /** Root font size (the font-size appearance preference). */
  readonly remPx: number;
  /** Root font families and size, so a font change never reuses another font's heights. */
  readonly typographyKey: string;
  readonly tier: PresentationTier;
}

/** The default 48rem chat column at a 16px root, used until the column is measured. */
export const DEFAULT_TIMELINE_ROW_WIDTH_PX = 768;

export function timelineRowLayoutKey(layout: TimelineRowLayout): string {
  return `${Math.round(layout.rowWidthPx)}|${layout.remPx}|${layout.typographyKey}|${layout.tier}`;
}

const MIN_ROW_HEIGHT_PX = 24;
/**
 * Only guards against arithmetic blow-ups: code blocks and replies have no height cap, so a
 * long dump can measure well past 20,000 px. Far below browsers' element height limits.
 */
const MAX_ROW_HEIGHT_PX = 1_000_000;
/** Estimate from a bounded sample of a row's text and extrapolate; never scan it all. */
const TEXT_SAMPLE_CHARS = 4096;

// ---------------------------------------------------------------------------
// Typography (rem unless named px)
// ---------------------------------------------------------------------------

/** `text-sm`. */
const PROSE_FONT_REM = 0.875;
/** `leading-relaxed`. */
const PROSE_LINE_HEIGHT = 1.625;
/** Average advance of proportional UI text, in em. */
const SANS_GLYPH_EM = 0.5;
/** `.chat-markdown p, ul, ol, blockquote, pre, table { margin: 0.65rem 0 }`. */
const BLOCK_GAP_REM = 0.65;
/** `.chat-markdown pre code { font-size: 0.75rem }` in a `leading-snug` code block. */
const CODE_FONT_REM = 0.75;
const CODE_LINE_HEIGHT = 1.375;
/** `pre` padding 0.8rem top and bottom plus a 1px border. */
const CODE_BLOCK_PADDING_REM = 1.6;
const CODE_BLOCK_BORDER_PX = 2;
/** "Insert in terminal" above a shell block: 0.7rem text, 0.2rem padding, 0.3rem margin. */
const CODE_INSERT_BUTTON_REM = 0.7 * CODE_LINE_HEIGHT + 0.4 + 0.3;
/** `.chat-markdown ul/ol { padding-left: 1.25rem }`, `li + li { margin-top: 0.25rem }`. */
const LIST_INDENT_REM = 1.25;
const LIST_ITEM_GAP_REM = 0.25;
/** `blockquote` padding-left 0.8rem (+ 2px border). */
const QUOTE_INDENT_REM = 0.8;
/** `th, td { padding: 0.35rem 0.45rem }` with collapsed 1px borders. */
const TABLE_CELL_PADDING_BLOCK_REM = 0.7;
const TABLE_CELL_PADDING_INLINE_REM = 0.9;
/** The table sits in its own scroll box, so its margins do not collapse with its neighbours'. */
const TABLE_EXTRA_GAP_REM = 0.65;
/** h1..h6 sizes in em of the prose font; `line-height: 1.3`, `margin: 1.1em 0 0.4em`. */
const HEADING_SCALE = [1.3, 1.18, 1.08, 1, 1, 1] as const;
const HEADING_LINE_HEIGHT = 1.3;
const HEADING_MARGIN_TOP_EM = 1.1;
/** Body copy in fixed-px classes inherits the document's 1.5 line height. */
const BODY_LINE_HEIGHT = 1.5;

// ---------------------------------------------------------------------------
// Row chrome
// ---------------------------------------------------------------------------

/** Row wrapper bottom padding: `pb-4`, `pb-2`, `pb-0.5`. */
const ROW_PAD_REM = 1;
const ROW_PAD_COMPACT_REM = 0.5;
const ROW_PAD_WORK_REM = 0.125;
/** `h-[30px]` / `min-h-[30px]` rows. */
const COMPACT_ROW_PX = 30;
/** `leading-5` labels inside compact rows. */
const COMPACT_ROW_TEXT_REM = 1.25;
/** User bubble: `max-w-[80%]`, `px-3 py-2`. */
const USER_BUBBLE_WIDTH_RATIO = 0.8;
const BUBBLE_PADDING_INLINE_REM = 1.5;
const BUBBLE_PADDING_BLOCK_REM = 1;
/** Message action row: `mt-1` (user) or `mt-1.5` (assistant) above `size-6` buttons. */
const MESSAGE_ACTIONS_REM = 1.5;
const USER_ACTIONS_GAP_REM = 0.25;
const ASSISTANT_ACTIONS_GAP_REM = 0.375;
/** Assistant meta text without buttons: `text-[10px]`. */
const ASSISTANT_META_TEXT_PX = 10 * BODY_LINE_HEIGHT;
/** Assistant body `px-1 py-0.5`. */
const ASSISTANT_PADDING_INLINE_REM = 0.5;
const ASSISTANT_PADDING_BLOCK_REM = 0.25;
/** A row of chips (file references, unplaced quotes, terminal contexts) and its `mb-1`. */
const CHIP_ROW_REM = 1.5;
const CHIP_ROW_GAP_REM = 0.25;
/** Characters an inline terminal-context chip takes besides its label. */
const INLINE_CHIP_EXTRA_CHARS = 4;
/** Attachment cards: user images cap at 360x260, assistant images at 360 tall. */
const USER_IMAGE_MAX_WIDTH_PX = 360;
const USER_IMAGE_MAX_HEIGHT_PX = 260;
const ASSISTANT_IMAGE_MAX_HEIGHT_PX = 360;
const ATTACHMENTS_MAX_WIDTH_PX = 520;
const ATTACHMENT_GAP_REM = 0.5;
const ATTACHMENT_BORDER_PX = 2;
/** The assistant image's download line: `px-3 py-2 text-xs`. */
const ATTACHMENT_CAPTION_REM = 1 + 0.75 * 1.333;
/** A file row (icon, name, size). */
const ATTACHMENT_FILE_ROW_REM = 3.25;
/** Page cards under a reply: `mt-2 mb-1`, `p-1.5` around a 36px two-line label. */
const HTML_RENDER_CARDS_GAP_REM = 0.75;
const HTML_RENDER_CARD_PX = 36;
const HTML_RENDER_CARD_PADDING_REM = 0.75;
const HTML_RENDER_CARD_WIDTH_REM = 18;
/** Changed-files card: `mt-2 mb-1`, header `py-1.5`, file rows `py-2`, 12px text. */
const CHANGED_FILES_MARGIN_REM = 0.75;
const CHANGED_FILES_HEADER_PADDING_REM = 0.75;
const CHANGED_FILES_TEXT_PX = 12 * BODY_LINE_HEIGHT;
const CHANGED_FILE_ROW_PADDING_REM = 1;
/** Work rows: `space-y-0.5` between entries, `space-y-1` under the 9px group label. */
const WORK_ENTRY_GAP_REM = 0.125;
const WORK_LABEL_PX = 9 * BODY_LINE_HEIGHT;
const WORK_LABEL_GAP_REM = 0.25;
/** A multi-file edit row: `py-1.5`, label, `mt-0.5`, a row of 9px chips. */
const MULTI_FILE_EDIT_EXTRA_REM = 0.75 + 0.125 + 0.75 + 0.25;
const MULTI_FILE_EDIT_EXTRA_PX = 2;
/** An agent spawn row. */
const AGENT_SPAWN_ROW_REM = 3.5;
/** Turn fold `pt-1 pb-1`; working row `pt-1 pb-2` around two 30px lines. */
const TURN_FOLD_PADDING_REM = 0.5;
const WORKING_PADDING_REM = 0.75;
/** Chapter: section `pb-3` / `pb-0.5`, rail indent 26px, body `pb-0.5`, tally row 26px. */
const CHAPTER_LAST_PADDING_REM = 0.75;
const CHAPTER_PADDING_REM = 0.125;
const CHAPTER_INDENT_PX = 26;
const CHAPTER_BODY_PADDING_REM = 0.125 + 0.25;
const CHAPTER_MESSAGE_INLINE_REM = 0.25;
const CHAPTER_TALLY_ROW_PX = 26;
const CHAPTER_EARLIER_TOGGLE_REM = 1.5;
/** Plan card: border, `sm:p-5`, header row, `mt-4`, collapsed `max-h-104`, button row. */
const PLAN_CARD_PADDING_REM = 2.5;
const PLAN_CARD_PADDING_PHONE_REM = 2;
const PLAN_CARD_HEADER_REM = 1.5 + 1;
const PLAN_CARD_COLLAPSED_MAX_REM = 26;
const PLAN_CARD_TOGGLE_REM = 1 + 2;
const PLAN_CARD_BORDER_PX = 2;
/** Fork button row under a page row: `mt-1.5` and a `size-6` button. */
const PAGE_FORK_ROW_REM = 0.375 + 1.5;
/** Marker rows (wrapper padding included). */
const CONTEXT_COMPACTION_REM = 1 + 0.75 + 0.5;
const CONTEXT_COMPACTION_PX = 10 * BODY_LINE_HEIGHT + 2;
const CONTEXT_HANDOFF_REM = 3.5;
const FORK_ORIGIN_REM = 1 + 1 + 1 + 0.25 + 1;
/** Question cards: `gap-2`, card `py-2` + border, 11px header, `mt-1`, `mt-1.5` options. */
const EXCHANGE_GAP_REM = 0.5;
const EXCHANGE_HEADER_PX = 11 * BODY_LINE_HEIGHT;
const EXCHANGE_QUESTION_GAP_REM = 0.25;
const EXCHANGE_OPTIONS_GAP_REM = 0.375;
const EXCHANGE_OPTION_ROW_PX = 11 * BODY_LINE_HEIGHT + 4;
const EXCHANGE_TIMESTAMP_PX = 11 * BODY_LINE_HEIGHT;

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

export interface MarkdownEstimateOptions {
  /** Shell blocks get an "Insert in terminal" button (assistant replies on desktop). */
  readonly terminalInsertion?: boolean;
}

const CHAR_SPACE = 32;
const CHAR_HASH = 35;
const CHAR_PLUS = 43;
const CHAR_STAR = 42;
const CHAR_DASH = 45;
const CHAR_DOT = 46;
const CHAR_CLOSE_PAREN = 41;
const CHAR_COLON = 58;
const CHAR_GT = 62;
const CHAR_PIPE = 124;
const CHAR_BACKTICK = 96;
const CHAR_TILDE = 126;
const CHAR_UNDERSCORE = 95;
const CHAR_ZERO = 48;
const CHAR_NINE = 57;

type MarkdownBlockKind = "paragraph" | "list" | "quote" | "table";

/**
 * Height of Markdown laid out `widthPx` wide, from one pass over a bounded sample of its
 * lines: paragraphs, lists, quotes, tables, headings and fenced code, with the margins
 * between blocks. Extrapolates from the sample for longer text.
 */
export function estimateMarkdownHeight(
  text: string,
  widthPx: number,
  remPx: number,
  options: MarkdownEstimateOptions = {},
): number {
  if (text.length === 0) return 0;
  const sample = text.length > TEXT_SAMPLE_CHARS ? text.slice(0, TEXT_SAMPLE_CHARS) : text;
  const fontPx = PROSE_FONT_REM * remPx;
  const lineHeightPx = fontPx * PROSE_LINE_HEIGHT;
  const charPx = fontPx * SANS_GLYPH_EM;
  const width = Math.max(1, widthPx);
  const gapPx = BLOCK_GAP_REM * remPx;
  const codeLinePx = CODE_FONT_REM * remPx * CODE_LINE_HEIGHT;

  let height = 0;
  let blocks = 0;
  // The margin the previous block leaves below itself (collapses with the next one's).
  let previousMarginBottom = 0;
  const startBlock = (marginTop: number) => {
    if (blocks > 0) height += Math.max(previousMarginBottom, marginTop);
    blocks += 1;
  };
  const linesFor = (chars: number, blockWidth: number, glyphPx: number) =>
    Math.max(1, Math.ceil(chars / Math.max(8, Math.floor(blockWidth / glyphPx))));

  // The open prose-like block and its accumulated text.
  let openKind: MarkdownBlockKind | null = null;
  let openChars = 0;
  let listItems = 0;
  let listLines = 0;
  let listLoose = false;
  let listSawBlank = false;
  let tableRows = 0;
  let tableColumns = 1;
  let tableRowLines = 0;

  const closeBlock = () => {
    switch (openKind) {
      case null:
        return;
      case "paragraph":
        height += linesFor(openChars, width, charPx) * lineHeightPx;
        previousMarginBottom = gapPx;
        break;
      case "quote":
        height += linesFor(openChars, width - QUOTE_INDENT_REM * remPx - 2, charPx) * lineHeightPx;
        previousMarginBottom = gapPx;
        break;
      case "list":
        if (openChars > 0) {
          listLines += linesFor(openChars, width - LIST_INDENT_REM * remPx, charPx);
        }
        height +=
          listLines * lineHeightPx +
          Math.max(0, listItems - 1) * (listLoose ? gapPx : LIST_ITEM_GAP_REM * remPx);
        previousMarginBottom = gapPx;
        break;
      case "table":
        height +=
          tableRowLines * lineHeightPx +
          tableRows * (TABLE_CELL_PADDING_BLOCK_REM * remPx + 1) +
          1 +
          2 * TABLE_EXTRA_GAP_REM * remPx;
        previousMarginBottom = gapPx;
        break;
    }
    openKind = null;
    openChars = 0;
  };
  const finishListItem = () => {
    if (openKind === "list" && openChars > 0) {
      listLines += linesFor(openChars, width - LIST_INDENT_REM * remPx, charPx);
      openChars = 0;
    }
  };

  let fence: { char: number; length: number; lines: number; insert: boolean } | null = null;
  let start = 0;
  while (start <= sample.length) {
    const newline = sample.indexOf("\n", start);
    const end = newline === -1 ? sample.length : newline;
    let lineStart = start;
    while (lineStart < end && sample.charCodeAt(lineStart) === CHAR_SPACE) lineStart += 1;
    const indent = lineStart - start;
    let lineEnd = end;
    while (lineEnd > lineStart && sample.charCodeAt(lineEnd - 1) <= CHAR_SPACE) lineEnd -= 1;
    const length = lineEnd - lineStart;
    const first = length > 0 ? sample.charCodeAt(lineStart) : 0;
    const heading =
      fence === null && first === CHAR_HASH && indent < 4
        ? headingLevel(sample, lineStart, lineEnd)
        : 0;
    const openingFenceRun: number =
      fence === null && indent < 4 && (first === CHAR_BACKTICK || first === CHAR_TILDE)
        ? runLength(sample, lineStart, lineEnd, first)
        : 0;

    if (fence) {
      const closing = indent < 4 && first === fence.char;
      const run = closing ? runLength(sample, lineStart, lineEnd, first) : 0;
      if (closing && run >= fence.length && run === length) {
        const codeHeight =
          Math.max(1, fence.lines) * codeLinePx +
          CODE_BLOCK_PADDING_REM * remPx +
          CODE_BLOCK_BORDER_PX +
          (fence.insert ? CODE_INSERT_BUTTON_REM * remPx + 2 : 0);
        height += codeHeight;
        previousMarginBottom = gapPx;
        fence = null;
      } else {
        // Code does not wrap; an overlong line scrolls inside the block.
        fence.lines += 1;
      }
    } else if (openingFenceRun >= 3) {
      closeBlock();
      startBlock(gapPx);
      const language =
        sample
          .slice(lineStart + openingFenceRun, lineEnd)
          .trim()
          .split(/\s/, 1)[0] ?? "";
      fence = {
        char: first,
        length: openingFenceRun,
        lines: 0,
        insert: options.terminalInsertion === true && isTerminalSnippetLanguage(language),
      };
    } else if (length === 0) {
      if (openKind === "list") {
        listSawBlank = true;
        finishListItem();
      } else {
        closeBlock();
      }
    } else if (heading > 0) {
      closeBlock();
      const headingFontPx = fontPx * HEADING_SCALE[heading - 1]!;
      startBlock(HEADING_MARGIN_TOP_EM * headingFontPx);
      height +=
        linesFor(length - heading - 1, width, headingFontPx * SANS_GLYPH_EM * 1.05) *
        headingFontPx *
        HEADING_LINE_HEIGHT;
      // `0.4em` below collapses into the next block's larger margin.
      previousMarginBottom = 0.4 * headingFontPx;
    } else if (
      first === CHAR_PIPE ||
      (openKind === "table" && countPipes(sample, lineStart, lineEnd) > 0) ||
      startsTableWithoutOuterPipes(sample, lineStart, lineEnd, newline)
    ) {
      if (openKind !== "table") {
        closeBlock();
        startBlock(gapPx);
        openKind = "table";
        tableRows = 0;
        tableRowLines = 0;
        tableColumns = tableColumnCount(sample, lineStart, lineEnd);
      }
      if (!isTableDelimiterRow(sample, lineStart, lineEnd)) {
        tableRows += 1;
        const cellWidth = Math.max(
          1,
          width / tableColumns - TABLE_CELL_PADDING_INLINE_REM * remPx - 1,
        );
        tableRowLines += linesFor(length / tableColumns, cellWidth, charPx);
      }
    } else if (first === CHAR_GT) {
      if (openKind !== "quote") {
        closeBlock();
        startBlock(gapPx);
        openKind = "quote";
      }
      openChars += length + 1;
    } else if (isHorizontalRule(sample, lineStart, lineEnd, first)) {
      closeBlock();
      startBlock(0);
      height += 1;
      previousMarginBottom = 0;
    } else {
      const marker = listMarkerLength(sample, lineStart, lineEnd, first);
      if (marker > 0) {
        if (openKind !== "list") {
          closeBlock();
          startBlock(gapPx);
          openKind = "list";
          listItems = 0;
          listLines = 0;
          listLoose = false;
          listSawBlank = false;
        } else {
          finishListItem();
          if (listSawBlank) listLoose = true;
        }
        listSawBlank = false;
        listItems += 1;
        openChars = length - marker;
      } else if (openKind === "list" && (indent >= 2 || !listSawBlank)) {
        // A continuation of the current item (lazy or indented).
        openChars += length + 1;
        listSawBlank = false;
      } else {
        if (openKind !== "paragraph") {
          closeBlock();
          startBlock(gapPx);
          openKind = "paragraph";
        }
        openChars += length + 1;
      }
    }
    if (newline === -1) break;
    start = newline + 1;
  }
  if (fence) {
    // An unclosed fence (cut by the sample, or streaming) still renders as code.
    height +=
      Math.max(1, fence.lines) * codeLinePx + CODE_BLOCK_PADDING_REM * remPx + CODE_BLOCK_BORDER_PX;
  }
  closeBlock();
  return sample.length < text.length ? height * (text.length / sample.length) : height;
}

function runLength(text: string, start: number, end: number, char: number): number {
  let index = start;
  while (index < end && text.charCodeAt(index) === char) index += 1;
  return index - start;
}

function headingLevel(text: string, start: number, end: number): number {
  const run = runLength(text, start, end, CHAR_HASH);
  if (run < 1 || run > 6) return 0;
  return start + run === end || text.charCodeAt(start + run) === CHAR_SPACE ? run : 0;
}

function countPipes(text: string, start: number, end: number): number {
  let count = 0;
  for (let index = start; index < end; index += 1) {
    if (text.charCodeAt(index) === CHAR_PIPE) count += 1;
  }
  return count;
}

/** Cells in a table row, with or without its outer pipes (`| a | b |`, `a | b`). */
function tableColumnCount(text: string, start: number, end: number): number {
  const leading = text.charCodeAt(start) === CHAR_PIPE ? 1 : 0;
  const trailing = end - 1 > start && text.charCodeAt(end - 1) === CHAR_PIPE ? 1 : 0;
  return Math.max(1, countPipes(text, start, end) + 1 - leading - trailing);
}

/** A GFM table whose rows do not start with `|`: a line with a pipe over a delimiter row. */
function startsTableWithoutOuterPipes(
  text: string,
  start: number,
  end: number,
  newline: number,
): boolean {
  if (newline === -1 || countPipes(text, start, end) === 0) return false;
  let nextStart = newline + 1;
  const nextNewline = text.indexOf("\n", nextStart);
  let nextEnd = nextNewline === -1 ? text.length : nextNewline;
  while (nextStart < nextEnd && text.charCodeAt(nextStart) === CHAR_SPACE) nextStart += 1;
  while (nextEnd > nextStart && text.charCodeAt(nextEnd - 1) <= CHAR_SPACE) nextEnd -= 1;
  let pipes = 0;
  let dashes = 0;
  for (let index = nextStart; index < nextEnd; index += 1) {
    const char = text.charCodeAt(index);
    if (char === CHAR_PIPE) pipes += 1;
    else if (char === CHAR_DASH) dashes += 1;
    else if (char !== CHAR_COLON && char !== CHAR_SPACE) return false;
  }
  return pipes > 0 && dashes > 0;
}

function isTableDelimiterRow(text: string, start: number, end: number): boolean {
  for (let index = start; index < end; index += 1) {
    const char = text.charCodeAt(index);
    if (char !== CHAR_PIPE && char !== CHAR_DASH && char !== CHAR_COLON && char !== CHAR_SPACE) {
      return false;
    }
  }
  return true;
}

function isHorizontalRule(text: string, start: number, end: number, first: number): boolean {
  if (first !== CHAR_DASH && first !== CHAR_STAR && first !== CHAR_UNDERSCORE) return false;
  let count = 0;
  for (let index = start; index < end; index += 1) {
    const char = text.charCodeAt(index);
    if (char === first) count += 1;
    else if (char !== CHAR_SPACE) return false;
  }
  return count >= 3;
}

/** Length of a list marker (`- `, `* `, `+ `, `12. `, `3) `) at the line start, or 0. */
function listMarkerLength(text: string, start: number, end: number, first: number): number {
  if (first === CHAR_DASH || first === CHAR_STAR || first === CHAR_PLUS) {
    return start + 1 < end && text.charCodeAt(start + 1) === CHAR_SPACE ? 2 : 0;
  }
  let index = start;
  while (index < end && index - start < 9) {
    const char = text.charCodeAt(index);
    if (char < CHAR_ZERO || char > CHAR_NINE) break;
    index += 1;
  }
  if (index === start || index >= end) return 0;
  const delimiter = text.charCodeAt(index);
  if (delimiter !== CHAR_DOT && delimiter !== CHAR_CLOSE_PAREN) return 0;
  return index + 1 < end && text.charCodeAt(index + 1) === CHAR_SPACE ? index - start + 2 : 0;
}

/** Lines of `white-space: pre-wrap` text `widthPx` wide: every newline starts one. */
function estimatePreWrapLines(text: string, widthPx: number, charPx: number): number {
  const sample = text.length > TEXT_SAMPLE_CHARS ? text.slice(0, TEXT_SAMPLE_CHARS) : text;
  const perLine = Math.max(8, Math.floor(Math.max(1, widthPx) / charPx));
  let lines = 0;
  let start = 0;
  while (start <= sample.length) {
    const newline = sample.indexOf("\n", start);
    const end = newline === -1 ? sample.length : newline;
    lines += Math.max(1, Math.ceil((end - start) / perLine));
    if (newline === -1) break;
    start = newline + 1;
  }
  return sample.length < text.length ? lines * (text.length / sample.length) : lines;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

type MessageRow = Extract<MessagesTimelineRow, { kind: "message" }>;
type Attachments = NonNullable<MessageRow["message"]["attachments"]>;
type TurnDiff = MessageRow["assistantTurnDiffSummary"];

/** Trailing context and quote blocks end the message with a closing tag. */
function mayCarryTrailingBlocks(text: string): boolean {
  let index = text.length - 1;
  while (index >= 0 && text.charCodeAt(index) <= CHAR_SPACE) index -= 1;
  return index >= 0 && text.charCodeAt(index) === CHAR_GT;
}

const FENCE_LINE_PATTERN = /(?:^|\n) {0,3}(?:`{3,}|~{3,})/;

/** Height of one attachment card as `MessageAttachments` lays it out (border included). */
function estimateAttachmentCard(
  attachment: Attachments[number],
  variant: "user" | "assistant",
  maxWidthPx: number,
  remPx: number,
): { readonly width: number; readonly height: number } {
  if (isChatImageAttachment(attachment) && attachment.previewUrl) {
    const intrinsicWidth = attachment.width ?? USER_IMAGE_MAX_WIDTH_PX;
    const intrinsicHeight = attachment.height ?? USER_IMAGE_MAX_HEIGHT_PX;
    const ratio = intrinsicHeight / Math.max(1, intrinsicWidth);
    if (variant === "assistant") {
      return {
        width: maxWidthPx,
        height:
          Math.min(ASSISTANT_IMAGE_MAX_HEIGHT_PX, maxWidthPx * ratio) +
          ATTACHMENT_CAPTION_REM * remPx +
          ATTACHMENT_BORDER_PX,
      };
    }
    const width = Math.min(
      USER_IMAGE_MAX_WIDTH_PX,
      intrinsicWidth,
      USER_IMAGE_MAX_HEIGHT_PX / Math.max(ratio, 1e-6),
      maxWidthPx,
    );
    return {
      width,
      height: Math.min(USER_IMAGE_MAX_HEIGHT_PX, width * ratio) + ATTACHMENT_BORDER_PX,
    };
  }
  // A file row, or the "Open file" button of an attachment not loaded yet.
  return {
    width: maxWidthPx,
    height: ATTACHMENT_FILE_ROW_REM * remPx + ATTACHMENT_BORDER_PX,
  };
}

function estimateAttachmentsHeight(
  attachments: Attachments,
  variant: "user" | "assistant",
  availableWidthPx: number,
  remPx: number,
): number {
  if (attachments.length === 0) return 0;
  const gapPx = ATTACHMENT_GAP_REM * remPx;
  const maxWidth = Math.min(ATTACHMENTS_MAX_WIDTH_PX, Math.max(1, availableWidthPx));
  let height = 0;
  let cards = 0;
  let rowWidth = 0;
  let rowHeight = 0;
  for (const attachment of attachments) {
    // An agent page shows as its page (a card on a user message), never as a file row.
    const page = readHtmlRenderAttachment(attachment);
    if (page !== undefined) {
      height +=
        variant === "user"
          ? estimateHtmlRenderCardsHeight(1, availableWidthPx, remPx)
          : htmlRenderFrameHeight(page.htmlRender, availableWidthPx) + 2 * gapPx;
      continue;
    }
    const card = estimateAttachmentCard(attachment, variant, maxWidth, remPx);
    cards += 1;
    if (variant === "assistant") {
      // A column of cards.
      rowHeight += (cards > 1 ? gapPx : 0) + card.height;
      continue;
    }
    // User cards wrap in rows.
    if (rowWidth > 0 && rowWidth + gapPx + card.width > maxWidth) {
      height += rowHeight + gapPx;
      rowWidth = 0;
      rowHeight = 0;
    }
    rowWidth += (rowWidth > 0 ? gapPx : 0) + card.width;
    rowHeight = Math.max(rowHeight, card.height);
  }
  if (cards === 0) return height;
  // `my-2` around the assistant column, `mb-2` under the user rows.
  return height + rowHeight + (variant === "assistant" ? 2 * gapPx : gapPx);
}

function estimateChangedFilesHeight(summary: TurnDiff, remPx: number): number {
  const files = summary?.files ?? [];
  if (files.length === 0) return 0;
  const hasStat = files.some((file) => (file.additions ?? 0) + (file.deletions ?? 0) > 0);
  const visible = Math.min(files.length, MAX_VISIBLE_CHANGED_FILES);
  const fileRowPx = CHANGED_FILE_ROW_PADDING_REM * remPx + Math.max(remPx, CHANGED_FILES_TEXT_PX);
  return (
    CHANGED_FILES_MARGIN_REM * remPx +
    2 +
    CHANGED_FILES_HEADER_PADDING_REM * remPx +
    CHANGED_FILES_TEXT_PX * (hasStat ? 2 : 1) +
    1 +
    visible * fileRowPx +
    (visible - 1) +
    (files.length > MAX_VISIBLE_CHANGED_FILES ? fileRowPx + 1 : 0)
  );
}

function estimateHtmlRenderCardsHeight(count: number, widthPx: number, remPx: number): number {
  if (count === 0) return 0;
  const perRow = Math.max(
    1,
    Math.floor((widthPx + ATTACHMENT_GAP_REM * remPx) / (HTML_RENDER_CARD_WIDTH_REM * remPx)),
  );
  const rows = Math.ceil(count / perRow);
  return (
    HTML_RENDER_CARDS_GAP_REM * remPx +
    rows * (HTML_RENDER_CARD_PX + HTML_RENDER_CARD_PADDING_REM * remPx + 2) +
    (rows - 1) * ATTACHMENT_GAP_REM * remPx
  );
}

function estimateUserMessage(row: MessageRow, layout: TimelineRowLayout): number {
  const { remPx, tier } = layout;
  const text = row.message.text;
  const displayed = mayCarryTrailingBlocks(text)
    ? deriveDisplayedUserMessageForTier(text, tier)
    : null;
  const visibleText = displayed?.visibleText ?? text;
  const contexts = displayed?.contexts ?? [];
  const quotes = displayed?.quotes ?? [];
  const fileReferences = displayed?.fileReferences ?? [];
  const bubbleWidth = layout.rowWidthPx * USER_BUBBLE_WIDTH_RATIO;
  const textWidth = bubbleWidth - BUBBLE_PADDING_INLINE_REM * remPx;
  const proseFontPx = PROSE_FONT_REM * remPx;
  const hasBody = visibleText.trim().length > 0 || contexts.length > 0 || quotes.length > 0;

  let content = 0;
  if (hasBody) {
    if (tier !== "phone" && FENCE_LINE_PATTERN.test(visibleText.slice(0, TEXT_SAMPLE_CHARS))) {
      if (contexts.length > 0) content += (CHIP_ROW_REM + CHIP_ROW_GAP_REM) * remPx;
      content += estimateMarkdownHeight(visibleText, textWidth, remPx, {
        terminalInsertion: true,
      });
    } else {
      let chipChars = 0;
      for (const context of contexts) chipChars += context.header.length + INLINE_CHIP_EXTRA_CHARS;
      const lines = estimatePreWrapLines(
        chipChars > 0 ? `${"x".repeat(Math.min(chipChars, 400))} ${visibleText}` : visibleText,
        textWidth,
        proseFontPx * SANS_GLYPH_EM,
      );
      content += lines * proseFontPx * PROSE_LINE_HEIGHT;
    }
    if (quotes.some((quote) => !text.includes(`[Quote ${quote.number}]`))) {
      content += (CHIP_ROW_REM + CHIP_ROW_GAP_REM) * remPx;
    }
  }
  if (fileReferences.length > 0) {
    content += CHIP_ROW_REM * remPx + (hasBody ? CHIP_ROW_GAP_REM * remPx : 0);
  }
  content += estimateAttachmentsHeight(row.message.attachments ?? [], "user", textWidth, remPx);
  return (
    BUBBLE_PADDING_BLOCK_REM * remPx +
    content +
    (USER_ACTIONS_GAP_REM + MESSAGE_ACTIONS_REM) * remPx +
    ROW_PAD_REM * remPx
  );
}

function estimateAssistantMessage(row: MessageRow, layout: TimelineRowLayout): number {
  const { remPx, tier } = layout;
  const { message } = row;
  const width = layout.rowWidthPx - ASSISTANT_PADDING_INLINE_REM * remPx;
  const text =
    message.text || (message.streaming || message.attachments?.length ? "" : "(empty response)");
  const settled = !message.streaming;
  const showsActions =
    (row.showAssistantCopyButton && settled && message.text.trim().length > 0) ||
    (row.forkFrom !== undefined && tier !== "phone" && settled);
  return (
    ASSISTANT_PADDING_BLOCK_REM * remPx +
    estimateMarkdownHeight(text, width, remPx, { terminalInsertion: tier !== "phone" }) +
    estimateAttachmentsHeight(message.attachments ?? [], "assistant", width, remPx) +
    (settled ? estimateHtmlRenderCardsHeight(row.turnHtmlRenders?.length ?? 0, width, remPx) : 0) +
    (settled ? estimateChangedFilesHeight(row.assistantTurnDiffSummary, remPx) : 0) +
    ASSISTANT_ACTIONS_GAP_REM * remPx +
    (showsActions ? MESSAGE_ACTIONS_REM * remPx : ASSISTANT_META_TEXT_PX) +
    (row.showAssistantCopyButton ? ROW_PAD_REM : ROW_PAD_COMPACT_REM) * remPx
  );
}

type WorkEntry = Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"][number];

function estimateWorkEntryHeight(entry: WorkEntry, layout: TimelineRowLayout): number {
  const { remPx } = layout;
  const rowPx = Math.max(COMPACT_ROW_PX, COMPACT_ROW_TEXT_REM * remPx);
  if (entry.agentSpawn && layout.tier !== "phone") return AGENT_SPAWN_ROW_REM * remPx;
  if ((entry.changedFiles?.length ?? 0) > 1) {
    return Math.max(
      rowPx,
      COMPACT_ROW_TEXT_REM * remPx + MULTI_FILE_EDIT_EXTRA_REM * remPx + MULTI_FILE_EDIT_EXTRA_PX,
    );
  }
  return rowPx;
}

function estimateWorkRow(
  row: Extract<MessagesTimelineRow, { kind: "work" }>,
  layout: TimelineRowLayout,
): number {
  const { remPx } = layout;
  const entries = row.groupedEntries;
  let height = ROW_PAD_WORK_REM * remPx;
  if (entries.some((entry) => entry.tone !== "tool")) {
    height += WORK_LABEL_PX + WORK_LABEL_GAP_REM * remPx;
  }
  for (const entry of entries) height += estimateWorkEntryHeight(entry, layout);
  return height + Math.max(0, entries.length - 1) * WORK_ENTRY_GAP_REM * remPx;
}

function estimateChapterRow(
  row: Extract<MessagesTimelineRow, { kind: "chapter" }>,
  layout: TimelineRowLayout,
): number {
  const { remPx } = layout;
  const rowPx = Math.max(COMPACT_ROW_PX, COMPACT_ROW_TEXT_REM * remPx);
  const padding = (row.isLastInTurn ? CHAPTER_LAST_PADDING_REM : CHAPTER_PADDING_REM) * remPx;
  const live = row.status === "active";
  if (!live && !row.expanded) return padding + rowPx;
  const showAll = !live || row.stepsExpanded;
  const steps = showAll ? row.entries.length : Math.min(row.entries.length, CHAPTER_TICKER_WINDOW);
  const hiddenSteps = row.entries.length - Math.min(row.entries.length, CHAPTER_TICKER_WINDOW);
  return (
    padding +
    CHAPTER_BODY_PADDING_REM * remPx +
    (row.message
      ? estimateMarkdownHeight(
          row.message.text,
          layout.rowWidthPx - CHAPTER_INDENT_PX - CHAPTER_MESSAGE_INLINE_REM * remPx,
          remPx,
        )
      : 0) +
    (live && hiddenSteps > 0 ? CHAPTER_EARLIER_TOGGLE_REM * remPx : 0) +
    steps * rowPx +
    Math.max(CHAPTER_TALLY_ROW_PX, 12 * BODY_LINE_HEIGHT)
  );
}

function estimateProposedPlanRow(
  row: Extract<MessagesTimelineRow, { kind: "proposed-plan" }>,
  layout: TimelineRowLayout,
): number {
  const { remPx } = layout;
  const cardPadding =
    (layout.tier === "phone" ? PLAN_CARD_PADDING_PHONE_REM : PLAN_CARD_PADDING_REM) * remPx;
  const contentWidth =
    layout.rowWidthPx - ASSISTANT_PADDING_INLINE_REM * remPx - cardPadding - PLAN_CARD_BORDER_PX;
  const plan = row.proposedPlan.planMarkdown;
  const collapsible = isProposedPlanCollapsible(plan);
  const content = collapsible
    ? Math.min(
        PLAN_CARD_COLLAPSED_MAX_REM * remPx,
        estimateMarkdownHeight(
          buildCollapsedProposedPlanPreviewMarkdown(plan, { maxLines: 10 }),
          contentWidth,
          remPx,
        ),
      ) +
      PLAN_CARD_TOGGLE_REM * remPx
    : estimateMarkdownHeight(stripDisplayedPlanMarkdown(plan), contentWidth, remPx);
  return (
    ROW_PAD_REM * remPx +
    ASSISTANT_PADDING_BLOCK_REM * remPx +
    PLAN_CARD_BORDER_PX +
    cardPadding +
    PLAN_CARD_HEADER_REM * remPx +
    content
  );
}

function estimateHtmlRenderRow(
  row: Extract<MessagesTimelineRow, { kind: "html-render" }>,
  layout: TimelineRowLayout,
): number {
  const { remPx } = layout;
  const width = layout.rowWidthPx - ASSISTANT_PADDING_INLINE_REM * remPx;
  return (
    ROW_PAD_COMPACT_REM * remPx +
    htmlRenderFrameHeight(row.htmlRender, width) +
    estimateChangedFilesHeight(row.assistantTurnDiffSummary, remPx) +
    (row.forkFrom !== undefined && layout.tier !== "phone" ? PAGE_FORK_ROW_REM * remPx : 0)
  );
}

function estimateUserInputExchangeRow(
  row: Extract<MessagesTimelineRow, { kind: "user-input-exchange" }>,
  layout: TimelineRowLayout,
): number {
  const { remPx } = layout;
  const { exchange } = row;
  const proseFontPx = PROSE_FONT_REM * remPx;
  const lineHeightPx = proseFontPx * PROSE_LINE_HEIGHT;
  const charPx = proseFontPx * SANS_GLYPH_EM;
  const textWidth =
    layout.rowWidthPx * USER_BUBBLE_WIDTH_RATIO - BUBBLE_PADDING_INLINE_REM * remPx - 2;
  const gapPx = EXCHANGE_GAP_REM * remPx;
  let height = ROW_PAD_REM * remPx + EXCHANGE_TIMESTAMP_PX + exchange.questions.length * gapPx;
  for (const question of exchange.questions) {
    height +=
      BUBBLE_PADDING_BLOCK_REM * remPx +
      2 +
      Math.max(EXCHANGE_HEADER_PX, 0.875 * remPx) +
      EXCHANGE_QUESTION_GAP_REM * remPx +
      estimatePreWrapLines(question.question, textWidth, charPx) * lineHeightPx;
    if (question.options.length > 0) {
      let optionChars = 0;
      for (const option of question.options) optionChars += option.length + 4;
      const optionRows = Math.max(1, Math.ceil((optionChars * 11 * SANS_GLYPH_EM) / textWidth));
      height += EXCHANGE_OPTIONS_GAP_REM * remPx + optionRows * EXCHANGE_OPTION_ROW_PX;
    }
    if (!exchange.cancelled) {
      height +=
        gapPx +
        BUBBLE_PADDING_BLOCK_REM * remPx +
        estimatePreWrapLines(question.answer ?? "No answer", textWidth, charPx) * lineHeightPx;
    }
  }
  return height;
}

/** Best-effort height of a row before it renders. A measurement always replaces it. */
export function estimateTimelineRowHeight(
  row: MessagesTimelineRow,
  layout: TimelineRowLayout,
): number {
  const { remPx } = layout;
  const compactRowPx = Math.max(COMPACT_ROW_PX, COMPACT_ROW_TEXT_REM * remPx);
  let height: number;
  switch (row.kind) {
    case "message":
      height =
        row.message.role === "user"
          ? estimateUserMessage(row, layout)
          : row.message.role === "assistant"
            ? estimateAssistantMessage(row, layout)
            : ROW_PAD_REM * remPx;
      break;
    case "work":
      height = estimateWorkRow(row, layout);
      break;
    case "work-toggle":
      height = compactRowPx + ROW_PAD_COMPACT_REM * remPx;
      break;
    case "turn-fold":
      height = COMPACT_ROW_PX + (TURN_FOLD_PADDING_REM + ROW_PAD_REM) * remPx;
      break;
    case "working":
      height = 2 * COMPACT_ROW_PX + (WORKING_PADDING_REM + ROW_PAD_REM) * remPx;
      break;
    case "chapter":
      height = estimateChapterRow(row, layout);
      break;
    case "proposed-plan":
      height = estimateProposedPlanRow(row, layout);
      break;
    case "html-render":
      height = estimateHtmlRenderRow(row, layout);
      break;
    case "user-input-exchange":
      height = estimateUserInputExchangeRow(row, layout);
      break;
    case "context-compaction":
      height = CONTEXT_COMPACTION_REM * remPx + CONTEXT_COMPACTION_PX;
      break;
    case "context-handoff":
      height = CONTEXT_HANDOFF_REM * remPx;
      break;
    case "fork-origin":
      // The frozen phone tier renders no divider, only the row's padding.
      height = layout.tier === "phone" ? ROW_PAD_REM * remPx : FORK_ORIGIN_REM * remPx;
      break;
    default:
      row satisfies never;
      height = MIN_ROW_HEIGHT_PX;
  }
  if (!Number.isFinite(height)) return MIN_ROW_HEIGHT_PX;
  return Math.round(Math.min(MAX_ROW_HEIGHT_PX, Math.max(MIN_ROW_HEIGHT_PX, height)));
}

// ---------------------------------------------------------------------------
// Validity of a remembered height
// ---------------------------------------------------------------------------

/**
 * Rows still changing on their own (streaming, running, live). They are estimated but never
 * remembered, so a stream does not churn the memory.
 */
export function isLiveTimelineRow(row: MessagesTimelineRow): boolean {
  switch (row.kind) {
    case "working":
      return true;
    case "message":
      return row.message.streaming;
    case "chapter":
      return row.status === "active";
    case "turn-fold":
      return row.status === "running";
    case "work":
      return row.groupedEntries.some((entry) => entry.completed === false);
    default:
      return false;
  }
}

/**
 * Rows whose height depends on state that resets when the timeline mounts again, so a
 * height they measured does not describe their next mount: a long plan's "Expand plan"
 * and a long changed-files list's "Show more" live in component state.
 */
export function isRememberableTimelineRow(row: MessagesTimelineRow): boolean {
  if (isLiveTimelineRow(row)) return false;
  switch (row.kind) {
    case "proposed-plan":
      return !isProposedPlanCollapsible(row.proposedPlan.planMarkdown);
    case "message":
    case "html-render":
      return (row.assistantTurnDiffSummary?.files.length ?? 0) <= MAX_VISIBLE_CHANGED_FILES;
    default:
      return true;
  }
}

const signatures = new WeakMap<MessagesTimelineRow, string>();

/**
 * A cheap fingerprint of what a row's height depends on (from the row object only). A
 * remembered height is reused only while its row's fingerprint is unchanged. Memoized per
 * row object: rows are structurally shared while a timeline stays mounted.
 */
export function timelineRowHeightSignature(row: MessagesTimelineRow): string {
  const cached = signatures.get(row);
  if (cached !== undefined) return cached;
  const signature = computeSignature(row);
  signatures.set(row, signature);
  return signature;
}

function computeSignature(row: MessagesTimelineRow): string {
  switch (row.kind) {
    case "message": {
      const { message } = row;
      return [
        "m",
        message.role,
        message.text.length,
        message.attachments?.length ?? 0,
        message.streaming ? 1 : 0,
        row.showAssistantCopyButton ? 1 : 0,
        row.assistantTurnDiffSummary?.files.length ?? -1,
        row.turnHtmlRenders?.length ?? 0,
        message.completedAt ? 1 : 0,
        row.forkFrom ? 1 : 0,
        row.revertTurnCount === undefined ? 0 : 1,
        message.dispatchMode === "steer" ? 1 : 0,
      ].join("|");
    }
    case "work": {
      const entries = row.groupedEntries;
      let completed = 0;
      let changedFiles = 0;
      let spawns = 0;
      for (const entry of entries) {
        if (entry.completed) completed += 1;
        changedFiles += entry.changedFiles?.length ?? 0;
        if (entry.agentSpawn) spawns += 1;
      }
      return `w|${entries.length}|${entries.at(-1)?.id ?? ""}|${completed}|${changedFiles}|${spawns}`;
    }
    case "turn-fold":
      return `f|${row.status}|${row.expanded ? 1 : 0}|${row.label ?? ""}`;
    case "work-toggle":
      return `t|${row.expanded ? 1 : 0}|${row.hiddenCount}|${row.summary?.label ?? ""}`;
    case "chapter":
      return [
        "c",
        row.status,
        row.expanded ? 1 : 0,
        row.stepsExpanded ? 1 : 0,
        row.entries.length,
        row.message?.text.length ?? -1,
        row.isLastInTurn ? 1 : 0,
      ].join("|");
    case "proposed-plan":
      return `p|${row.proposedPlan.planMarkdown.length}`;
    case "html-render":
      return [
        "h",
        row.attachment.id,
        row.htmlRender.height,
        row.htmlRender.heights?.length ?? 0,
        row.assistantTurnDiffSummary?.files.length ?? -1,
        row.forkFrom ? 1 : 0,
      ].join("|");
    case "user-input-exchange": {
      let chars = 0;
      for (const question of row.exchange.questions) {
        chars += question.question.length + (question.answer?.length ?? -1);
      }
      return `u|${row.exchange.questions.length}|${row.exchange.cancelled ? 1 : 0}|${chars}`;
    }
    case "context-compaction":
    case "context-handoff":
    case "fork-origin":
      return `k|${row.kind}`;
    case "working":
      return "";
    default:
      row satisfies never;
      return "";
  }
}

// ---------------------------------------------------------------------------
// Memory of measured heights
// ---------------------------------------------------------------------------

/** Approximate retained bytes per remembered row (key, entry, signature string). */
const ROW_BYTES = 160;

interface RememberedRowHeight {
  readonly height: number;
  readonly signature: string;
}

/** The remembered heights of one thread at one layout. */
export interface TimelineRowHeightBucket {
  readonly key: string;
  readonly rows: Map<string, RememberedRowHeight>;
}

export interface TimelineRowHeightStats {
  readonly buckets: number;
  readonly rows: number;
  /** `remember` calls that stored a height. */
  readonly writes: number;
  /** Of those, the ones that replaced a different height or signature for the same row. */
  readonly rewrites: number;
  readonly hits: number;
  readonly misses: number;
  /** Size reports the timeline received: rows laid out at a height they did not measure. */
  readonly corrections: number;
}

export interface TimelineRowHeightMemory {
  /**
   * The bucket for a thread at a layout, marked recently used. A layout nothing was
   * remembered at gets an empty bucket that takes no slot until `remember` stores a row.
   */
  openBucket(threadKey: string, layoutKey: string): TimelineRowHeightBucket;
  /** A remembered height, or undefined when none matches the row's signature. */
  read(bucket: TimelineRowHeightBucket, rowId: string, signature: string): number | undefined;
  /**
   * Stores a row's height in the bucket kept under `bucket`'s key and returns that bucket:
   * the caller's own, or the one another timeline opened after the caller's was evicted.
   */
  remember(
    bucket: TimelineRowHeightBucket,
    rowId: string,
    height: number,
    signature: string,
  ): TimelineRowHeightBucket;
  /** Counts one size report (see `TimelineRowHeightStats.corrections`). */
  noteCorrection(): void;
  stats(): TimelineRowHeightStats;
  clear(): void;
}

export interface TimelineRowHeightMemoryOptions {
  /** Thread layouts kept (default 96). */
  readonly maxBuckets?: number;
  /** Rows kept across all buckets (default 16,384, about 2.6 MB). */
  readonly maxRows?: number;
  /** Rows kept per bucket, least recently used first out (default 2,048). */
  readonly maxRowsPerBucket?: number;
}

export function createTimelineRowHeightMemory(
  options: TimelineRowHeightMemoryOptions = {},
): TimelineRowHeightMemory {
  const maxBuckets = options.maxBuckets ?? 96;
  const maxRows = options.maxRows ?? 16_384;
  const maxRowsPerBucket = options.maxRowsPerBucket ?? 2_048;
  const buckets = new LRUCache<TimelineRowHeightBucket>(maxBuckets, maxRows * ROW_BYTES);
  let writes = 0;
  let rewrites = 0;
  let hits = 0;
  let misses = 0;
  let corrections = 0;

  const bucketKey = (threadKey: string, layoutKey: string) => `${threadKey}\u0000${layoutKey}`;
  const account = (bucket: TimelineRowHeightBucket) =>
    buckets.set(bucket.key, bucket, bucket.rows.size * ROW_BYTES);

  return {
    openBucket(threadKey, layoutKey) {
      const key = bucketKey(threadKey, layoutKey);
      // Not stored yet: a width a timeline only passes through must not evict a thread.
      return buckets.get(key) ?? { key, rows: new Map() };
    },
    read(bucket, rowId, signature) {
      const entry = bucket.rows.get(rowId);
      if (entry === undefined || entry.signature !== signature) {
        misses += 1;
        return undefined;
      }
      // Least recently used first out: a thread opened again reads its rows, end included.
      bucket.rows.delete(rowId);
      bucket.rows.set(rowId, entry);
      hits += 1;
      return entry.height;
    },
    remember(callerBucket, rowId, height, signature) {
      if (!Number.isFinite(height) || !(height > 0) || height > MAX_ROW_HEIGHT_PX) {
        return callerBucket;
      }
      // Another timeline may have opened (and filled) a new bucket under this key after the
      // caller's was evicted; writing the caller's back would drop that one's rows.
      const bucket = buckets.get(callerBucket.key) ?? callerBucket;
      const previous = bucket.rows.get(rowId);
      writes += 1;
      if (
        previous !== undefined &&
        (previous.height !== height || previous.signature !== signature)
      ) {
        rewrites += 1;
      }
      bucket.rows.delete(rowId);
      bucket.rows.set(rowId, { height, signature });
      while (bucket.rows.size > maxRowsPerBucket) {
        const oldest = bucket.rows.keys().next();
        if (oldest.done) break;
        bucket.rows.delete(oldest.value);
      }
      // Re-set so the bucket's growth is accounted and it counts as recently used.
      account(bucket);
      return bucket;
    },
    noteCorrection() {
      corrections += 1;
    },
    stats() {
      return {
        buckets: buckets.size,
        rows: Math.round(buckets.retainedBytes / ROW_BYTES),
        writes,
        rewrites,
        hits,
        misses,
        corrections,
      };
    },
    clear() {
      buckets.clear();
      writes = 0;
      rewrites = 0;
      hits = 0;
      misses = 0;
      corrections = 0;
    },
  };
}

/** The app's memory: module state, so it lives as long as the page and nothing persists. */
export const timelineRowHeightMemory: TimelineRowHeightMemory = createTimelineRowHeightMemory();
