import {
  ApprovalRequestId,
  EventId,
  RuntimeSessionId,
  ThreadId,
  type EnvironmentApi,
  type OrchestrationThreadActivity,
} from "@ryco/contracts";
import { describe, expect, it, vi } from "vitest";
import { pendingRequestActivityInOrchestrationOrder } from "@ryco/shared/threadActivity";
import { derivePendingUserInputs } from "./session-logic.ts";
import { submitApprovalResponse, submitUserInputResponse } from "./approvalResponses.ts";

const identity = {
  requestEventId: EventId.make("question-2"),
  runtimeSessionId: RuntimeSessionId.make("runtime-2"),
};
const activity = (
  sequence: number,
  kind: string,
  payload: Record<string, unknown>,
): OrchestrationThreadActivity =>
  pendingRequestActivityInOrchestrationOrder(
    {
      id: EventId.make(`activity-${sequence}`),
      kind,
      payload: { requestId: "reused", ...payload },
      tone: "info",
      turnId: null,
      summary: kind,
      createdAt: "2026-09-15T00:00:00.000Z",
      sequence: 1000,
    },
    sequence,
  );
const requested = activity(1, "user-input.requested", {
  userInputIdentity: identity,
  questions: [
    {
      id: "q",
      header: "Continue",
      question: "Continue?",
      options: [{ label: "Yes", description: "Continue" }],
      multiSelect: false,
    },
  ],
});

describe("question recovery", () => {
  it("keeps uncertain delivery claimed across snapshots and ignores old outcomes", () => {
    const events = [
      requested,
      activity(2, "user-input.response.submitted", {
        userInputIdentity: identity,
        responseAttemptId: "attempt",
        responseState: "submitting",
      }),
      activity(3, "provider.user-input.respond.failed", {
        userInputIdentity: identity,
        responseAttemptId: "attempt",
        responseState: "uncertain",
        detail: "connection closed",
      }),
      activity(4, "user-input.resolved", {
        userInputIdentity: { ...identity, requestEventId: "question-1" },
        runtimeSessionId: identity.runtimeSessionId,
      }),
    ];
    expect(derivePendingUserInputs(events)).toMatchObject([
      { userInputIdentity: identity, responseState: "uncertain", responseAttemptId: "attempt" },
    ]);
    expect(
      derivePendingUserInputs([
        ...events,
        activity(5, "user-input.resolved", {
          userInputIdentity: identity,
          runtimeSessionId: identity.runtimeSessionId,
          responseAttemptId: "attempt",
        }),
      ]),
    ).toEqual([]);
    expect(
      derivePendingUserInputs([
        ...events,
        activity(5, "provider.user-input.respond.failed", {
          userInputIdentity: identity,
          responseAttemptId: "attempt",
          responseState: "invalidated",
        }),
      ]),
    ).toEqual([]);
  });

  it("coalesces duplicate submissions but separates callback generations and approval IDs", async () => {
    const submit = vi.fn(async () => undefined);
    const input = {
      api: {} as EnvironmentApi,
      threadId: ThreadId.make("thread"),
      requestId: ApprovalRequestId.make("reused"),
      userInputIdentity: identity,
      submit,
    };
    const first = submitUserInputResponse(input);
    expect(submitUserInputResponse(input)).toBe(first);
    await Promise.all([
      first,
      submitUserInputResponse({
        ...input,
        userInputIdentity: { ...identity, requestEventId: EventId.make("question-3") },
      }),
      submitApprovalResponse({ ...input, approvalIdentity: identity, decision: "accept" }),
    ]);
    expect(submit).toHaveBeenCalledTimes(3);
  });
});
