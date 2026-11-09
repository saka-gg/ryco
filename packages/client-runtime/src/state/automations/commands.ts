/**
 * How a client sends automation centre commands (save, cancel, retry, read):
 * the request id rule both the web's Automations dialog and the phone's
 * schedule screens follow.
 *
 * Every action is a new request: the server replays an earlier request id
 * whatever became of its proposal, so reusing one would silently repeat a
 * rejected or expired proposal. Only a retry of an attempt that got no answer
 * (the connection dropped) keeps its id, so it cannot land twice.
 */
import type { AutomationCentreCommand } from "@ryco/contracts";
import {
  AgentControlRequestId,
  type AgentControlProposalView,
} from "@ryco/contracts/agent-control";
import { isTagged } from "effect/Predicate";

type WithoutRequest<T> = T extends unknown ? Omit<T, "requestId"> : never;

/** A save, cancel, retry or read; the runner adds the request id. */
export type AutomationCommandDraft = WithoutRequest<AutomationCentreCommand>;

/** Said when a command failed without the server's own words. */
export const AUTOMATION_COMMAND_UNCONFIRMED =
  "The action could not be confirmed. Refresh before trying again.";

/** Said when an approval or rejection could not be confirmed. */
export const AUTOMATION_DECISION_UNCONFIRMED =
  "Approval could not be confirmed. Refresh to see the current decision.";

/** The server judged the command; any other failure may not have reached it. */
export function isAutomationServerAnswer(cause: unknown): boolean {
  return isTagged(cause, "AgentControlRpcError");
}

/** What a failed command says: the server's message, else that it could not be confirmed. */
export function automationCommandError(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : AUTOMATION_COMMAND_UNCONFIRMED;
}

export interface AutomationRequestIds {
  /** The request id for an action: a new one, or the unanswered attempt's for a retry. */
  readonly idFor: (input: AutomationCommandDraft) => AgentControlRequestId;
  /** The server answered the action (success or refusal): an identical one is new from now on. */
  readonly answered: (input: AutomationCommandDraft) => void;
  /**
   * The device's proposal queue changed: an attempt whose answer was lost but whose
   * proposal is there did land, so an identical action from now on is a new one.
   */
  readonly absorbQueue: (proposals: Iterable<AgentControlProposalView>) => void;
}

export function createAutomationRequestIds(newId: () => string): AutomationRequestIds {
  const unanswered = new Map<string, AgentControlRequestId>();
  const keyOf = (input: AutomationCommandDraft) => JSON.stringify(input);
  return {
    idFor: (input) => {
      const key = keyOf(input);
      const id = unanswered.get(key) ?? AgentControlRequestId.make(newId());
      unanswered.set(key, id);
      return id;
    },
    answered: (input) => {
      unanswered.delete(keyOf(input));
    },
    absorbQueue: (proposals) => {
      if (unanswered.size === 0) return;
      const landed = new Set<string>();
      for (const proposal of proposals) if (proposal.requestId) landed.add(proposal.requestId);
      for (const [key, id] of unanswered) if (landed.has(id)) unanswered.delete(key);
    },
  };
}

/**
 * Sends one command with its request id: the id is forgotten once the server
 * answered (or refused) it, and kept for a faithful retry when the answer was lost.
 */
export async function sendAutomationCommand(input: {
  readonly ids: AutomationRequestIds;
  readonly command: (command: AutomationCentreCommand) => Promise<unknown>;
  readonly draft: AutomationCommandDraft;
}): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> {
  const requestId = input.ids.idFor(input.draft);
  try {
    await input.command({ ...input.draft, requestId } as AutomationCentreCommand);
    input.ids.answered(input.draft);
    return { ok: true };
  } catch (cause) {
    if (isAutomationServerAnswer(cause)) input.ids.answered(input.draft);
    return { ok: false, error: automationCommandError(cause) };
  }
}
