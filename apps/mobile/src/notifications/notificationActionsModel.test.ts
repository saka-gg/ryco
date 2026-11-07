import { ApprovalRequestId, EnvironmentId, ThreadId, TurnId } from "@ryco/contracts";
import type { PendingApproval } from "@ryco/client-runtime/state/session";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_NOTIFICATION_ACTION_ID,
  NOTIFICATION_ACTION_IDS,
  NOTIFICATION_ACTION_TTL_MS,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_REPLY_GRACE_MS,
  decideNotificationThreadAction,
  notificationCategoryForKind,
  notificationRouteOf,
  type NotificationResponseLike,
  type PendingThreadAction,
} from "./notificationActionsModel";

const environmentId = EnvironmentId.make("env-a");
const threadId = ThreadId.make("thread-a");

function response(
  actionIdentifier: string,
  data: unknown = { environmentId, threadId, kind: "approval", turnId: "turn-1" },
  userText?: string,
): NotificationResponseLike {
  return {
    actionIdentifier,
    ...(userText === undefined ? {} : { userText }),
    notification: { date: 1000, request: { identifier: "alert-1", content: { data } } },
  };
}

function approval(id: string, overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    requestId: ApprovalRequestId.make(id),
    requestKind: "command",
    createdAt: "2026-11-07T10:00:00.000Z",
    turnId: TurnId.make("turn-1"),
    ...overrides,
  };
}

const T = 1_000_000;
const approve: PendingThreadAction = { action: { kind: "approve", turnId: "turn-1" }, at: T };

describe("notification categories", () => {
  it("give every kind a category, and approvals Approve and Deny behind an unlocked phone", () => {
    expect(notificationCategoryForKind("approval")).toBe("ryco.approval");
    expect(notificationCategoryForKind("input")).toBe("ryco.answer");
    expect(notificationCategoryForKind("plan-ready")).toBe("ryco.answer");
    expect(notificationCategoryForKind("completed")).toBe("ryco.result");
    expect(notificationCategoryForKind("failed")).toBe("ryco.result");
    expect(notificationCategoryForKind("stopped")).toBe("ryco.result");

    const approvalCategory = NOTIFICATION_CATEGORIES.find(
      (category) => category.identifier === "ryco.approval",
    );
    expect(approvalCategory?.actions.map((action) => action.buttonTitle)).toEqual([
      "Approve",
      "Deny",
    ]);
    // Every action opens Ryco: none runs in the background.
    for (const category of NOTIFICATION_CATEGORIES) {
      for (const action of category.actions) {
        expect(action.options.opensAppToForeground).toBe(true);
        if (action.identifier !== NOTIFICATION_ACTION_IDS.open) {
          expect(action.options.isAuthenticationRequired).toBe(true);
        }
      }
    }
  });
});

describe("notificationRouteOf", () => {
  it("opens the thread on a tap or Open", () => {
    expect(notificationRouteOf(response(DEFAULT_NOTIFICATION_ACTION_ID))).toEqual({
      ref: { environmentId, threadId },
      action: null,
      responseKey: `alert-1:1000:${DEFAULT_NOTIFICATION_ACTION_ID}`,
    });
    expect(notificationRouteOf(response(NOTIFICATION_ACTION_IDS.open))?.action).toBeNull();
  });

  it("binds Approve and Deny to the alert's turn", () => {
    expect(notificationRouteOf(response(NOTIFICATION_ACTION_IDS.approve))?.action).toEqual({
      kind: "approve",
      turnId: "turn-1",
    });
    expect(
      notificationRouteOf(response(NOTIFICATION_ACTION_IDS.deny, { environmentId, threadId }))
        ?.action,
    ).toEqual({ kind: "deny", turnId: null });
  });

  it("sends a reply's text, and only opens for an empty one", () => {
    expect(
      notificationRouteOf(response(NOTIFICATION_ACTION_IDS.reply, undefined, "  ship it "))?.action,
    ).toEqual({ kind: "reply", text: "ship it" });
    expect(
      notificationRouteOf(response(NOTIFICATION_ACTION_IDS.reply, undefined, "  "))?.action,
    ).toBeNull();
  });

  it("ignores a notification that names no thread, and unknown actions", () => {
    expect(notificationRouteOf(response(DEFAULT_NOTIFICATION_ACTION_ID, {}))).toBeNull();
    expect(notificationRouteOf(response("com.apple.UNNotificationDismissActionIdentifier"))).toBe(
      null,
    );
  });
});

describe("decideNotificationThreadAction", () => {
  const base = { nowMs: T + 1_000, threadLoaded: true, ready: true };

  it("waits for a ready connection, then answers the one approval of the alert's turn", () => {
    expect(
      decideNotificationThreadAction({
        ...base,
        ready: false,
        pending: approve,
        pendingApprovals: [approval("a")],
      }),
    ).toEqual({ kind: "wait" });
    expect(
      decideNotificationThreadAction({
        ...base,
        pending: approve,
        pendingApprovals: [approval("a"), approval("other", { turnId: TurnId.make("turn-0") })],
      }),
    ).toEqual({
      kind: "respond",
      approval: { requestId: "a", approvalIdentity: undefined },
      decision: "accept",
    });
    expect(
      decideNotificationThreadAction({
        ...base,
        pending: { action: { kind: "deny", turnId: null }, at: T },
        pendingApprovals: [approval("a")],
      }),
    ).toMatchObject({ kind: "respond", decision: "decline" });
  });

  it("refuses when the approval was answered, is on its way, or cannot be told apart", () => {
    expect(
      decideNotificationThreadAction({ ...base, pending: approve, pendingApprovals: [] }),
    ).toMatchObject({ kind: "refuse", message: "That approval was already answered." });
    expect(
      decideNotificationThreadAction({
        ...base,
        pending: approve,
        pendingApprovals: [approval("a", { responseState: "submitting" })],
      }),
    ).toMatchObject({ kind: "refuse" });
    expect(
      decideNotificationThreadAction({
        ...base,
        pending: approve,
        pendingApprovals: [approval("a"), approval("b")],
      }),
    ).toMatchObject({ kind: "refuse", message: expect.stringContaining("Several approvals") });
  });

  it("gives up on an approval the machine did not become ready for in time", () => {
    expect(
      decideNotificationThreadAction({
        ...base,
        ready: false,
        nowMs: T + NOTIFICATION_ACTION_TTL_MS,
        pending: approve,
        pendingApprovals: [approval("a")],
      }),
    ).toMatchObject({ kind: "refuse" });
  });

  it("sends a reply once ready, or after the grace through the outbox", () => {
    const reply: PendingThreadAction = { action: { kind: "reply", text: "go on" }, at: T };
    expect(
      decideNotificationThreadAction({
        ...base,
        ready: false,
        pending: reply,
        pendingApprovals: [],
      }),
    ).toEqual({ kind: "wait" });
    expect(
      decideNotificationThreadAction({ ...base, pending: reply, pendingApprovals: [] }),
    ).toEqual({ kind: "send", text: "go on" });
    expect(
      decideNotificationThreadAction({
        ...base,
        ready: false,
        nowMs: T + NOTIFICATION_REPLY_GRACE_MS,
        pending: reply,
        pendingApprovals: [],
      }),
    ).toEqual({ kind: "send", text: "go on" });
    expect(
      decideNotificationThreadAction({
        ...base,
        threadLoaded: false,
        nowMs: T + NOTIFICATION_ACTION_TTL_MS,
        pending: reply,
        pendingApprovals: [],
      }),
    ).toMatchObject({ kind: "refuse" });
  });
});
