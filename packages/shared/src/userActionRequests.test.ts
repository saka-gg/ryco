import { describe, expect, it } from "vite-plus/test";
import { UserActionRequestId } from "@ryco/contracts/user-action-request";

import { derivePendingThreadRequestState } from "./pendingThreadRequests.ts";
import { hasPendingUserActionRequest, isThreadActivityMilestone } from "./threadActivity.ts";
import { userActionRequestLabel } from "./userActionRequests.ts";
import { deriveUserActionRequests, pendingUserActionRequests } from "./userActionRequestState.ts";

const requestId = UserActionRequestId.make(`user-action-${"a".repeat(32)}`);
const otherId = UserActionRequestId.make(`user-action-${"b".repeat(32)}`);
const expiresAt = "2026-11-21T12:10:00.000Z";

const requested = (id = requestId, overrides: Record<string, unknown> = {}) => ({
  id: `${id}:requested`,
  kind: "user-action.requested",
  createdAt: "2026-11-21T12:00:00.000Z",
  turnId: "turn-1",
  payload: {
    requestId: id,
    surface: "browser",
    need: "sign-in",
    message: "Sign in to Jira with your company account.",
    target: "tab-3",
    expiresAt,
  },
  ...overrides,
});
const resolved = (outcome: string, id = requestId, createdAt = "2026-11-21T12:05:00.000Z") => ({
  id: `${id}:resolved`,
  kind: "user-action.resolved",
  createdAt,
  turnId: "turn-1",
  payload: { requestId: id, outcome },
});

describe("deriveUserActionRequests", () => {
  it("reads a request as pending until it ends, and the first outcome wins", () => {
    expect(deriveUserActionRequests([requested()])).toEqual([
      expect.objectContaining({
        requestId,
        surface: "browser",
        need: "sign-in",
        target: "tab-3",
        turnId: "turn-1",
        status: "pending",
      }),
    ]);
    const ended = deriveUserActionRequests([
      requested(),
      resolved("condition-met"),
      resolved("declined", requestId, "2026-11-21T12:06:00.000Z"),
    ]);
    expect(ended.map((request) => request.status)).toEqual(["condition-met"]);
  });

  it("closes a request whose outcome was recorded first, and ignores a repeated request", () => {
    const early = deriveUserActionRequests([
      resolved("done", requestId, "2026-11-21T11:59:00.000Z"),
      requested(),
      requested(requestId, { id: "again", createdAt: "2026-11-21T12:01:00.000Z" }),
    ]);
    expect(early).toHaveLength(1);
    expect(early[0]?.status).toBe("done");
  });

  it("drops payloads the contract refuses", () => {
    const tooLong = requested(otherId, {
      payload: { ...requested(otherId).payload, message: "x".repeat(301) },
    });
    const badSurface = requested(otherId, {
      payload: { ...requested(otherId).payload, surface: "desktop" },
    });
    expect(deriveUserActionRequests([tooLong, badSurface])).toEqual([]);
    expect(deriveUserActionRequests([requested(), resolved("maybe")])[0]?.status).toBe("pending");
  });

  it("reads an unanswered request past its expiry as timed out", () => {
    const before = Date.parse("2026-11-21T12:09:59.000Z");
    const after = Date.parse(expiresAt);
    expect(pendingUserActionRequests([requested()], before)).toHaveLength(1);
    expect(pendingUserActionRequests([requested()], after)).toEqual([]);
    expect(deriveUserActionRequests([requested()], after)[0]?.status).toBe("timeout");
  });
});

describe("user action requests as pending input", () => {
  it("count as pending user input until they end or expire", () => {
    const now = Date.parse("2026-11-21T12:01:00.000Z");
    expect(derivePendingThreadRequestState([requested()], now)).toMatchObject({
      pendingUserInputCount: 1,
      hasPendingUserInput: true,
      hasPendingApprovals: false,
    });
    expect(
      derivePendingThreadRequestState([requested(), resolved("done")], now).hasPendingUserInput,
    ).toBe(false);
    expect(
      derivePendingThreadRequestState([requested()], Date.parse(expiresAt)).hasPendingUserInput,
    ).toBe(false);
  });

  it("are milestones the activity cap keeps", () => {
    expect(isThreadActivityMilestone(requested())).toBe(true);
    expect(isThreadActivityMilestone(resolved("done"))).toBe(true);
  });
});

describe("userActionRequestLabel", () => {
  it("names the need and the surface, never the message", () => {
    expect(userActionRequestLabel({ surface: "browser", need: "sign-in" })).toBe(
      "Login required in browser",
    );
    expect(userActionRequestLabel({ surface: "terminal", need: "input" })).toBe(
      "Your input needed in terminal",
    );
  });
});

describe("hasPendingUserActionRequest", () => {
  it("is true while a request waits and false once it ended or expired", () => {
    const now = Date.parse("2026-11-21T12:01:00.000Z");
    expect(hasPendingUserActionRequest([requested()], now)).toBe(true);
    expect(hasPendingUserActionRequest([requested(), resolved("declined")], now)).toBe(false);
    expect(hasPendingUserActionRequest([requested()], Date.parse(expiresAt))).toBe(false);
    expect(hasPendingUserActionRequest([{ kind: "tool.completed", payload: {} }], now)).toBe(false);
  });
});
