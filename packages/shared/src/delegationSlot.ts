/**
 * The holds a capped `ryco_create_threads` request puts on its tasks (one waiting for a free
 * slot, and one its delegating chat gave up before it started), as both the node
 * (`delegationSlotHold.ts`) and clients (the queue badge) tell them from other holds. Its own
 * module, so a client's boot does not carry it.
 *
 * @module delegationSlot
 */

/**
 * Cause keys of the hold a capped `ryco_create_threads` request (`maxConcurrent`) puts on a task
 * that waits for a free slot: `delegation-slot:<proposalId>`.
 */
export const DELEGATION_SLOT_CAUSE_PREFIX = "delegation-slot:";

/**
 * Whether only slot holds keep the queue: the node releases those itself, so nothing waits for
 * the person (and a restart adds no hold of its own).
 */
export const heldOnlyForDelegationSlot = (
  hold: { readonly causeKeys: ReadonlyArray<string> } | null | undefined,
): boolean =>
  hold != null &&
  hold.causeKeys.length > 0 &&
  hold.causeKeys.every((key) => key.startsWith(DELEGATION_SLOT_CAUSE_PREFIX));

/**
 * Cause keys of the hold that replaces a task's slot hold once its delegating chat gave it up
 * before it started: `delegation-given-up:<proposalId>`. A pause only a person's Resume ends.
 */
export const DELEGATION_GIVEN_UP_CAUSE_PREFIX = "delegation-given-up:";

/**
 * Whether only a given-up task's own pause keeps the queue. It already waits for the person's
 * Resume, so a restart adds no hold of its own: its banner keeps saying why it waits.
 */
export const heldOnlyAsGivenUpDelegation = (
  hold: { readonly causeKeys: ReadonlyArray<string> } | null | undefined,
): boolean =>
  hold != null &&
  hold.causeKeys.length > 0 &&
  hold.causeKeys.every((key) => key.startsWith(DELEGATION_GIVEN_UP_CAUSE_PREFIX));
