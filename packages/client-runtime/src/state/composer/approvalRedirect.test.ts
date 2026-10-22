import { describe, expect, it, vi } from "vitest";
import { ApprovalRequestId, EventId, RuntimeSessionId, TurnId } from "@ryco/contracts";

import type { PendingApproval } from "../session/session-logic.ts";
import {
  APPROVAL_REDIRECT_MIN_VISIBLE_MS,
  approvalRedirectRefusalDeclined,
  approvalRedirectTooSoon,
  declineApprovalsForRedirect,
  describeApprovalRedirectRefusal,
  recordApprovalSightings,
  resolveApprovalRedirect,
  type ApprovalRedirect,
  type PendingApprovalSource,
} from "./approvalRedirect.ts";

const RUNTIME = RuntimeSessionId.make("runtime-live");
const TURN = TurnId.make("turn-live");

function approval(id: string, overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    requestId: ApprovalRequestId.make(id),
    requestKind: "command",
    createdAt: "2026-10-22T00:00:00.000Z",
    turnId: TURN,
    approvalIdentity: { requestEventId: EventId.make(`event-${id}`), runtimeSessionId: RUNTIME },
    ...overrides,
  };
}

function redirectOf(
  approvals: ReadonlyArray<PendingApproval>,
): Extract<ApprovalRedirect, { kind: "decline" }> {
  return {
    kind: "decline",
    approvals,
    seenRequestIds: approvals.map((pending) => pending.requestId),
    runtimeSessionId: RUNTIME,
    turnId: TURN,
  };
}

const LIVE = {
  runtimeSessionId: RUNTIME,
  activeTurnId: TURN,
  steerAllowed: true,
  questionPending: false,
} as const;

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

describe("resolveApprovalRedirect", () => {
  it("declines every answerable approval the user saw", () => {
    const first = approval("first");
    const retry = approval("retry", { responseState: "retryable", responseAttemptId: "attempt-1" });
    expect(resolveApprovalRedirect({ ...LIVE, approvals: [first, retry] })).toEqual(
      redirectOf([first, retry]),
    );
  });

  it("leaves the send to the follow-up setting while an approval is being answered", () => {
    for (const responseState of ["submitting", "uncertain"] as const) {
      expect(
        resolveApprovalRedirect({
          ...LIVE,
          approvals: [approval("idle"), approval("busy", { responseState })],
        }),
      ).toEqual({ kind: "none" });
    }
    expect(
      resolveApprovalRedirect({
        ...LIVE,
        approvals: [approval("clicked")],
        respondingRequestIds: [ApprovalRequestId.make("clicked")],
      }),
    ).toEqual({ kind: "none" });
  });

  it("only redirects a message that can steer, and never over a question", () => {
    const approvals = [approval("a")];
    expect(resolveApprovalRedirect({ ...LIVE, approvals, steerAllowed: false })).toEqual({
      kind: "none",
    });
    expect(resolveApprovalRedirect({ ...LIVE, approvals, questionPending: true })).toEqual({
      kind: "none",
    });
  });

  it("skips approvals the provider can no longer answer", () => {
    expect(
      resolveApprovalRedirect({
        ...LIVE,
        approvals: [
          approval("ended-runtime", {
            approvalIdentity: {
              requestEventId: EventId.make("event-old"),
              runtimeSessionId: RuntimeSessionId.make("runtime-ended"),
            },
          }),
          {
            requestId: ApprovalRequestId.make("no-identity"),
            requestKind: "command",
            createdAt: "2026-10-22T00:00:00.000Z",
          },
        ],
      }),
    ).toEqual({ kind: "none" });
    expect(
      resolveApprovalRedirect({ ...LIVE, approvals: [approval("a")], runtimeSessionId: null }),
    ).toEqual({ kind: "none" });
  });

  it("steers on the turn an earlier redirect declined without sending", () => {
    expect(resolveApprovalRedirect({ ...LIVE, approvals: [], redirectedTurnId: TURN })).toEqual({
      kind: "steer",
    });
    expect(
      resolveApprovalRedirect({
        ...LIVE,
        approvals: [approval("busy", { responseState: "submitting" })],
        redirectedTurnId: TURN,
      }),
    ).toEqual({ kind: "steer" });
    expect(
      resolveApprovalRedirect({ ...LIVE, approvals: [], redirectedTurnId: "turn-earlier" }),
    ).toEqual({ kind: "none" });
    expect(
      resolveApprovalRedirect({
        ...LIVE,
        approvals: [],
        redirectedTurnId: TURN,
        steerAllowed: false,
      }),
    ).toEqual({ kind: "none" });
  });
});

describe("approval sightings", () => {
  it("keeps the first sighting and forgets approvals no longer pending", () => {
    const first = approval("first");
    const second = approval("second");
    const once = recordApprovalSightings(new Map(), [first], 1_000);
    expect(recordApprovalSightings(once, [first], 2_000)).toBe(once);
    const twice = recordApprovalSightings(once, [first, second], 3_000);
    expect([...twice]).toEqual([
      [first.requestId, 1_000],
      [second.requestId, 3_000],
    ]);
    expect([...recordApprovalSightings(twice, [second], 4_000)]).toEqual([
      [second.requestId, 3_000],
    ]);
  });

  it("holds back a redirect over an approval shown too recently to have been read", () => {
    const shown = approval("shown");
    const sightings = recordApprovalSightings(new Map(), [shown], 1_000);
    const redirect = redirectOf([shown]);
    expect(approvalRedirectTooSoon(redirect, sightings, 1_100)).toBe(true);
    expect(
      approvalRedirectTooSoon(redirect, sightings, 1_000 + APPROVAL_REDIRECT_MIN_VISIBLE_MS),
    ).toBe(false);
    expect(approvalRedirectTooSoon(redirect, new Map(), 1_000_000)).toBe(true);
  });
});

describe("declineApprovalsForRedirect", () => {
  it("resolves only once the provider took every decline", async () => {
    const first = approval("first");
    const second = approval("second");
    const projection = fakeSource([first, second]);
    const decline = vi.fn(async (_approval: PendingApproval) => undefined);
    const outcome = declineApprovalsForRedirect({
      redirect: redirectOf([first, second]),
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
    await expect(outcome).resolves.toEqual({ kind: "declined", declined: 2 });
    expect(projection.listeners.size).toBe(0);
  });

  it("declines the approvals the redirected turn opens meanwhile", async () => {
    const first = approval("first");
    const next = approval("next-tool");
    const projection = fakeSource([first]);
    const decline = vi.fn(async (declined: PendingApproval) => {
      // The provider takes the decline and asks about the next tool of the same batch.
      if (declined === first) projection.set([next]);
      else projection.set([]);
    });
    await expect(
      declineApprovalsForRedirect({
        redirect: redirectOf([first]),
        decline,
        source: projection.source,
      }),
    ).resolves.toEqual({ kind: "declined", declined: 2 });
    expect(decline.mock.calls.map(([declined]) => declined)).toEqual([first, next]);
    expect(projection.listeners.size).toBe(0);
  });

  it("stops at the first refused decline and counts the ones taken", async () => {
    const first = approval("first");
    const second = approval("second");
    const decline = vi.fn(async (declined: PendingApproval) => {
      if (declined === second) throw new Error("Approval is no longer pending.");
    });
    await expect(
      declineApprovalsForRedirect({
        redirect: redirectOf([first, second]),
        decline,
        source: fakeSource([first, second]).source,
      }),
    ).resolves.toEqual({ kind: "refused", declined: 1, error: "Approval is no longer pending." });
    expect(decline).toHaveBeenCalledTimes(2);
  });

  it("reports a decline that ends uncertain or undelivered, but not an earlier attempt's state", async () => {
    for (const responseState of ["uncertain", "retryable"] as const) {
      const earlier = approval("earlier", {
        responseState: "retryable",
        responseAttemptId: "attempt-earlier",
      });
      const projection = fakeSource([earlier]);
      const outcome = declineApprovalsForRedirect({
        redirect: redirectOf([earlier]),
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
      await expect(outcome).resolves.toEqual({ kind: "undelivered", declined: 1 });
    }
  });

  it("gives up at the deadline, follow-on declines included", async () => {
    vi.useFakeTimers();
    try {
      const pending = approval("slow");
      const projection = fakeSource([pending]);
      const decline = vi.fn(async () => undefined);
      const outcome = declineApprovalsForRedirect({
        redirect: redirectOf([pending]),
        decline,
        source: projection.source,
        timeoutMs: 1_000,
      });
      await vi.advanceTimersByTimeAsync(600);
      projection.set([pending, approval("next-tool")]);
      await vi.advanceTimersByTimeAsync(400);
      await expect(outcome).resolves.toEqual({ kind: "timed-out", declined: 2 });
      expect(projection.listeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops when an approval of another turn arrives while the declines settle", async () => {
    const seen = approval("seen");
    const projection = fakeSource([seen]);
    const outcome = declineApprovalsForRedirect({
      redirect: redirectOf([seen]),
      decline: async () => {
        projection.set([approval("next-turn", { turnId: TurnId.make("turn-next") })]);
      },
      source: projection.source,
    });
    await expect(outcome).resolves.toEqual({ kind: "approval-arrived", declined: 1 });
  });

  it("ignores an approval of another runtime arriving meanwhile", async () => {
    const seen = approval("seen");
    const stale = approval("stale", {
      approvalIdentity: {
        requestEventId: EventId.make("event-stale"),
        runtimeSessionId: RuntimeSessionId.make("runtime-ended"),
      },
    });
    const projection = fakeSource([seen]);
    await expect(
      declineApprovalsForRedirect({
        redirect: redirectOf([seen]),
        decline: async () => {
          projection.set([stale]);
        },
        source: projection.source,
      }),
    ).resolves.toEqual({ kind: "declined", declined: 1 });
  });
});

describe("describeApprovalRedirectRefusal", () => {
  it("always says the message was not sent", () => {
    for (const refusal of [
      { kind: "just-arrived" },
      { kind: "draft-changed", declined: 1 },
      { kind: "refused", declined: 0, error: null },
      { kind: "undelivered", declined: 1 },
      { kind: "timed-out", declined: 1 },
      { kind: "approval-arrived", declined: 1 },
    ] as const) {
      expect(describeApprovalRedirectRefusal(refusal).description).toMatch(
        /wasn't sent|Send it again/,
      );
    }
    expect(
      describeApprovalRedirectRefusal({ kind: "refused", declined: 0, error: "Node refused." }),
    ).toEqual({
      title: "Couldn't decline the approval",
      description: "Your message wasn't sent. Node refused.",
    });
  });

  it("says when some approvals were declined before the refusal", () => {
    expect(
      describeApprovalRedirectRefusal({ kind: "refused", declined: 1, error: null }).title,
    ).toBe("Couldn't decline every approval");
    expect(approvalRedirectRefusalDeclined({ kind: "refused", declined: 1, error: null })).toBe(
      true,
    );
    expect(approvalRedirectRefusalDeclined({ kind: "refused", declined: 0, error: null })).toBe(
      false,
    );
    expect(approvalRedirectRefusalDeclined({ kind: "just-arrived" })).toBe(false);
  });
});
