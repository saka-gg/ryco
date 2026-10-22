import type { ApprovalRequestId } from "@ryco/contracts/base-schemas";
import type { OrchestrationThreadActivity } from "@ryco/contracts/orchestration";

import { derivePendingApprovals, type PendingApproval } from "../session/session-logic.ts";

/**
 * Sending while approvals wait redirects the turn: the send declines the approvals the user saw,
 * waits until the provider has taken every decline, and only then steers the message into the
 * turn. Approval responses and steers travel on separate server lanes, and adapters refuse a
 * steer while an approval waits, so waiting is what keeps the decline ahead of the steer. The
 * send path calls this last, after local commands, queued-message edits and refused drafts have
 * returned, so those leave approvals alone.
 *
 * `resolveApprovalRedirect` is the one decision: the composer's placeholder and primary action
 * and the send itself all read it, so the composer never promises a redirect the send skips.
 * A redirect only happens when the message can steer; an approval already being answered, or
 * whose delivery is unknown, leaves the send to the follow-up setting. A decline that fails,
 * ends uncertain or is still in flight at the deadline stops the send, and the draft stays.
 */

/** Placeholder of a composer whose send declines the waiting approvals and redirects the turn. */
export const APPROVAL_REDIRECT_PLACEHOLDER = "Send a message to decline and redirect";

/** How long a redirect waits for the provider to take its declines. */
export const APPROVAL_REDIRECT_SETTLE_TIMEOUT_MS = 15_000;

/**
 * How long an approval must have been on screen before a send declines it. A send right after it
 * appeared was typed for something else, so it keeps the draft and lets the user read it first.
 */
export const APPROVAL_REDIRECT_MIN_VISIBLE_MS = 750;

export type ApprovalRedirect =
  /** The send follows the follow-up setting and leaves approvals alone. */
  | { readonly kind: "none" }
  /**
   * An earlier redirect on this turn declined approvals but sent nothing; the send steers,
   * whatever the follow-up setting says.
   */
  | { readonly kind: "steer" }
  | {
      readonly kind: "decline";
      readonly approvals: ReadonlyArray<PendingApproval>;
      /** Every approval pending at send. */
      readonly seenRequestIds: ReadonlyArray<ApprovalRequestId>;
      /** The runtime and turn being redirected: approvals they open meanwhile are declined too. */
      readonly runtimeSessionId: string;
      readonly turnId: string | null;
    };

const NO_REDIRECT: ApprovalRedirect = { kind: "none" };

/**
 * What a send does with the approvals pending on its thread. An approval of an ended provider
 * runtime cannot be answered any more (the node refuses it), so it is skipped, not declined.
 */
export function resolveApprovalRedirect(input: {
  readonly approvals: ReadonlyArray<PendingApproval>;
  /** The thread session's provider runtime and its running turn. */
  readonly runtimeSessionId: string | null | undefined;
  readonly activeTurnId: string | null | undefined;
  /** Approvals this client is answering right now. */
  readonly respondingRequestIds?: ReadonlyArray<ApprovalRequestId>;
  /**
   * The message could steer the running turn now: the turn runs, the surface, provider,
   * connection and selection allow it.
   */
  readonly steerAllowed: boolean;
  /** A question waits too; the composer answers it instead. */
  readonly questionPending: boolean;
  /** The turn on which an earlier redirect declined approvals without sending its message. */
  readonly redirectedTurnId?: string | null;
}): ApprovalRedirect {
  const runtimeSessionId = input.runtimeSessionId;
  if (!input.steerAllowed || input.questionPending || !runtimeSessionId) return NO_REDIRECT;
  const decline: PendingApproval[] = [];
  let answering = false;
  for (const approval of input.approvals) {
    if (approval.approvalIdentity?.runtimeSessionId !== runtimeSessionId) continue;
    if (
      approval.responseState === "submitting" ||
      approval.responseState === "uncertain" ||
      input.respondingRequestIds?.includes(approval.requestId) === true
    ) {
      answering = true;
    } else if (approval.responseState === undefined || approval.responseState === "retryable") {
      decline.push(approval);
    }
  }
  // An approval being answered would refuse the steer anyway; nothing is declined around it.
  if (decline.length > 0 && !answering) {
    return {
      kind: "decline",
      approvals: decline,
      seenRequestIds: input.approvals.map((approval) => approval.requestId),
      runtimeSessionId,
      turnId: input.activeTurnId ?? null,
    };
  }
  const redirected =
    input.activeTurnId !== null &&
    input.activeTurnId !== undefined &&
    input.redirectedTurnId === input.activeTurnId;
  return redirected ? { kind: "steer" } : NO_REDIRECT;
}

/** When this client first showed each pending approval. */
export type ApprovalSightings = ReadonlyMap<ApprovalRequestId, number>;

/**
 * Notes approvals shown for the first time and forgets those no longer pending. Returns
 * `previous` itself when nothing changed.
 */
export function recordApprovalSightings(
  previous: ApprovalSightings,
  approvals: ReadonlyArray<PendingApproval>,
  now: number,
): ApprovalSightings {
  const pending = new Set(approvals.map((approval) => approval.requestId));
  const changed =
    approvals.some((approval) => !previous.has(approval.requestId)) ||
    [...previous.keys()].some((requestId) => !pending.has(requestId));
  if (!changed) return previous;
  return new Map(
    approvals.map((approval) => [approval.requestId, previous.get(approval.requestId) ?? now]),
  );
}

/** Whether a redirect would decline an approval shown too recently to have been read. */
export function approvalRedirectTooSoon(
  redirect: Extract<ApprovalRedirect, { kind: "decline" }>,
  sightings: ApprovalSightings,
  now: number = Date.now(),
): boolean {
  return redirect.approvals.some((approval) => {
    const shownAt = sightings.get(approval.requestId);
    return shownAt === undefined || now - shownAt < APPROVAL_REDIRECT_MIN_VISIBLE_MS;
  });
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

/** `declined` counts the declines the node took, including any before a failure. */
export type ApprovalRedirectOutcome =
  | { readonly kind: "declined"; readonly declined: number }
  /** The node refused a decline. */
  | { readonly kind: "refused"; readonly declined: number; readonly error: string | null }
  /** A decline did not reach the provider, or may not have. */
  | { readonly kind: "undelivered"; readonly declined: number }
  /** A decline was still in flight at the deadline. */
  | { readonly kind: "timed-out"; readonly declined: number }
  /** An approval of another turn arrived while the declines settled; it would block the steer. */
  | { readonly kind: "approval-arrived"; readonly declined: number };

/**
 * Declines the redirect's approvals in order and resolves once the provider took them all.
 * Approvals the redirected turn opens meanwhile (the next tool of the same batch) are part of the
 * plan the message replaces, so they are declined too, until the deadline.
 */
export async function declineApprovalsForRedirect(input: {
  readonly redirect: Extract<ApprovalRedirect, { kind: "decline" }>;
  /** Answers one approval with "decline"; rejects when the node refuses. */
  readonly decline: (approval: PendingApproval) => Promise<void>;
  readonly source: PendingApprovalSource;
  readonly timeoutMs?: number;
}): Promise<ApprovalRedirectOutcome> {
  const deadline = Date.now() + (input.timeoutMs ?? APPROVAL_REDIRECT_SETTLE_TIMEOUT_MS);
  const seen = new Set(input.redirect.seenRequestIds);
  // Each declined approval's response attempt before this redirect answered it.
  const declinedAttempts = new Map<ApprovalRequestId, string | undefined>();
  let next: ReadonlyArray<PendingApproval> = input.redirect.approvals;
  for (;;) {
    for (const approval of next) {
      seen.add(approval.requestId);
      try {
        await input.decline(approval);
      } catch (error) {
        return {
          kind: "refused",
          declined: declinedAttempts.size,
          error: error instanceof Error ? error.message : null,
        };
      }
      declinedAttempts.set(approval.requestId, approval.responseAttemptId);
    }
    const settled = await waitForDeclinesToSettle({
      redirect: input.redirect,
      declinedAttempts,
      seen,
      source: input.source,
      deadline,
    });
    if (settled.kind !== "follow-on")
      return { kind: settled.kind, declined: declinedAttempts.size };
    next = settled.approvals;
  }
}

type SettleResult =
  | { readonly kind: "declined" | "undelivered" | "timed-out" | "approval-arrived" }
  /** The redirected turn opened these approvals meanwhile. */
  | { readonly kind: "follow-on"; readonly approvals: ReadonlyArray<PendingApproval> };

/**
 * A decline has settled once its approval left the pending list (the provider took it, or the
 * node invalidated the request). Until the projection shows the new attempt the approval can
 * still carry an earlier attempt's state, so only a failure of a newer attempt counts.
 */
function waitForDeclinesToSettle(input: {
  readonly redirect: Extract<ApprovalRedirect, { kind: "decline" }>;
  readonly declinedAttempts: ReadonlyMap<ApprovalRequestId, string | undefined>;
  readonly seen: ReadonlySet<ApprovalRequestId>;
  readonly source: PendingApprovalSource;
  readonly deadline: number;
}): Promise<SettleResult> {
  const { redirect, declinedAttempts, seen, source } = input;
  return new Promise((resolve) => {
    let finished = false;
    let unsubscribe: (() => void) | null = null;
    const finish = (result: SettleResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      unsubscribe?.();
      resolve(result);
    };
    const check = () => {
      if (finished) return;
      const approvals = source.read();
      let open = false;
      const followOns: PendingApproval[] = [];
      let arrived = false;
      for (const approval of approvals) {
        if (declinedAttempts.has(approval.requestId)) {
          if (
            (approval.responseState === "retryable" || approval.responseState === "uncertain") &&
            approval.responseAttemptId !== declinedAttempts.get(approval.requestId)
          ) {
            finish({ kind: "undelivered" });
            return;
          }
          open = true;
          continue;
        }
        if (seen.has(approval.requestId)) continue;
        // Approvals of another runtime cannot hold up the steer.
        if (approval.approvalIdentity?.runtimeSessionId !== redirect.runtimeSessionId) continue;
        if (
          redirect.turnId !== null &&
          approval.turnId === redirect.turnId &&
          (approval.responseState === undefined || approval.responseState === "retryable")
        ) {
          followOns.push(approval);
        } else {
          arrived = true;
        }
      }
      if (arrived) finish({ kind: "approval-arrived" });
      else if (followOns.length > 0) finish({ kind: "follow-on", approvals: followOns });
      else if (!open) finish({ kind: "declined" });
    };
    const timer = setTimeout(
      () => finish({ kind: "timed-out" }),
      Math.max(0, input.deadline - Date.now()),
    );
    const stop = source.subscribe(check);
    if (finished) stop();
    else unsubscribe = stop;
    check();
  });
}

/** Why a redirect sent nothing; the draft stays in the composer in every case. */
export type ApprovalRedirectRefusal =
  /** An approval to decline appeared too recently to have been read. */
  | { readonly kind: "just-arrived" }
  /** Every decline was taken, but the draft changed meanwhile. */
  | { readonly kind: "draft-changed"; readonly declined: number }
  | Exclude<ApprovalRedirectOutcome, { kind: "declined" }>;

/** Whether a refused redirect still declined approvals; the next send on that turn steers. */
export function approvalRedirectRefusalDeclined(refusal: ApprovalRedirectRefusal): boolean {
  return refusal.kind !== "just-arrived" && refusal.declined > 0;
}

export function describeApprovalRedirectRefusal(refusal: ApprovalRedirectRefusal): {
  readonly title: string;
  readonly description: string;
} {
  switch (refusal.kind) {
    case "just-arrived":
      return {
        title: "An approval just arrived",
        description: "Your message wasn't sent. Check the approval, then send it again.",
      };
    case "refused":
      return {
        title:
          refusal.declined > 0
            ? "Couldn't decline every approval"
            : "Couldn't decline the approval",
        description: refusal.error
          ? `Your message wasn't sent. ${refusal.error}`
          : "Your message wasn't sent.",
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
        title:
          refusal.declined > 1
            ? "Approvals declined, message not sent"
            : "Approval declined, message not sent",
        description: "Your message changed meanwhile. Send it again when it's ready.",
      };
  }
}
