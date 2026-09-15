import { ApprovalRequestId, type ThreadId } from "@ryco/contracts";
import { ProjectionPendingApprovalRepository } from "../persistence/Services/ProjectionPendingApprovals.ts";
import { ProjectionThreadUserInputRequestRepository } from "../persistence/Services/ProjectionThreadUserInputRequests.ts";
import { ProjectionPendingApprovalRepositoryLive } from "../persistence/Layers/ProjectionPendingApprovals.ts";
import { ProjectionThreadUserInputRequestRepositoryLive } from "../persistence/Layers/ProjectionThreadUserInputRequests.ts";
import { ApprovalResponseIdentity as IdentitySchema } from "@ryco/contracts";
import type {
  ApprovalResponseIdentity,
  OrchestrationCommand,
  OrchestrationSession,
  OrchestrationThreadActivity,
  RuntimeSessionId,
} from "@ryco/contracts";
import { Effect, Layer, Option, Schema } from "effect";
import type { ProjectionThreadUserInputRequest } from "../persistence/Services/ProjectionThreadUserInputRequests.ts";
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
function requireCallbackClaim(input: {
  command: Extract<
    OrchestrationCommand,
    { type: "thread.approval.respond" | "thread.user-input.respond" }
  >;
  identity: ApprovalResponseIdentity | undefined;
  row: Option.Option<ProjectionPendingApproval>;
  session: OrchestrationSession | null | undefined;
}) {
  const { command, session } = input;
  const row = Option.getOrUndefined(input.row);
  const reject = (detail: string) =>
    Effect.fail(
      new OrchestrationCommandInvariantError({
        commandType: command.type,
        detail:
          command.type === "thread.user-input.respond"
            ? detail.replaceAll("Approval", "Question").replaceAll("approval", "question")
            : detail,
      }),
    );
  if (!row || row.threadId !== command.threadId || row.status !== "pending") {
    return reject("Approval is no longer pending. Refresh the thread to see its current state.");
  }
  if (!row.approvalIdentity || !sameApprovalIdentity(input.identity, row.approvalIdentity)) {
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
export function requireApprovalSource(
  input: {
    command: Extract<OrchestrationCommand, { type: "thread.activity.append" }>;
    row: Option.Option<ProjectionPendingApproval>;
    session: OrchestrationSession | null | undefined;
    seenRequest: boolean;
  },
  requestKind: "approval" | "user-input" = "approval",
) {
  const { command, session } = input;
  const activity = command.activity;
  const payload = activity.payload as Record<string, unknown> | null;
  const previous = Option.getOrUndefined(input.row);
  const identity = Schema.is(IdentitySchema)(
    payload?.[requestKind === "approval" ? "approvalIdentity" : "userInputIdentity"],
  )
    ? (payload[
        requestKind === "approval" ? "approvalIdentity" : "userInputIdentity"
      ] as ApprovalResponseIdentity)
    : undefined;
  const reject = (detail: string) =>
    Effect.fail(
      new OrchestrationCommandInvariantError({
        commandType: command.type,
        detail:
          requestKind === "user-input"
            ? detail.replaceAll("Approval", "Question").replaceAll("approval", "question")
            : detail,
      }),
    );
  if (activity.kind === `provider.${requestKind}.respond.failed`) {
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
    activity.kind === `${requestKind}.requested` &&
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
  if (activity.kind === `${requestKind}.resolved` && previous) {
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
  if (activity.kind === `${requestKind}.requested`) {
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

/** Questions use the same callback identity, claim and first-settlement rules.
 * This adapter reads the existing question projection; it owns no second registry.
 */
export function questionAsCallback(
  row: ProjectionThreadUserInputRequest,
): ProjectionPendingApproval {
  return {
    requestId: row.requestId,
    threadId: row.threadId,
    turnId: null,
    status: row.isPending ? "pending" : "resolved",
    decision: null,
    createdAt: row.updatedAt,
    resolvedAt: row.isPending ? null : row.updatedAt,
    ...(row.userInputIdentity ? { approvalIdentity: row.userInputIdentity } : {}),
    ...(row.responseAttemptId ? { responseAttemptId: row.responseAttemptId } : {}),
    ...(row.responseState ? { responseState: row.responseState } : {}),
    ...(row.settlementRequiresIdentity !== undefined
      ? { settlementRequiresIdentity: row.settlementRequiresIdentity }
      : {}),
  };
}

export function requireApprovalClaim(input: {
  command: Extract<OrchestrationCommand, { type: "thread.approval.respond" }>;
  row: Option.Option<ProjectionPendingApproval>;
  session: OrchestrationSession | null | undefined;
}) {
  return requireCallbackClaim({ ...input, identity: input.command.approvalIdentity });
}

export function requireUserInputClaim(input: {
  command: Extract<OrchestrationCommand, { type: "thread.user-input.respond" }>;
  row: Option.Option<ProjectionThreadUserInputRequest>;
  session: OrchestrationSession | null | undefined;
}) {
  return requireCallbackClaim({
    ...input,
    row: Option.map(input.row, questionAsCallback),
    identity: input.command.userInputIdentity,
  });
}

export const callbackRepositories = Layer.merge(
  ProjectionPendingApprovalRepositoryLive,
  ProjectionThreadUserInputRequestRepositoryLive,
);

/** Lifecycle cleanup invalidates the exact durable callback/attempt; it never invents an answer. */
export const pendingCallbackInvalidation = Effect.fn("pendingCallbackInvalidation")(
  function* (input: {
    threadId: ThreadId;
    requestId: string;
    kind: "approval" | "user-input";
    detail: string;
    source?: {
      runtimeSessionId?: RuntimeSessionId | undefined;
      activities: ReadonlyArray<Pick<OrchestrationThreadActivity, "id" | "turnId">>;
      turnId: string | null;
    };
  }) {
    const lookup = { threadId: input.threadId, requestId: ApprovalRequestId.make(input.requestId) };
    const row =
      input.kind === "approval"
        ? yield* (yield* ProjectionPendingApprovalRepository).getByRequestId(lookup)
        : yield* (yield* ProjectionThreadUserInputRequestRepository)
            .getByRequestId(lookup)
            .pipe(Effect.map(Option.map(questionAsCallback)));
    if (Option.isNone(row) || row.value.status !== "pending") return null;
    if (input.source) {
      const identity = row.value.approvalIdentity;
      // A lifecycle snapshot cannot redirect cleanup to a newer callback that
      // reused the provider ID while ingestion was awaiting the durable row.
      if (
        !identity ||
        identity.runtimeSessionId !== input.source.runtimeSessionId ||
        (input.kind === "approval" && row.value.turnId !== input.source.turnId) ||
        !input.source.activities.some(
          (activity) =>
            activity.id === identity.requestEventId && activity.turnId === input.source?.turnId,
        )
      )
        return null;
    }
    return {
      requestId: input.requestId,
      ...(row.value.approvalIdentity
        ? input.kind === "approval"
          ? { approvalIdentity: row.value.approvalIdentity }
          : { userInputIdentity: row.value.approvalIdentity }
        : {}),
      ...(row.value.responseAttemptId ? { responseAttemptId: row.value.responseAttemptId } : {}),
      responseState: "invalidated",
      detail: `Stale pending ${input.kind} request: ${input.detail}. Provider callbacks are process-local. Restart the turn to continue.`,
    };
  },
);
