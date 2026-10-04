import type { HostedSessionAdmissionState } from "./capabilities.ts";

export interface HostedDeliveryNotice {
  readonly title: string;
  readonly description: string;
  readonly actionLabel: string;
  /** False until the replacement session has accepted a current snapshot. */
  readonly canAcknowledge: boolean;
}

/**
 * The inline notice for an environment whose last connection dropped while a
 * non-replayable action was in flight. It sits on the thread itself — the place
 * the user would otherwise retry from — rather than in a connection menu, and
 * both clients render this one copy.
 *
 * Reads never produce it, being harmless to lose, and orchestration commands
 * only when their one replay by id could not confirm them. What remains
 * (terminal input, git and file writes, Agent Control decisions) is never
 * resent automatically, so the user checks the result and continues; until
 * then that machine refuses new mutations while reads keep working.
 */
export function resolveHostedDeliveryNotice(
  state: HostedSessionAdmissionState,
  machineLabel?: string | null,
): HostedDeliveryNotice | null {
  if (state.sessionStatus !== "delivery-unknown") return null;
  const machine = machineLabel?.trim() || "this machine";
  const recovered = state.sessionRecoveredAfterUnknown;
  return {
    title: "An action may not have reached the machine",
    description: recovered
      ? `The connection dropped before ${machine} confirmed it, and Ryco doesn't resend actions like this on its own. Check the result, then continue.`
      : `The connection dropped before ${machine} confirmed it. Ryco is reconnecting.`,
    actionLabel: recovered ? "Continue" : "Synchronizing…",
    canAcknowledge: recovered,
  };
}
