/**
 * The hold a capped `ryco_create_threads` request puts on a task waiting for a free slot, as both
 * the node (`delegationSlotHold.ts`) and clients (the queue badge) tell it from other holds. Its
 * own module, so a client's boot does not carry it.
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
