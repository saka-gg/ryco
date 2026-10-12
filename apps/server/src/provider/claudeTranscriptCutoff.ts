/**
 * Where a Claude transcript can be cut so that it ends with a given Ryco turn.
 *
 * A Ryco turn id is the uuid of the user prompt that opened it, so a turn's prompt can be found
 * in the session's main chain (oldest first, subagent sidechains excluded). A turn ends at the
 * entry just before the next turn's prompt: its tool results, steering and system entries stay
 * with it. Shared by checkpoint revert (resume truncated before the first dropped prompt) and
 * forks (copy the transcript up to the end of the selected turn).
 *
 * Pure functions over uuids.
 */

/** Position of the transcript entry just before a prompt. */
export type ClaudeChainPositionBeforePrompt =
  /** The prompt is not in this chain. */
  | { readonly kind: "missing" }
  /** The prompt opens the chain: nothing comes before it. */
  | { readonly kind: "chain-start" }
  | { readonly kind: "entry"; readonly uuid: string };

export function claudeEntryBeforePrompt(
  chainUuids: ReadonlyArray<string>,
  promptUuid: string,
): ClaudeChainPositionBeforePrompt {
  const index = chainUuids.indexOf(promptUuid);
  if (index < 0) return { kind: "missing" };
  if (index === 0) return { kind: "chain-start" };
  return { kind: "entry", uuid: chainUuids[index - 1]! };
}

/** Where a turn ends in a main chain. */
export interface ClaudeTurnCutoff {
  /** The turn's last main-chain entry. */
  readonly uuid: string;
  /** Its position in the chain. */
  readonly index: number;
  /**
   * No later turn bounds the cutoff: it is the chain's tail as read. A transcript keeps growing,
   * so a tail only ends the turn when nothing can have been appended after it before the read
   * (callers prove that); it must never be read again later and trusted.
   */
  readonly atTail: boolean;
}

/**
 * The last main-chain entry of the turn opened by `turnPromptUuid`, or null when the chain does
 * not prove where that turn ends:
 * - the turn's prompt is not in the chain (an older native session, an imported turn, a turn
 *   Claude opened without a prompt);
 * - a later Ryco turn is missing from the chain, so entries after the prompt cannot be
 *   attributed (a wake turn has no prompt; its output would otherwise be kept);
 * - a later turn's prompt comes before this one (the chain was rewritten).
 *
 * `laterTurnIds` are the thread's turns after the selected one, oldest first. With none, the
 * cutoff is the chain's tail (`atTail`).
 */
export function claudeTurnCutoff(input: {
  readonly chainUuids: ReadonlyArray<string>;
  readonly turnPromptUuid: string;
  readonly laterTurnIds: ReadonlyArray<string>;
}): ClaudeTurnCutoff | null {
  const { chainUuids } = input;
  const promptIndex = chainUuids.indexOf(input.turnPromptUuid);
  if (promptIndex < 0) return null;
  let nextPromptIndex = Number.POSITIVE_INFINITY;
  for (const laterTurnId of input.laterTurnIds) {
    const index = chainUuids.indexOf(laterTurnId);
    if (index <= promptIndex) return null;
    nextPromptIndex = Math.min(nextPromptIndex, index);
  }
  if (nextPromptIndex === Number.POSITIVE_INFINITY) {
    const index = chainUuids.length - 1;
    return { uuid: chainUuids[index]!, index, atTail: true };
  }
  // The later prompt comes after this turn's prompt, so an entry precedes it.
  const index = nextPromptIndex - 1;
  return { uuid: chainUuids[index]!, index, atTail: false };
}

/**
 * Whether a cutoff pinned from an earlier read still ends the turn in `chainUuids`: the entry is
 * still at its position, with the turn's prompt at or before it. Appending later turns keeps it;
 * a rewritten chain (e.g. a rewind that dropped the entry) does not.
 */
export function isClaudeCutoffInChain(input: {
  readonly chainUuids: ReadonlyArray<string>;
  readonly turnPromptUuid: string;
  readonly cutoff: { readonly uuid: string; readonly index: number };
}): boolean {
  const { chainUuids, cutoff } = input;
  if (chainUuids[cutoff.index] !== cutoff.uuid) return false;
  const promptIndex = chainUuids.indexOf(input.turnPromptUuid);
  return promptIndex >= 0 && promptIndex <= cutoff.index;
}
