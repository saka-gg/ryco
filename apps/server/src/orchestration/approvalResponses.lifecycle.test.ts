import {
  ApprovalRequestId,
  CommandId,
  EventId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
} from "@ryco/contracts";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { pendingCallbackInvalidation } from "./approvalResponses.ts";
import { ProjectionPendingApprovalRepository } from "../persistence/Services/ProjectionPendingApprovals.ts";
import { ProjectionThreadUserInputRequestRepository } from "../persistence/Services/ProjectionThreadUserInputRequests.ts";

const identity = {
  requestEventId: EventId.make("current-callback"),
  runtimeSessionId: RuntimeSessionId.make("current-runtime"),
};
const threadId = ThreadId.make("thread");
const requestId = ApprovalRequestId.make("reused-provider-id");
const turnId = TurnId.make("current-turn");
const responseAttemptId = CommandId.make("claimed-attempt");
const source = {
  runtimeSessionId: identity.runtimeSessionId,
  activities: [{ id: identity.requestEventId, turnId }],
  turnId,
};

function invalidate(kind: "approval" | "user-input", origin = source, pending = true) {
  return Effect.runPromise(
    pendingCallbackInvalidation({
      threadId,
      requestId,
      kind,
      detail: "turn ended",
      source: origin,
    }).pipe(
      Effect.provideService(ProjectionPendingApprovalRepository, {
        upsert: () => Effect.void,
        deleteByThreadId: () => Effect.void,
        deleteByRequestId: () => Effect.void,
        listByThreadId: () => Effect.succeed([]),
        getByRequestId: () =>
          Effect.succeed(
            Option.some({
              threadId,
              requestId,
              turnId,
              status: pending ? "pending" : "resolved",
              decision: null,
              createdAt: "2026-09-15T00:00:00.000Z",
              resolvedAt: null,
              approvalIdentity: identity,
              responseAttemptId,
              responseState: "uncertain",
            }),
          ),
      }),
      Effect.provideService(ProjectionThreadUserInputRequestRepository, {
        upsert: () => Effect.void,
        deleteByThreadId: () => Effect.void,
        getByRequestId: () =>
          Effect.succeed(
            Option.some({
              threadId,
              requestId,
              isPending: pending,
              updatedAt: "2026-09-15T00:00:00.000Z",
              userInputIdentity: identity,
              responseAttemptId,
              responseState: "uncertain",
            }),
          ),
      }),
    ),
  );
}

describe.each(["approval", "user-input"] as const)("%s lifecycle invalidation", (kind) => {
  it("invalidates the matching uncertain callback with its exact persisted attempt", async () => {
    expect(await invalidate(kind)).toMatchObject({
      requestId,
      responseState: "invalidated",
      responseAttemptId,
      [kind === "approval" ? "approvalIdentity" : "userInputIdentity"]: identity,
    });
  });
  it("does not redirect an old snapshot to a replacement callback with the same provider id", async () => {
    expect(
      await invalidate(kind, {
        ...source,
        activities: [{ id: EventId.make("old-callback"), turnId }],
      }),
    ).toBeNull();
  });
  it("rejects another runtime or turn and leaves settled callbacks unchanged", async () => {
    expect(
      await invalidate(kind, { ...source, runtimeSessionId: RuntimeSessionId.make("old-runtime") }),
    ).toBeNull();
    expect(await invalidate(kind, { ...source, turnId: TurnId.make("old-turn") })).toBeNull();
    expect(await invalidate(kind, source, false)).toBeNull();
  });
});
