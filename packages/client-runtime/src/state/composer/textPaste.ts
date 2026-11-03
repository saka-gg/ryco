import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@ryco/contracts/orchestration";
import { collectQuoteCitationTokens, expandQuoteCitations } from "@ryco/shared/quoteCitations";

/**
 * A text paste this large becomes a `text/plain` attachment instead of prompt text. Checked as
 * both characters and UTF-8 bytes: the character count understates what non-Latin text costs.
 *
 * The attachment reaches the provider as a path it reads with a tool, so the threshold stays high
 * enough that ordinary snippets (a stack trace, a function, a short log) remain inline where the
 * model sees them without a read. At 32 KiB (about 8k tokens) a paste is a document or a long log:
 * the agent can read only the parts it needs, the transcript keeps a short bubble, and the editor
 * stays responsive.
 */
export const PASTED_TEXT_ATTACHMENT_THRESHOLD = 32 * 1024;

export const PASTED_TEXT_MIME_TYPE = "text/plain";

const PASTED_TEXT_FILE_NAME = "pasted-text.txt";
const PASTED_TEXT_FILE_NAME_PATTERN = /^pasted-text(?:-\d+)?\.txt$/i;
// A UTF-16 code unit encodes to at most 3 UTF-8 bytes.
const MAX_UTF8_BYTES_PER_CODE_UNIT = 3;

export type PastedTextDisposition = "attachment" | "inline";

/** The parts of a key event (DOM or native) the paste shortcut is read from. */
export interface PasteShortcutKeyEvent {
  readonly key: string;
  /** The physical key, where the platform reports it. */
  readonly code?: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

/**
 * How long after the paste-as-text shortcut, or the desktop menu's announcement of it, a paste
 * still counts as made by it: the paste follows at once in a browser and after an IPC round trip
 * in Electron.
 */
export const PASTE_AS_TEXT_SHORTCUT_WINDOW_MS = 1_000;

/**
 * Cmd+Shift+V on macOS, Ctrl+Shift+V elsewhere: paste as text, never as an attachment. macOS
 * also has Cmd+Option+Shift+V, its Paste and Match Style; Option turns the key into another
 * character there, so that chord is read from the physical key.
 */
export function isPasteAsTextShortcut(event: PasteShortcutKeyEvent, macPlatform: boolean): boolean {
  if (!event.shiftKey) return false;
  if (!macPlatform) {
    return event.key.toLowerCase() === "v" && event.ctrlKey && !event.metaKey && !event.altKey;
  }
  if (!event.metaKey || event.ctrlKey) return false;
  return event.altKey ? event.code === "KeyV" : event.key.toLowerCase() === "v";
}

/**
 * How long `text` is as sent: a quote chip counts as the quote and comment it expands to
 * (`expandQuoteCitations`), not as its token, which percent-encoding makes up to nine times
 * longer. Paste checks measure the prompt, its selection and the paste this way.
 */
export function sentPromptTextLength(text: string): number {
  return expandQuoteCitations(text).length;
}

/**
 * Whether the prompt would outgrow what one message may carry once the paste replaces the
 * selection. Lengths are as sent (`sentPromptTextLength`), so a quote chip counts as its quote.
 */
export function wouldTextPasteExceedInputLimit(input: {
  readonly promptLength: number;
  readonly selectedLength: number;
  readonly pastedLength: number;
  readonly maxLength?: number;
}): boolean {
  const selectedLength = Math.max(0, Math.min(input.promptLength, input.selectedLength));
  return (
    input.promptLength - selectedLength + input.pastedLength >
    (input.maxLength ?? PROVIDER_SEND_TURN_MAX_INPUT_CHARS)
  );
}

function reachesAttachmentThreshold(text: string): boolean {
  if (text.length >= PASTED_TEXT_ATTACHMENT_THRESHOLD) return true;
  // Short enough that no encoding can reach the threshold: skip the encode.
  if (text.length * MAX_UTF8_BYTES_PER_CODE_UNIT < PASTED_TEXT_ATTACHMENT_THRESHOLD) return false;
  return new TextEncoder().encode(text).byteLength >= PASTED_TEXT_ATTACHMENT_THRESHOLD;
}

/** `text` without its quote tokens, or null when nothing but whitespace is left. */
function textAroundQuoteTokens(text: string): string | null {
  const tokens = collectQuoteCitationTokens(text);
  if (tokens.length === 0) return text;
  let rest = "";
  let cursor = 0;
  for (const token of tokens) {
    rest += text.slice(cursor, token.start);
    cursor = token.end;
  }
  rest += text.slice(cursor);
  return rest.trim().length > 0 ? rest : null;
}

/**
 * Where a text paste goes. It stays inline when the composer cannot take an attachment, or when
 * the user pasted with the paste-as-text shortcut; otherwise it folds into an attachment once it
 * reaches the threshold or would push the prompt past the input limit. Quote chips stay chips:
 * the threshold measures the text around them, and a paste of chips alone never folds.
 */
export function resolvePastedTextDisposition(input: {
  readonly text: string;
  readonly canAttach: boolean;
  readonly pasteAsText: boolean;
  readonly wouldExceedInputLimit: boolean;
}): PastedTextDisposition {
  if (input.pasteAsText || !input.canAttach || input.text.length === 0) return "inline";
  const foldable = textAroundQuoteTokens(input.text);
  if (foldable === null) return "inline";
  return input.wouldExceedInputLimit || reachesAttachmentThreshold(foldable)
    ? "attachment"
    : "inline";
}

/** `pasted-text.txt`, then `pasted-text-2.txt` and so on past the names already attached. */
export function nextPastedTextFileName(existingNames: ReadonlyArray<string>): string {
  const names = new Set(existingNames.map((name) => name.toLowerCase()));
  if (!names.has(PASTED_TEXT_FILE_NAME)) return PASTED_TEXT_FILE_NAME;
  for (let sequence = 2; ; sequence += 1) {
    const candidate = `pasted-text-${sequence}.txt`;
    if (!names.has(candidate)) return candidate;
  }
}

/** Whether an attachment is a folded paste, so it can read as pasted text. */
export function isPastedTextAttachment(attachment: {
  readonly name: string;
  readonly mimeType: string;
}): boolean {
  return (
    attachment.mimeType === PASTED_TEXT_MIME_TYPE &&
    PASTED_TEXT_FILE_NAME_PATTERN.test(attachment.name)
  );
}
