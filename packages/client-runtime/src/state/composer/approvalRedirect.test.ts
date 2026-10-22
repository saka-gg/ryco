import { describe, expect, it, vi } from "vitest";
import { ApprovalRequestId, EventId, RuntimeSessionId } from "@ryco/contracts";

import type { PendingApproval } from "../session/session-logic.ts";
import {
  declineApprovalsForRedirect,
  describeApprovalRedirectRefusal,
  planApprovalRedirect,
  type PendingApprovalSource,
} from "./approvalRedirect.ts";

const RUNTIME = RuntimeSessionId.make("runtime-live");

function approval(id: string, overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    requestId: ApprovalRequestId.make(id),
    requestKind: "command",
    createdAt: "2026-10-22T00:00:00.000Z",
    approvalIdentity: { requestEventId: EventId.make(`event-${id}`), runtimeSessionId: RUNTIME },
    ...overrides,
  };
}

/** A hand-driven projection: `set` replaces the pending list and notifies listeners. */
function fakeSource(initial: ReadonlyArray<PendingApproval>) {
  let approvals = initial;
  const listeners = new Set<() => void>();
  const source: PendingApprovalSource = {
    read: () => approvals,
    subscribe: (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
  };
  return {
    source,
    listeners,
    set: (next: ReadonlyArray<PendingApproval>) => {
      approvals = next;
      for (const listener of listeners) listener();
    },
  };
}

describe("planApprovalRedirect", () => {
  it("declines every answerable approval the user saw", () => {
    const first = approval("first");
    const retry = approval("retry", { responseState: "retryable", responseAttemptId: "attempt-1" });
    expect(planApprovalRedirect({ approvals: [first, retry], runtimeSessionId: RUNTIME })).toEqual({
      kind: "decline",
      approvals: [first, retry],
      seenRequestIds: [first.requestId, retry.requestId],
    });
  });

  it("refuses while an approval is being answered or its delivery is unknown", () => {
    for (const responseState of ["submitting", "uncertain"] as const) {
      expect(
        planApprovalRedirect({
          approvals: [approval("idle"), approval("busy", { responseState })],
          runtimeSessionId: RUNTIME,
        }),
      ).toEqual({ kind: "blocked" });
    }
    expect(
      planApprovalRedirect({
        approvals: [approval("clicked")],
        runtimeSessionId: RUNTIME,
        respondingRequestIds: [ApprovalRequestId.make("clicked")],
      }),
    ).toEqual({ kind: "blocked" });
  });

  it("skips approvals the provider can no longer answer", () => {
    expect(
      planApprovalRedirect({
        approvals: [
          approval("ended-runtime", {
            approvalIdentity: {
              requestEventId: EventId.make("event-old"),
              runtimeSessionId: RuntimeSessionId.make("runtime-ended"),
            },
            responseState: "uncertain",
          }),
          {
            requestId: ApprovalRequestId.make("no-identity"),
            requestKind: "command",
            createdAt: "2026-10-22T00:00:00.000Z",
          },
        ],
        runtimeSessionId: RUNTIME,
      }),
    ).toEqual({ kind: "none" });
    expect(planApprovalRedirect({ approvals: [approval("a")], runtimeSessionId: null })).toEqual({
      kind: "none",
    });
  });
});

describe("declineApprovalsForRedirect", () => {
  it("resolves only once the provider took every decline", async () => {
    const first = approval("first");
    const second = approval("second");
    const projection = fakeSource([first, second]);
    const decline = vi.fn(async (_approval: PendingApproval) => undefined);
    const outcome = declineApprovalsForRedirect({
      plan: {
        kind: "decline",
        approvals: [first, second],
        seenRequestIds: [first.requestId, second.requestId],
      },
      decline,
      source: projection.source,
    });
    let settled = false;
    void outcome.then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(decline).toHaveBeenCalledTimes(2));
    expect(decline.mock.calls.map(([declined]) => declined)).toEqual([first, second]);
    projection.set([
      { ...first, responseState: "submitting", responseAttemptId: "attempt-first" },
      second,
    ]);
    projection.set([second]);
    await Promise.resolve();
    expect(settled).toBe(false);
    projection.set([]);
    await expect(outcome).resolves.toEqual({ kind: "declined" });
    expect(projection.listeners.size).toBe(0);
  });

  it("stops at the first refused decline", async () => {
    const first = approval("first");
    const second = approval("second");
    const decline = vi.fn(async () => {
      throw new Error("Approval is no longer pending.");
    });
    await expect(
      declineApprovalsForRedirect({
        plan: {
          kind: "decline",
          approvals: [first, second],
          seenRequestIds: [first.requestId, second.requestId],
        },
        decline,
        source: fakeSource([first, second]).source,
      }),
    ).resolves.toEqual({ kind: "refused", error: "Approval is no longer pending." });
    expect(decline).toHaveBeenCalledTimes(1);
  });

  it("reports a decline that ends uncertain or undelivered, but not an earlier attempt's state", async () => {
    for (const responseState of ["uncertain", "retryable"] as const) {
      const earlier = approval("earlier", {
        responseState: "retryable",
        responseAttemptId: "attempt-earlier",
      });
      const projection = fakeSource([earlier]);
      const outcome = declineApprovalsForRedirect({
        plan: { kind: "decline", approvals: [earlier], seenRequestIds: [earlier.requestId] },
        decline: async () => undefined,
        source: projection.source,
      });
      let result: unknown = null;
      void outcome.then((value) => {
        result = value;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(result).toBeNull();
      projection.set([{ ...earlier, responseState, responseAttemptId: "attempt-redirect" }]);
      await expect(outcome).resolves.toEqual({ kind: "undelivered" });
    }
  });

  it("gives up at the deadline", async () => {
    vi.useFakeTimers();
    try {
      const pending = approval("slow");
      const projection = fakeSource([pending]);
      const outcome = declineApprovalsForRedirect({
        plan: { kind: "decline", approvals: [pending], seenRequestIds: [pending.requestId] },
        decline: async () => undefined,
        source: projection.source,
        timeoutMs: 1_000,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(outcome).resolves.toEqual({ kind: "timed-out" });
      expect(projection.listeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops when a new approval arrives while the declines settle", async () => {
    const seen = approval("seen");
    const projection = fakeSource([seen]);
    const outcome = declineApprovalsForRedirect({
      plan: { kind: "decline", approvals: [seen], seenRequestIds: [seen.requestId] },
      decline: async () => {
        projection.set([approval("arrived")]);
      },
      source: projection.source,
    });
    await expect(outcome).resolves.toEqual({ kind: "approval-arrived" });
  });
});

describe("describeApprovalRedirectRefusal", () => {
  it("always says the message was not sent", () => {
    for (const refusal of [
      "blocked",
      "draft-changed",
      "refused",
      "undelivered",
      "timed-out",
      "approval-arrived",
    ] as const) {
      expect(describeApprovalRedirectRefusal(refusal).description).toMatch(
        /wasn't sent|Send it again/,
      );
    }
    expect(describeApprovalRedirectRefusal("refused", "Node refused.").description).toBe(
      "Your message wasn't sent. Node refused.",
    );
  });
});
