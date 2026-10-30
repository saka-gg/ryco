import type { EnvironmentId } from "@ryco/contracts";

import type { SavedEnvironmentRecord } from "./catalog.ts";

/**
 * Hub-linked direct access, the client half
 * (`docs/superpowers/specs/2026-10-14-hub-linked-direct-access-design.md`).
 *
 * A native client connected to a node over a trusted Hub relay channel asks it
 * for a one-time code, finds which of the node's direct endpoints answers as
 * that same node and proves it holds the node identity key the relay channel
 * verified, and redeems the code there like a pasted pairing link. The node's
 * linked session lives four days; the client links again through the relay
 * well before then.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Link again once the stored direct credential is this old: within its four days. */
export const HUB_LINKED_DIRECT_ACCESS_RENEW_AFTER_MS = 3 * DAY_MS;

/**
 * Whether to ask a node for direct access now. A saved environment the user
 * paired by hand is theirs and never replaced; one linked through another Hub
 * machine id, linked long enough ago, or linked before the identity proof
 * existed (no key to prove its address against), is due.
 */
export function hubLinkedDirectAccessDue(input: {
  readonly hubEnvironmentId: string;
  readonly records: ReadonlyArray<SavedEnvironmentRecord>;
  readonly nowMs: number;
}): boolean {
  const linked = input.records.find(
    (record) => record.hubLink?.hubEnvironmentId === input.hubEnvironmentId,
  );
  if (linked?.hubLink === undefined) return true;
  if (linked.hubLink.nodeIdentityPublicKey === undefined) return true;
  const linkedAtMs = Date.parse(linked.hubLink.linkedAt);
  return (
    !Number.isFinite(linkedAtMs) ||
    input.nowMs - linkedAtMs >= HUB_LINKED_DIRECT_ACCESS_RENEW_AFTER_MS
  );
}

/** A saved environment for this direct id that was paired by hand, not linked. */
export function isManuallyPairedEnvironment(
  records: ReadonlyArray<SavedEnvironmentRecord>,
  environmentId: EnvironmentId,
): boolean {
  return records.some(
    (record) => record.environmentId === environmentId && record.hubLink === undefined,
  );
}
