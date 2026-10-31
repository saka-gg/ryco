import { describe, expect, it } from "vite-plus/test";
import { SecretRequestId } from "@ryco/contracts/secret-request";

import { canSettleThread, type ThreadSettlementInput } from "./threadSettlement.ts";
import {
  derivePendingProviderCallbackRequests,
  derivePendingThreadRequestState,
  derivePendingThreadRequests,
  isThreadActivityMilestone,
} from "./threadActivity.ts";
import { deriveSecretRequests, pendingSecretRequests } from "./secretRequests.ts";

const requestId = SecretRequestId.make(`secret-request-${"a".repeat(32)}`);
const otherId = SecretRequestId.make(`secret-request-${"b".repeat(32)}`);
const expiresAt = "2026-10-31T12:00:00.000Z";

const requested = (id = requestId, overrides: Record<string, unknown> = {}) => ({
  id: `${id}:requested`,
  kind: "secret.requested",
  createdAt: "2026-10-30T12:00:00.000Z",
  turnId: "turn-1",
  payload: { requestId: id, key: "STRIPE_KEY", purpose: "Charge cards", file: ".env", expiresAt },
  ...overrides,
});
const resolved = (status: string, id = requestId, createdAt = "2026-10-30T12:05:00.000Z") => ({
  id: `${id}:resolved`,
  kind: "secret.resolved",
  createdAt,
  turnId: "turn-1",
  payload: { requestId: id, status },
});

describe("deriveSecretRequests", () => {
  it("reads a request as pending until it is resolved, and the first resolution wins", () => {
    expect(deriveSecretRequests([requested()]).map((request) => request.status)).toEqual([
      "pending",
    ]);
    const answered = deriveSecretRequests([
      requested(),
      resolved("provided"),
      resolved("declined", requestId, "2026-10-30T12:06:00.000Z"),
    ]);
    expect(answered).toEqual([
      expect.objectContaining({
        requestId,
        key: "STRIPE_KEY",
        purpose: "Charge cards",
        file: ".env",
        expiresAt,
        turnId: "turn-1",
        status: "provided",
      }),
    ]);
  });

  it("reads an unanswered request past its expiry as expired, but only with a clock", () => {
    const after = Date.parse(expiresAt);
    expect(deriveSecretRequests([requested()], after - 1)[0]?.status).toBe("pending");
    expect(deriveSecretRequests([requested()], after)[0]?.status).toBe("expired");
    expect(deriveSecretRequests([requested()])[0]?.status).toBe("pending");
    // An unreadable expiry fails closed.
    expect(
      deriveSecretRequests(
        [requested(requestId, { payload: { ...requested().payload, expiresAt: "?" } })],
        0,
      )[0]?.status,
    ).toBe("expired");
    // Answered requests keep their outcome.
    expect(deriveSecretRequests([requested(), resolved("declined")], after)[0]?.status).toBe(
      "declined",
    );
  });

  it("ignores malformed payloads, a repeated request and a resolution without a request", () => {
    const requests = deriveSecretRequests([
      requested(requestId, {
        payload: { requestId, key: "lower", purpose: "x", file: ".env", expiresAt },
      }),
      resolved("provided", otherId),
      requested(),
      requested(requestId, {
        id: "repeat",
        createdAt: "2026-10-30T12:01:00.000Z",
        payload: { ...requested().payload, key: "OTHER_KEY" },
      }),
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.key).toBe("STRIPE_KEY");
    expect(requests[0]?.status).toBe("pending");
  });

  it("lists only the unanswered, unexpired requests as pending", () => {
    const activities = [requested(), requested(otherId), resolved("declined", otherId)];
    expect(pendingSecretRequests(activities, 0).map((request) => request.requestId)).toEqual([
      requestId,
    ]);
  });
});

describe("secret requests as pending requests", () => {
  it("counts a pending secret request as blocking user input until it is resolved", () => {
    expect(derivePendingThreadRequests([requested()])).toEqual([
      { requestId, turnId: "turn-1", kind: "secret" },
    ]);
    expect(derivePendingThreadRequestState([requested()])).toMatchObject({
      pendingUserInputCount: 1,
      hasPendingUserInput: true,
    });
    for (const status of ["provided", "declined", "expired"]) {
      expect(derivePendingThreadRequestState([requested(), resolved(status)])).toMatchObject({
        pendingUserInputCount: 0,
        hasPendingUserInput: false,
      });
    }
    // Answered once: the same request asked again stays answered.
    expect(
      derivePendingThreadRequests([
        requested(),
        resolved("provided"),
        requested(requestId, { id: "again", createdAt: "2026-10-30T12:10:00.000Z" }),
      ]),
    ).toEqual([]);
  });

  it("leaves secret requests out of the provider callbacks a turn's end or a restart clears", () => {
    expect(derivePendingProviderCallbackRequests([requested()])).toEqual([]);
  });

  it("blocks settling a thread while a secret request waits", () => {
    const state = derivePendingThreadRequestState([requested()]);
    const input: ThreadSettlementInput = {
      threadSettlementSupported: true,
      archivedAt: null,
      deletedAt: null,
      worktreeArchivedAt: null,
      settledOverride: null,
      settledAt: null,
      sessionStatus: "ready",
      latestTurnState: "completed",
      latestTurnRequestedAt: null,
      latestTurnStartedAt: null,
      latestTurnCompletedAt: null,
      latestUserMessageAt: null,
      hasPendingApprovals: state.hasPendingApprovals,
      hasPendingUserInput: state.hasPendingUserInput,
      hasLocalQueuedMessage: false,
      deliveryUnknown: false,
      pinned: false,
      backgroundLiveness: null,
      pullRequestWatched: false,
      prNumber: null,
      prState: null,
      prTerminalAt: null,
      worktreeUpdatedAt: null,
      updatedAt: null,
      createdAt: "2026-10-30T12:00:00.000Z",
      autoSettleAfterDays: 3,
      nowMs: Date.parse("2026-10-30T13:00:00.000Z"),
    };
    expect(canSettleThread(input)).toEqual({ canSettle: false, blocker: "pending-user-input" });
    const answered = derivePendingThreadRequestState([requested(), resolved("provided")]);
    expect(
      canSettleThread({ ...input, hasPendingUserInput: answered.hasPendingUserInput }),
    ).toEqual({ canSettle: true, blocker: null });
  });

  it("keeps secret request activities through the activity cap", () => {
    expect(isThreadActivityMilestone(requested())).toBe(true);
    expect(isThreadActivityMilestone(resolved("provided"))).toBe(true);
  });
});
