import { stripAttachmentPathLines } from "@ryco/shared/attachmentPrompt";
import { CLAUDE_PROMPT_EFFORT_PREFIX_PATTERN } from "@ryco/shared/model";

import { stripSelectionQuotes } from "./selectionQuote.ts";
import {
  ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
  PLAN_IMPLEMENTATION_PROMPT_PREFIX,
} from "./sendEngine.ts";
import { stripSentTerminalContexts } from "./terminalContext.ts";

// Prompt recall: ArrowUp in an empty composer brings back the prompts sent
// earlier in the thread, newest first. The entries come from the thread's own
// user messages when the key is pressed, so nothing new is stored or synced.

export interface PromptHistoryMessage {
  readonly id: string;
  readonly role: string;
  readonly text: string;
}

export interface PromptHistoryEntry {
  /** The message the prompt was sent as. */
  readonly id: string;
  readonly prompt: string;
}

/** The recalled entry the composer shows, and the exact text it put there. */
export interface PromptHistoryPosition {
  readonly entryId: string;
  readonly recalled: string;
}

export type PromptHistoryDirection = "backward" | "forward";

export interface PromptHistoryStep {
  /** Null once forward browsing has moved past the newest entry. */
  readonly position: PromptHistoryPosition | null;
  readonly prompt: string;
}

/**
 * The text the user typed for a sent message, without what the send added to it: attachment
 * path lines, terminal contexts and their inline labels, and quoted assistant text. Mentions,
 * skills and thread mentions stay: the prompt text alone carries them, so the composer shows them
 * as chips again. So does a Claude `Ultrathink:` prefix: in the composer it is text the effort
 * menu writes, and it is what selects Ultrathink again. App-composed sends recall as nothing.
 */
export function recallablePrompt(messageText: string): string {
  const sent = stripAttachmentPathLines(messageText.trim());
  const effortPrefix = CLAUDE_PROMPT_EFFORT_PREFIX_PATTERN.exec(sent)?.[0] ?? "";
  const body = sent.slice(effortPrefix.length);
  if (body === ATTACHMENT_ONLY_BOOTSTRAP_PROMPT) return "";
  if (body.startsWith(PLAN_IMPLEMENTATION_PROMPT_PREFIX)) return "";
  const typed = stripSelectionQuotes(stripSentTerminalContexts(body)).trim();
  return typed.length > 0 ? `${effortPrefix}${typed}` : "";
}

// By message object: messages keep their identity across timeline updates, and a held ArrowUp
// rebuilds the entries on every repeat, so each message is parsed once.
const recallablePromptByMessage = new WeakMap<
  PromptHistoryMessage,
  { readonly text: string; readonly prompt: string }
>();

function recallablePromptOf(message: PromptHistoryMessage): string {
  const text = message.text;
  const cached = recallablePromptByMessage.get(message);
  if (cached?.text === text) return cached.prompt;
  const prompt = recallablePrompt(text);
  recallablePromptByMessage.set(message, { text, prompt });
  return prompt;
}

/** The thread's recallable prompts, oldest first, with repeats of the same prompt collapsed. */
export function buildPromptHistoryEntries(
  messages: ReadonlyArray<PromptHistoryMessage>,
): PromptHistoryEntry[] {
  const entries: PromptHistoryEntry[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    const prompt = recallablePromptOf(message);
    if (prompt.length === 0) continue;
    const previous = entries.at(-1);
    if (previous?.prompt === prompt) {
      entries[entries.length - 1] = { id: message.id, prompt };
      continue;
    }
    entries.push({ id: message.id, prompt });
  }
  return entries;
}

function activeEntryIndex(
  entries: ReadonlyArray<PromptHistoryEntry>,
  position: PromptHistoryPosition,
): number {
  const byId = entries.findIndex((entry) => entry.id === position.entryId);
  if (byId >= 0) return byId;
  // The message was replaced since (an optimistic send that the server confirmed under the
  // same text): find the prompt instead.
  return entries.findLastIndex((entry) => entry.prompt === position.recalled);
}

/**
 * One ArrowUp (backward) or ArrowDown (forward) through the history. Browsing is active only
 * while the composer still shows the recalled text unedited; backward starts from an empty
 * composer at the newest entry, and forward past the newest entry restores the empty composer.
 * Null means the key is not for history and keeps its usual meaning.
 */
export function stepPromptHistory(input: {
  readonly direction: PromptHistoryDirection;
  readonly entries: ReadonlyArray<PromptHistoryEntry>;
  readonly position: PromptHistoryPosition | null;
  readonly currentPrompt: string;
}): PromptHistoryStep | null {
  const { entries, position, currentPrompt } = input;
  const activeIndex =
    position !== null && position.recalled === currentPrompt
      ? activeEntryIndex(entries, position)
      : -1;
  if (input.direction === "backward") {
    if (activeIndex < 0 && currentPrompt.length > 0) return null;
    const entry = entries[activeIndex < 0 ? entries.length - 1 : activeIndex - 1];
    if (!entry) return null;
    return { position: { entryId: entry.id, recalled: entry.prompt }, prompt: entry.prompt };
  }
  if (activeIndex < 0) return null;
  const entry = entries[activeIndex + 1];
  if (!entry) return { position: null, prompt: "" };
  return { position: { entryId: entry.id, recalled: entry.prompt }, prompt: entry.prompt };
}
