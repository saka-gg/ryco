import { derivePendingApprovals } from "./session-logic.ts";
import { approvalActivityInOrchestrationOrder } from "@ryco/shared/threadActivity";
import type { OrchestrationThreadActivity } from "@ryco/contracts";
import { describe, expect, it, vi } from "vitest";
import { ApprovalRequestId, EventId, ThreadId, type EnvironmentApi } from "@ryco/contracts";
import { submitApprovalResponse } from "./approvalResponses.ts";

describe("approval submission guard", () => {
  it("claims synchronously across conflicting input and releases after rejection", async () => {
    const api = {} as EnvironmentApi;
    let reject!: (error: Error) => void;
    const submit = vi.fn(
      () =>
        new Promise<void>((_, fail) => {
          reject = fail;
        }),
    );
    const input = {
      api,
      threadId: ThreadId.make("a"),
      requestId: ApprovalRequestId.make("r"),
      approvalIdentity: { requestEventId: EventId.make("open") },
      decision: "accept" as const,
      submit,
    };
    const first = submitApprovalResponse(input);
    const second = submitApprovalResponse({ ...input, decision: "decline" });
    expect(second).toBe(first);
    await Promise.resolve();
    expect(submit).toHaveBeenCalledTimes(1);
    reject(new Error("not sent"));
    await expect(first).rejects.toThrow("not sent");
    await submitApprovalResponse({ ...input, submit: async () => undefined });
  });
  it("does not conflate environments, threads or new callback instances", async () => {
    const submit = vi.fn(async () => undefined);
    const input = {
      api: {} as EnvironmentApi,
      threadId: ThreadId.make("a"),
      requestId: ApprovalRequestId.make("r"),
      approvalIdentity: { requestEventId: EventId.make("open") },
      decision: "accept" as const,
      submit,
    };
    await Promise.all([
      submitApprovalResponse(input),
      submitApprovalResponse({ ...input, api: {} as EnvironmentApi }),
      submitApprovalResponse({ ...input, threadId: ThreadId.make("b") }),
      submitApprovalResponse({
        ...input,
        approvalIdentity: { requestEventId: EventId.make("new") },
      }),
    ]);
    expect(submit).toHaveBeenCalledTimes(4);
  });
});

it("derives durable attempt state in orchestration order, ignoring older callback settlement", () => {
  const identity = { requestEventId: EventId.make("callback-2") };
  const activity = (
    sequence: number,
    kind: string,
    payload: Record<string, unknown>,
  ): OrchestrationThreadActivity =>
    approvalActivityInOrchestrationOrder(
      {
        id: EventId.make(`activity-${sequence}`),
        kind,
        payload: { requestId: "r", ...payload },
        tone: "info",
        turnId: null,
        summary: kind,
        createdAt: "2026-09-15T00:00:00.000Z",
        sequence: 1000,
      },
      sequence,
    );
  const events = [
    activity(1, "approval.requested", { requestKind: "command", approvalIdentity: identity }),
    activity(2, "approval.response.submitted", {
      approvalIdentity: identity,
      responseAttemptId: "attempt-1",
      responseState: "submitting",
    }),
    activity(3, "provider.approval.respond.failed", {
      approvalIdentity: identity,
      responseAttemptId: "attempt-1",
      responseState: "retryable",
    }),
    activity(4, "approval.response.submitted", {
      approvalIdentity: identity,
      responseAttemptId: "attempt-2",
      responseState: "submitting",
    }),
    activity(5, "provider.approval.respond.failed", {
      approvalIdentity: identity,
      responseAttemptId: "attempt-1",
      responseState: "retryable",
    }),
    activity(6, "approval.resolved", {
      approvalIdentity: { requestEventId: "callback-1" },
      responseAttemptId: "older-attempt",
      decision: "accept",
    }),
  ];
  expect(derivePendingApprovals(events)).toMatchObject([
    { responseState: "submitting", responseAttemptId: "attempt-2" },
  ]);
  expect(
    derivePendingApprovals([
      ...events,
      activity(7, "approval.resolved", {
        approvalIdentity: identity,
        responseAttemptId: "attempt-2",
        decision: "decline",
      }),
    ]),
  ).toEqual([]);
});
