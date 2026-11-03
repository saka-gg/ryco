/**
 * Per-task device-control consent: which `deviceControlConsent` proposal
 * answers for a thread's current task, and what the user decided.
 *
 * The proposal is the source of truth; this is a process-local index over it,
 * keyed on everything a consent is bound to (thread, provider turn, runtime
 * session, device), so a consent never crosses into another task, a restarted
 * runtime or another device. Request ids are derived from the same key, so
 * concurrent first calls replay one proposal, and an index entry lost to the
 * bound finds its proposal again.
 *
 * Loaded with the `ryco_device` tool (on first use, never at boot). One
 * instance per tool set.
 *
 * @module agentControl/deviceControlConsent
 */
import { createHash } from "node:crypto";

import type { AgentControlProposalId, AgentControlProposalStatus } from "@ryco/contracts";

export interface DeviceConsentKey {
  readonly threadId: string;
  readonly turnId: string;
  readonly runtimeSessionId: string;
  readonly udid: string;
}

/** "denied": the user declined; "unanswered": never approved, after every request expired or failed. */
export type DeviceConsentOutcome = "granted" | "denied" | "unanswered";

export interface DeviceConsentEntry {
  readonly key: DeviceConsentKey;
  readonly proposalId: AgentControlProposalId;
  /** Which request (1-based) this proposal answers; see `deviceConsentRequestId`. */
  readonly attempt: number;
  readonly outcome?: DeviceConsentOutcome;
}

/** A consent that expired or failed revalidation is asked for once more, then treated as declined. */
export const DEVICE_CONSENT_MAX_ATTEMPTS = 2;
/** Threads remembered at once; one task per thread. */
export const DEVICE_CONSENT_MAX_THREADS = 256;

const sameKey = (left: DeviceConsentKey, right: DeviceConsentKey): boolean =>
  left.threadId === right.threadId &&
  left.turnId === right.turnId &&
  left.runtimeSessionId === right.runtimeSessionId &&
  left.udid === right.udid;

/** What a consent proposal's status means for the task that asked. */
export type DeviceConsentState = "granted" | "denied" | "pending" | "ask-again";

/**
 * Only a completed consent grants: approved and executing are still being
 * revalidated by the executor, which can still fail the card (the task ended,
 * the device is shared now), and a grant pinned before that would outlive it.
 */
export const deviceConsentStateFor = (status: AgentControlProposalStatus): DeviceConsentState => {
  switch (status) {
    case "completed":
      return "granted";
    case "pending-user-approval":
    case "approved":
    case "executing":
      return "pending";
    case "rejected":
    case "cancelled":
      return "denied";
    case "expired":
    case "failed":
      return "ask-again";
  }
};

export class DeviceControlConsents {
  private readonly byThread = new Map<string, DeviceConsentEntry>();

  /** The entry for exactly this task and device, if any. */
  lookup(key: DeviceConsentKey): DeviceConsentEntry | undefined {
    const entry = this.byThread.get(key.threadId);
    return entry !== undefined && sameKey(entry.key, key) ? entry : undefined;
  }

  /** Remember the proposal that answers `key`; replaces the thread's previous task. */
  record(
    key: DeviceConsentKey,
    proposalId: AgentControlProposalId,
    attempt: number,
    outcome?: DeviceConsentOutcome,
  ): DeviceConsentEntry {
    const entry: DeviceConsentEntry = {
      key,
      proposalId,
      attempt,
      ...(outcome === undefined ? {} : { outcome }),
    };
    // Re-inserted so the map's order is oldest first.
    this.byThread.delete(key.threadId);
    this.byThread.set(key.threadId, entry);
    while (this.byThread.size > DEVICE_CONSENT_MAX_THREADS) {
      const oldest = this.byThread.keys().next();
      if (oldest.done === true) break;
      this.byThread.delete(oldest.value);
    }
    return entry;
  }

  /** Record the user's decision for the entry of exactly this task. */
  settle(key: DeviceConsentKey, outcome: DeviceConsentOutcome): void {
    const entry = this.lookup(key);
    if (entry === undefined) return;
    this.byThread.set(key.threadId, { ...entry, outcome });
  }
}

/** Deterministic per task, device and attempt; well under the 128-character request id cap. */
export const deviceConsentRequestId = (key: DeviceConsentKey, attempt: number): string =>
  `device-consent:${createHash("sha256")
    .update(
      [key.threadId, key.turnId, key.runtimeSessionId, key.udid, String(attempt)].join("\u0000"),
    )
    .digest("hex")
    .slice(0, 48)}`;
