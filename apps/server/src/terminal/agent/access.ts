/**
 * Who may use which terminal through `ryco_terminal`. Pure, so the rules are unit-tested.
 *
 * - An agent uses only terminals of its own thread; other threads' terminals stay readable
 *   through `ryco_inspect_thread`, as before.
 * - Terminals the agent opened (ids starting with {@link AGENT_TERMINAL_ID_PREFIX}) are its own:
 *   reading, typing, running and closing need nothing more.
 * - A terminal the user opened is readable, as it already was; typing into it (run, send,
 *   interrupt) needs the user's consent for the current task, which a Full access thread has
 *   without asking (it can run anything in a shell anyway). A decline holds for the rest of the
 *   task and a cooldown after it, so the agent cannot ask again and again. Only the user closes it.
 *
 * @module terminal/agent/access
 */

import { AGENT_TERMINAL_ID_PREFIX } from "@ryco/contracts";

export { AGENT_TERMINAL_ID_PREFIX };

/** After a decline, a new task of the same thread asks again only after this long. */
export const CONSENT_REFUSAL_COOLDOWN_MS = 10 * 60_000;

export const isAgentTerminalId = (terminalId: string): boolean =>
  terminalId.startsWith(AGENT_TERMINAL_ID_PREFIX);

export type TerminalUse = "read" | "control" | "close";

export type ConsentStatus = "granted" | "pending" | "declined" | "none";

export interface AccessSubject {
  readonly callerThreadId: string;
  readonly terminalThreadId: string;
  readonly terminalId: string;
  readonly fullAccess: boolean;
  /** The user's answer for this task and terminal. */
  readonly consent: ConsentStatus;
  /** Until when an earlier decline (another task) still refuses, as clock milliseconds. */
  readonly refusedUntil: number | undefined;
  readonly now: number;
}

export type AccessDecision =
  | { readonly kind: "allowed" }
  | { readonly kind: "ask" }
  | { readonly kind: "pending" }
  | {
      readonly kind: "denied";
      readonly reason: "other-thread" | "user-terminal-close" | "declined" | "cooldown";
    };

export function decideTerminalAccess(subject: AccessSubject, use: TerminalUse): AccessDecision {
  if (subject.callerThreadId !== subject.terminalThreadId) {
    return { kind: "denied", reason: "other-thread" };
  }
  if (isAgentTerminalId(subject.terminalId) || use === "read") return { kind: "allowed" };
  if (use === "close") return { kind: "denied", reason: "user-terminal-close" };
  if (subject.fullAccess || subject.consent === "granted") return { kind: "allowed" };
  if (subject.consent === "declined") return { kind: "denied", reason: "declined" };
  if (subject.consent === "pending") return { kind: "pending" };
  if (subject.refusedUntil !== undefined && subject.refusedUntil > subject.now) {
    return { kind: "denied", reason: "cooldown" };
  }
  return { kind: "ask" };
}
