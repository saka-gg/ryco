import {
  CONTEXT_HANDOFF_ACTIVITY_KIND,
  ContextHandoffActivityPayload,
  type OrchestrationThreadActivity,
} from "@ryco/contracts";
import { Schema } from "effect";

export const CONTEXT_COMPACTION_ACTIVITY_KIND = "context-compaction";

const decodeContextHandoffActivityPayload = Schema.decodeUnknownSync(ContextHandoffActivityPayload);

export function isContextCompactionActivity(
  activity: Pick<OrchestrationThreadActivity, "kind">,
): boolean {
  return activity.kind === CONTEXT_COMPACTION_ACTIVITY_KIND;
}

export function isTerminalContextHandoffActivity(
  activity: Pick<OrchestrationThreadActivity, "kind" | "payload">,
): boolean {
  if (activity.kind !== CONTEXT_HANDOFF_ACTIVITY_KIND) {
    return false;
  }

  try {
    const payload = decodeContextHandoffActivityPayload(activity.payload);
    return (
      payload.status === "consumed" ||
      payload.status === "failed" ||
      payload.status === "delivery-uncertain"
    );
  } catch {
    return false;
  }
}

export function isThreadActivityMilestone(
  activity: Pick<OrchestrationThreadActivity, "kind" | "payload">,
): boolean {
  return isContextCompactionActivity(activity) || isTerminalContextHandoffActivity(activity);
}

/**
 * Input must already be sorted in display order. Keeps the recent activity cap
 * predictable while preserving long-lived timeline milestones.
 */
export function capThreadActivitiesPreservingMilestones<
  T extends Pick<OrchestrationThreadActivity, "id" | "kind" | "payload">,
>(activities: ReadonlyArray<T>, limit: number): T[] {
  if (activities.length <= limit) {
    return [...activities];
  }

  const recent = activities.slice(-limit);
  const recentIds = new Set(recent.map((activity) => activity.id));
  const preserved = activities.filter(
    (activity) => isThreadActivityMilestone(activity) && !recentIds.has(activity.id),
  );

  return preserved.length === 0 ? [...recent] : [...preserved, ...recent];
}

interface PendingThreadRequestActivity {
  readonly kind: string;
  readonly payload: unknown;
  readonly createdAt: string;
  readonly id?: string | undefined;
  readonly activityId?: string | undefined;
  readonly sequence?: number | undefined;
  readonly turnId?: string | null | undefined;
}

export interface PendingThreadRequestState {
  readonly pendingApprovalCount: number;
  readonly pendingUserInputCount: number;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
}

function activityRequestId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || !("requestId" in payload)) {
    return null;
  }
  const requestId = (payload as { requestId?: unknown }).requestId;
  return typeof requestId === "string" && requestId.length > 0 ? requestId : null;
}

function activityFailureDetail(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || !("detail" in payload)) {
    return null;
  }
  const detail = (payload as { detail?: unknown }).detail;
  return typeof detail === "string" ? detail.toLowerCase() : null;
}

function isStaleRequestFailure(detail: string | null, requestKind: "approval" | "user-input") {
  if (detail === null) return false;
  if (requestKind === "approval") {
    return (
      detail.includes("stale pending approval request") ||
      detail.includes("unknown pending approval request") ||
      detail.includes("unknown pending permission request")
    );
  }
  return (
    detail.includes("stale pending user-input request") ||
    detail.includes("unknown pending user-input request")
  );
}

function comparePendingRequestActivities(
  left: PendingThreadRequestActivity,
  right: PendingThreadRequestActivity,
): number {
  const bySequence =
    (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER);
  if (bySequence !== 0) return bySequence;
  const byCreatedAt = left.createdAt.localeCompare(right.createdAt);
  if (byCreatedAt !== 0) return byCreatedAt;
  return (left.id ?? left.activityId ?? "").localeCompare(right.id ?? right.activityId ?? "");
}

export function derivePendingThreadRequests(
  activities: ReadonlyArray<PendingThreadRequestActivity>,
): ReadonlyArray<{
  readonly requestId: string;
  readonly kind: "approval" | "user-input";
  readonly turnId: string | null;
}> {
  const approvalIds = new Map<string, string | null>();
  const userInputIds = new Map<string, string | null>();

  for (const activity of activities.toSorted(comparePendingRequestActivities)) {
    const requestId = activityRequestId(activity.payload);
    if (requestId === null) continue;

    if (activity.kind === "approval.requested") {
      approvalIds.set(requestId, activity.turnId ?? null);
    } else if (activity.kind === "approval.resolved") {
      approvalIds.delete(requestId);
    } else if (
      activity.kind === "provider.approval.respond.failed" &&
      isStaleRequestFailure(activityFailureDetail(activity.payload), "approval")
    ) {
      approvalIds.delete(requestId);
    } else if (activity.kind === "user-input.requested") {
      userInputIds.set(requestId, activity.turnId ?? null);
    } else if (activity.kind === "user-input.resolved") {
      userInputIds.delete(requestId);
    } else if (
      activity.kind === "provider.user-input.respond.failed" &&
      isStaleRequestFailure(activityFailureDetail(activity.payload), "user-input")
    ) {
      userInputIds.delete(requestId);
    }
  }

  return [
    ...Array.from(approvalIds, ([requestId, turnId]) => ({
      requestId,
      turnId,
      kind: "approval" as const,
    })),
    ...Array.from(userInputIds, ([requestId, turnId]) => ({
      requestId,
      turnId,
      kind: "user-input" as const,
    })),
  ];
}

export function derivePendingThreadRequestState(
  activities: ReadonlyArray<PendingThreadRequestActivity>,
): PendingThreadRequestState {
  const requests = derivePendingThreadRequests(activities);
  const pendingApprovalCount = requests.filter((request) => request.kind === "approval").length;
  const pendingUserInputCount = requests.length - pendingApprovalCount;
  return {
    pendingApprovalCount,
    pendingUserInputCount,
    hasPendingApprovals: pendingApprovalCount > 0,
    hasPendingUserInput: pendingUserInputCount > 0,
  };
}

/** Approval attempts and provider callbacks share the durable orchestration order.
 * Provider-local sequence numbers cannot be compared to local response attempts.
 */
export function approvalActivityInOrchestrationOrder(
  activity: OrchestrationThreadActivity,
  sequence: number,
): OrchestrationThreadActivity {
  return activity.kind.startsWith("approval.") ||
    activity.kind === "provider.approval.respond.failed"
    ? { ...activity, sequence }
    : activity;
}
