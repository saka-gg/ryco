import type { ApprovalRequestId } from "@ryco/contracts/base-schemas";
import type { OrchestrationThreadActivity } from "@ryco/contracts/orchestration";

import { derivePendingApprovals, type PendingApproval } from "../session/session-logic.ts";

/**
 * Sending while approvals wait redirects the turn: the send declines the approvals the user saw,
 * waits until the provider has taken every decline, and only then steers the message into the
 * turn. Approval responses and steers travel on separate server lanes, so waiting is what keeps
 * the decline ahead of the steer. The send path calls this last, after local commands,
 * queued-message edits and refused drafts have returned, so those leave approvals alone.
 *
 * The approvals' own response states are the guard: one already being answered, or whose
 * delivery is unknown, stops the send instead of racing it, and so does a decline that fails,
 * ends uncertain or is still in flight at the deadline. The draft stays in the composer.
 */

/** Placeholder of a composer whose send declines the waiting approvals and redirects the turn. */
export const APPROVAL_REDIRECT_PLACEHOLDER = "Send a message to decline and redirect";

/** How long a redirect waits for the provider to take its declines. */
export const APPROVAL_REDIRECT_SETTLE_TIMEOUT_MS = 15_000;

export type ApprovalRedirectPlan =
  /** Nothing to decline: the send goes out as usual. */
  | { readonly kind: "none" }
  /** An approval is being answered, or its delivery outcome is unknown: nothing is sent. */
  | { readonly kind: "blocked" }
  | {
      readonly kind: "decline";
      readonly approvals: ReadonlyArray<PendingApproval>;
      /** Every approval pending at send; one arriving meanwhile stops the redirect. */
      readonly seenRequestIds: ReadonlyArray<ApprovalRequestId>;
    };

/**
 * What a send does with the approvals pending on its thread. An approval of an ended provider
 * runtime cannot be answered any more (the node refuses it), so it is skipped, not declined.
 */
export function planApprovalRedirect(input: {
  readonly approvals: ReadonlyArray<PendingApproval>;
  /** The thread session's provider runtime. */
  readonly runtimeSessionId: string | null | undefined;
  /** Approvals this client is answering right now. */
  readonly respondingRequestIds?: ReadonlyArray<ApprovalRequestId>;
}): ApprovalRedirectPlan {
  const decline: PendingApproval[] = [];
  for (const approval of input.approvals) {
    const owner = approval.approvalIdentity?.runtimeSessionId;
    if (owner === undefined || owner !== input.runtimeSessionId) continue;
    if (
      approval.responseState === "submitting" ||
      approval.responseState === "uncertain" ||
      input.respondingRequestIds?.includes(approval.requestId) === true
    ) {
      return { kind: "blocked" };
    }
    if (approval.responseState === undefined || approval.responseState === "retryable") {
      decline.push(approval);
    }
  }
  if (decline.length === 0) return { kind: "none" };
  return {
    kind: "decline",
    approvals: decline,
    seenRequestIds: input.approvals.map((approval) => approval.requestId),
  };
}

/** The thread's pending approvals as the client holds them, and a way to hear them change. */
export interface PendingApprovalSource {
  readonly read: () => ReadonlyArray<PendingApproval>;
  /** Calls `onChange` after the thread's state may have changed; returns the unsubscribe. */
  readonly subscribe: (onChange: () => void) => () => void;
}

/** A source over a store holding the thread's activities (the shared thread store). */
export function pendingApprovalSourceFromStore<State>(
  store: {
    readonly getState: () => State;
    readonly subscribe: (listener: () => void) => () => void;
  },
  selectActivities: (state: State) => ReadonlyArray<OrchestrationThreadActivity> | undefined,
): PendingApprovalSource {
  let activities: ReadonlyArray<OrchestrationThreadActivity> | undefined;
  let approvals: ReadonlyArray<PendingApproval> = [];
  return {
    read: () => {
      const next = selectActivities(store.getState());
      if (next !== activities) {
        activities = next;
        approvals = derivePendingApprovals(next ?? []);
      }
      return approvals;
    },
    subscribe: (onChange) => store.subscribe(onChange),
  };
}

export type ApprovalRedirectOutcome =
  | { readonly kind: "declined" }
  /** The node refused a decline. */
  | { readonly kind: "refused"; readonly error: string | null }
  /** A decline did not reach the provider, or may not have. */
  | { readonly kind: "undelivered" }
  /** A decline was still in flight at the deadline. */
  | { readonly kind: "timed-out" }
  /** A new approval arrived while the declines settled; it would block the redirect. */
  | { readonly kind: "approval-arrived" };

export async function declineApprovalsForRedirect(input: {
  readonly plan: Extract<ApprovalRedirectPlan, { kind: "decline" }>;
  /** Answers one approval with "decline"; rejects when the node refuses. */
  readonly decline: (approval: PendingApproval) => Promise<void>;
  readonly source: PendingApprovalSource;
  readonly timeoutMs?: number;
}): Promise<ApprovalRedirectOutcome> {
  for (const approval of input.plan.approvals) {
    try {
      await input.decline(approval);
    } catch (error) {
      return { kind: "refused", error: error instanceof Error ? error.message : null };
    }
  }
  const settled = await waitForDeclinesToSettle(
    input.plan.approvals,
    input.source,
    input.timeoutMs ?? APPROVAL_REDIRECT_SETTLE_TIMEOUT_MS,
  );
  if (settled !== "settled") return { kind: settled };
  const seen = new Set(input.plan.seenRequestIds);
  return input.source.read().some((approval) => !seen.has(approval.requestId))
    ? { kind: "approval-arrived" }
    : { kind: "declined" };
}

/**
 * A decline has settled once its approval left the pending list (the provider took it, or the
 * node invalidated the request). Until the projection shows the new attempt the approval can
 * still carry an earlier attempt's state, so only a failure of a newer attempt counts.
 */
function waitForDeclinesToSettle(
  approvals: ReadonlyArray<PendingApproval>,
  source: PendingApprovalSource,
  timeoutMs: number,
): Promise<"settled" | "undelivered" | "timed-out"> {
  const earlierAttempts = new Map(
    approvals.map((approval) => [approval.requestId, approval.responseAttemptId]),
  );
  return new Promise((resolve) => {
    let finished = false;
    let unsubscribe: (() => void) | null = null;
    const finish = (result: "settled" | "undelivered" | "timed-out") => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      unsubscribe?.();
      resolve(result);
    };
    const check = () => {
      if (finished) return;
      const pending = new Map(source.read().map((approval) => [approval.requestId, approval]));
      let open = false;
      for (const [requestId, earlierAttempt] of earlierAttempts) {
        const approval = pending.get(requestId);
        if (!approval) continue;
        if (
          (approval.responseState === "retryable" || approval.responseState === "uncertain") &&
          approval.responseAttemptId !== earlierAttempt
        ) {
          finish("undelivered");
          return;
        }
        open = true;
      }
      if (!open) finish("settled");
    };
    const timer = setTimeout(() => finish("timed-out"), timeoutMs);
    const stop = source.subscribe(check);
    if (finished) stop();
    else unsubscribe = stop;
    check();
  });
}

/** Why a redirect sent nothing; the draft stays in the composer in every case. */
export type ApprovalRedirectRefusal =
  | "blocked"
  | "draft-changed"
  | Exclude<ApprovalRedirectOutcome["kind"], "declined">;

export function describeApprovalRedirectRefusal(
  refusal: ApprovalRedirectRefusal,
  error?: string | null,
): { readonly title: string; readonly description: string } {
  switch (refusal) {
    case "blocked":
      return {
        title: "An approval is still being answered",
        description: "Your message wasn't sent. Send it again once the approval settles.",
      };
    case "refused":
      return {
        title: "Couldn't decline the approval",
        description: error ? `Your message wasn't sent. ${error}` : "Your message wasn't sent.",
      };
    case "undelivered":
      return {
        title: "The decline may not have reached the agent",
        description: "Your message wasn't sent. Check the approval, then send again.",
      };
    case "timed-out":
      return {
        title: "The decline is still on its way",
        description: "Your message wasn't sent. Send it again once the approval settles.",
      };
    case "approval-arrived":
      return {
        title: "Another approval arrived",
        description: "Your message wasn't sent. Send it again to decline that one too.",
      };
    case "draft-changed":
      return {
        title: "Approval declined, message not sent",
        description: "Your message changed meanwhile. Send it again when it's ready.",
      };
  }
}
