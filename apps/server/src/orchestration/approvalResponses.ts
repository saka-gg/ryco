import { ApprovalResponseIdentity as IdentitySchema } from "@ryco/contracts";
import type {
  ApprovalResponseIdentity,
  OrchestrationCommand,
  OrchestrationSession,
} from "@ryco/contracts";
import { Effect, Option, Schema } from "effect";
import type { ProjectionPendingApproval } from "../persistence/Services/ProjectionPendingApprovals.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";

export function sameApprovalIdentity(
  left: ApprovalResponseIdentity | undefined,
  right: ApprovalResponseIdentity | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.requestEventId === right.requestEventId &&
    left.runtimeSessionId === right.runtimeSessionId
  );
}

/** Called by the serialized orchestration writer before its claim is committed. */
export function requireApprovalClaim(input: {
  command: Extract<OrchestrationCommand, { type: "thread.approval.respond" }>;
  row: Option.Option<ProjectionPendingApproval>;
  session: OrchestrationSession | null | undefined;
}) {
  const { command, session } = input;
  const row = Option.getOrUndefined(input.row);
  const reject = (detail: string) =>
    Effect.fail(new OrchestrationCommandInvariantError({ commandType: command.type, detail }));
  if (!row || row.threadId !== command.threadId || row.status !== "pending") {
    return reject("Approval is no longer pending. Refresh the thread to see its current state.");
  }
  if (
    !row.approvalIdentity ||
    !sameApprovalIdentity(command.approvalIdentity, row.approvalIdentity)
  ) {
    return reject(
      "Approval callback identity changed or is missing. Refresh the thread before responding.",
    );
  }
  if (
    !session ||
    !session.runtimeSessionId ||
    session.status === "stopped" ||
    session.runtimeSessionId !== row.approvalIdentity.runtimeSessionId
  ) {
    return reject(
      "Approval belongs to an inactive provider session. Restart the turn to continue.",
    );
  }
  if (row.responseState !== undefined && row.responseState !== "retryable") {
    return reject(
      "Approval response already submitted. Await authoritative settlement; its outcome must not be replayed.",
    );
  }
  return Effect.void;
}

/** Lifecycle/outcome writers must identify both the callback and the claimed attempt. */
export function matchesApprovalAttempt(
  row: ProjectionPendingApproval,
  identity: ApprovalResponseIdentity | undefined,
  attemptId: string | null | undefined,
): boolean {
  return (
    sameApprovalIdentity(row.approvalIdentity, identity) && row.responseAttemptId === attemptId
  );
}

/** Source events are validated again at the serialized writer, after ingestion's
 * runtime check, so a queued old callback cannot cross a session transition.
 */
export function requireApprovalSource(input: {
  command: Extract<OrchestrationCommand, { type: "thread.activity.append" }>;
  row: Option.Option<ProjectionPendingApproval>;
  session: OrchestrationSession | null | undefined;
  seenRequest: boolean;
}) {
  const { command, session } = input;
  const activity = command.activity;
  const payload = activity.payload as Record<string, unknown> | null;
  const previous = Option.getOrUndefined(input.row);
  const identity = Schema.is(IdentitySchema)(payload?.approvalIdentity)
    ? payload.approvalIdentity
    : undefined;
  const reject = (detail: string) =>
    Effect.fail(new OrchestrationCommandInvariantError({ commandType: command.type, detail }));
  if (activity.kind === "provider.approval.respond.failed") {
    if (
      previous?.approvalIdentity &&
      (!matchesApprovalAttempt(
        previous,
        identity,
        typeof payload?.responseAttemptId === "string" ? payload.responseAttemptId : undefined,
      ) ||
        previous.status === "resolved")
    ) {
      return reject("Stale approval response failure cannot change the current attempt.");
    }
    return Effect.void;
  }
  if (
    activity.kind === "approval.requested" &&
    (!session || session.status === "stopped" || !session.runtimeSessionId)
  ) {
    return reject(
      "New approval callbacks require an active session with a current runtime identity.",
    );
  }
  // A late, qualified settlement can finish a callback after its session stopped;
  // it cannot cross into a newer runtime or invent an absent callback identity.
  const expectedRuntime = session?.runtimeSessionId ?? previous?.approvalIdentity?.runtimeSessionId;
  if (!expectedRuntime || payload?.runtimeSessionId !== expectedRuntime) {
    return reject(
      "Stale approval runtime identity. The callback cannot be rebound to the current session.",
    );
  }
  if (activity.kind === "approval.resolved" && previous) {
    if (
      previous.status === "resolved" ||
      (identity && !sameApprovalIdentity(previous.approvalIdentity, identity)) ||
      (previous.settlementRequiresIdentity && !identity) ||
      (typeof payload?.responseAttemptId === "string" &&
        !matchesApprovalAttempt(previous, identity, payload.responseAttemptId))
    ) {
      return reject("Stale or ambiguous approval settlement cannot change the current callback.");
    }
  }
  if (activity.kind === "approval.requested") {
    if (
      previous?.status === "pending" &&
      previous.approvalIdentity?.runtimeSessionId === payload?.runtimeSessionId
    ) {
      return reject("Provider reused an approval id while its previous callback is still pending.");
    }
    if (input.seenRequest) return reject("Approval callback instance was already observed.");
  }
  return Effect.void;
}
