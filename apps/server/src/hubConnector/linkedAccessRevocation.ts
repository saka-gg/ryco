/**
 * linkedAccessRevocation - how the node ends Hub-linked direct access: a device's (or every)
 * linked session and unredeemed linked code.
 *
 * Codes go first, then sessions. Redeeming a code is two steps (the code is consumed, then its
 * session is issued), so a code consumed just before the codes went can still turn into a
 * session after the sessions went: a second sweep of the sessions a few seconds later ends it. A
 * failed attempt is retried a bounded number of times before it is logged and left to the next
 * trigger.
 *
 * @module hubConnector/linkedAccessRevocation
 */
import { Duration, Effect } from "effect";

/** Waits before the second and third attempt after a failure. */
export const LINKED_REVOCATION_RETRY_DELAYS_MS: ReadonlyArray<number> = [1_000, 5_000];
/** When the sessions are swept once more, for a code that was redeemed during the revocation. */
export const LINKED_REVOCATION_RESWEEP_MS = 5_000;

export interface LinkedAccessRevocationSteps<E1, E2> {
  readonly revokeCodes: Effect.Effect<void, E1>;
  readonly revokeSessions: Effect.Effect<void, E2>;
}

const withRetries = <E>(
  attempt: Effect.Effect<void, E>,
  delaysMs: ReadonlyArray<number>,
  what: string,
): Effect.Effect<void> =>
  attempt.pipe(
    Effect.catchCause((cause) => {
      const [delayMs, ...rest] = delaysMs;
      return delayMs === undefined
        ? Effect.logError(`Failed to ${what}`, { cause })
        : Effect.logWarning(`Failed to ${what}; retrying`, { cause, retryInMs: delayMs }).pipe(
            Effect.andThen(Effect.sleep(Duration.millis(delayMs))),
            Effect.andThen(withRetries(attempt, rest, what)),
          );
    }),
  );

/**
 * The revocation itself (codes, then sessions, retried), and the later sweep of the sessions.
 * Run the first and wait for it; run the second in the background.
 */
export const linkedAccessRevocation = <E1, E2>(steps: LinkedAccessRevocationSteps<E1, E2>) => ({
  now: withRetries(
    steps.revokeCodes.pipe(Effect.andThen(steps.revokeSessions)),
    LINKED_REVOCATION_RETRY_DELAYS_MS,
    "revoke Hub-linked direct sessions",
  ),
  resweep: Effect.sleep(Duration.millis(LINKED_REVOCATION_RESWEEP_MS)).pipe(
    Effect.andThen(
      withRetries(
        steps.revokeSessions,
        LINKED_REVOCATION_RETRY_DELAYS_MS,
        "sweep Hub-linked direct sessions again",
      ),
    ),
  ),
});
