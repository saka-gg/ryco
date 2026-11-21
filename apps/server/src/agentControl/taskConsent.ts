/**
 * Per-task consents: a proposal the user approves once for a thread's current task and one
 * subject (a device, a terminal), after which the routine actions it covers run directly.
 *
 * The proposal is the source of truth; {@link TaskConsents} is a process-local index over it,
 * keyed on everything a consent is bound to (thread, the task's user turn, runtime session,
 * subject), so a consent never crosses into another task, a restarted runtime or another
 * subject. Request ids are derived from the same key, so concurrent first calls replay one
 * proposal, and an index entry lost to the bound finds its proposal again.
 *
 * Shared by `ryco_device` (`deviceControlConsent`) and `ryco_terminal` (`terminalControlConsent`).
 *
 * @module agentControl/taskConsent
 */
import { createHash } from "node:crypto";

import type { AgentControlProposalId, AgentControlProposalStatus } from "@ryco/contracts";
import { Effect } from "effect";

export interface TaskConsentKey {
  readonly threadId: string;
  /** The task's user turn (`taskTurnId ?? turnId`), shared by provider turns that carry it on. */
  readonly turnId: string;
  readonly runtimeSessionId: string;
}

/** "denied": the user declined; "unanswered": never approved, after every request expired or failed. */
export type TaskConsentOutcome = "granted" | "denied" | "unanswered";

export interface TaskConsentEntry<K extends TaskConsentKey> {
  readonly key: K;
  readonly proposalId: AgentControlProposalId;
  /** Which request (1-based) this proposal answers. */
  readonly attempt: number;
  readonly outcome?: TaskConsentOutcome;
}

/** A consent that expired or failed revalidation is asked for once more, then treated as declined. */
export const TASK_CONSENT_MAX_ATTEMPTS = 2;
/** Threads remembered at once; one task per thread. */
export const TASK_CONSENT_MAX_THREADS = 256;

/** What a consent proposal's status means for the task that asked. */
export type TaskConsentState = "granted" | "denied" | "pending" | "ask-again";

/**
 * Only a completed consent grants: approved and executing are still being revalidated by the
 * executor, which can still fail the card (the task ended, the subject changed), and a grant
 * pinned before that would outlive it.
 */
export const taskConsentStateFor = (status: AgentControlProposalStatus): TaskConsentState => {
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

export class TaskConsents<K extends TaskConsentKey> {
  private readonly byThread = new Map<string, TaskConsentEntry<K>>();
  private readonly subjectOf: (key: K) => string;

  /** `subjectOf` names what a key's consent is for (a device's udid, a terminal's id). */
  constructor(subjectOf: (key: K) => string) {
    this.subjectOf = subjectOf;
  }

  private sameKey(left: K, right: K): boolean {
    return (
      left.threadId === right.threadId &&
      left.turnId === right.turnId &&
      left.runtimeSessionId === right.runtimeSessionId &&
      this.subjectOf(left) === this.subjectOf(right)
    );
  }

  /** The entry for exactly this task and subject, if any. */
  lookup(key: K): TaskConsentEntry<K> | undefined {
    const entry = this.byThread.get(key.threadId);
    return entry !== undefined && this.sameKey(entry.key, key) ? entry : undefined;
  }

  /** Remember the proposal that answers `key`; replaces the thread's previous task. */
  record(
    key: K,
    proposalId: AgentControlProposalId,
    attempt: number,
    outcome?: TaskConsentOutcome,
  ): TaskConsentEntry<K> {
    const entry: TaskConsentEntry<K> = {
      key,
      proposalId,
      attempt,
      ...(outcome === undefined ? {} : { outcome }),
    };
    // Re-inserted so the map's order is oldest first.
    this.byThread.delete(key.threadId);
    this.byThread.set(key.threadId, entry);
    while (this.byThread.size > TASK_CONSENT_MAX_THREADS) {
      const oldest = this.byThread.keys().next();
      if (oldest.done === true) break;
      this.byThread.delete(oldest.value);
    }
    return entry;
  }

  /** Record the user's decision for the entry of exactly this task. */
  settle(key: K, outcome: TaskConsentOutcome): void {
    const entry = this.lookup(key);
    if (entry === undefined) return;
    this.byThread.set(key.threadId, { ...entry, outcome });
  }
}

/** Deterministic per kind, task, subject and attempt; well under the 128-character request id cap. */
export const taskConsentRequestId = (
  prefix: string,
  key: TaskConsentKey,
  subject: string,
  attempt: number,
): string =>
  `${prefix}:${createHash("sha256")
    .update(
      [key.threadId, key.turnId, key.runtimeSessionId, subject, String(attempt)].join("\u0000"),
    )
    .digest("hex")
    .slice(0, 48)}`;

export type TaskConsentAnswer =
  | { readonly kind: "granted" }
  | { readonly kind: "pending"; readonly proposalId: AgentControlProposalId }
  | { readonly kind: "declined" | "unanswered" };

export interface TaskConsentFlow<K extends TaskConsentKey, E> {
  readonly consents: TaskConsents<K>;
  readonly key: K;
  /** The proposal's current status; `undefined` when it no longer exists. */
  readonly proposalStatus: (
    proposalId: AgentControlProposalId,
  ) => Effect.Effect<AgentControlProposalStatus | undefined, E>;
  /** Submits (or, for a used request id, replays) the consent proposal of attempt `attempt`. */
  readonly submit: (attempt: number) => Effect.Effect<
    {
      readonly proposalId: AgentControlProposalId;
      readonly status: AgentControlProposalStatus;
    },
    E
  >;
}

/**
 * The user's answer for this task and subject: granted, still pending, declined, or never
 * approved. Asks (once, or once more after an expired or failed request) when there is no
 * answer yet. A decision binds the task: declined (or never approved) is not asked again.
 */
export const askForTaskConsent = <K extends TaskConsentKey, E>(
  flow: TaskConsentFlow<K, E>,
): Effect.Effect<TaskConsentAnswer, E> =>
  Effect.gen(function* () {
    const { consents, key } = flow;
    const entry = consents.lookup(key);
    if (entry?.outcome === "granted") return { kind: "granted" } as const;
    if (entry?.outcome === "denied") return { kind: "declined" } as const;
    if (entry?.outcome === "unanswered") return { kind: "unanswered" } as const;

    let attempt = 1;
    if (entry !== undefined) {
      const status = yield* flow.proposalStatus(entry.proposalId);
      const state = status === undefined ? "ask-again" : taskConsentStateFor(status);
      if (state === "granted" || state === "denied") {
        consents.settle(key, state);
        return { kind: state === "granted" ? "granted" : "declined" } as const;
      }
      if (state === "pending") return { kind: "pending", proposalId: entry.proposalId } as const;
      attempt = entry.attempt + 1;
    }

    // A request id already used answers with its proposal as it stands now.
    for (; attempt <= TASK_CONSENT_MAX_ATTEMPTS; attempt += 1) {
      const submitted = yield* flow.submit(attempt);
      const state = taskConsentStateFor(submitted.status);
      if (state === "pending") {
        consents.record(key, submitted.proposalId, attempt);
        return { kind: "pending", proposalId: submitted.proposalId } as const;
      }
      if (state !== "ask-again") {
        consents.record(key, submitted.proposalId, attempt, state);
        return { kind: state === "granted" ? "granted" : "declined" } as const;
      }
      consents.record(key, submitted.proposalId, attempt);
    }
    // Never approved: like a decline, it binds the task.
    consents.settle(key, "unanswered");
    return { kind: "unanswered" } as const;
  });
