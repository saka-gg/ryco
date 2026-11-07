import { ApprovalRequestId, EnvironmentId, ThreadId, TurnId } from "@ryco/contracts";
import type { PendingApproval, PendingUserInput } from "@ryco/client-runtime/state/session";
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
  data: unknown = { environmentId, threadId, kind: "approval", turnId: "turn-1", requestId: "a" },
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

function question(
  id: string,
  questions: PendingUserInput["questions"],
  overrides: Partial<PendingUserInput> = {},
): PendingUserInput {
  return {
    requestId: ApprovalRequestId.make(id),
    createdAt: "2026-11-07T10:00:00.000Z",
    turnId: TurnId.make("turn-1"),
    questions,
    ...overrides,
  };
}

const freeText = [{ id: "q1", header: "Name", question: "What should it be called?", options: [] }];
const withOptions = [
  {
    id: "q1",
    header: "Pick",
    question: "Which one?",
    options: [{ label: "A", description: "The first" }],
  },
];

const T = 1_000_000;
const approve: PendingThreadAction = {
  action: { kind: "approve", turnId: "turn-1", requestId: "a" },
  at: T,
};

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

  it("binds Approve and Deny to the alert's approval and turn", () => {
    expect(notificationRouteOf(response(NOTIFICATION_ACTION_IDS.approve))?.action).toEqual({
      kind: "approve",
      turnId: "turn-1",
      requestId: "a",
    });
    expect(
      notificationRouteOf(response(NOTIFICATION_ACTION_IDS.deny, { environmentId, threadId }))
        ?.action,
    ).toEqual({ kind: "deny", turnId: null, requestId: null });
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
  const base = {
    nowMs: T + 1_000,
    threadLoaded: true,
    ready: true,
    pendingUserInputs: [] as ReadonlyArray<PendingUserInput>,
    composer: { disabled: false, editingQueuedMessage: false },
  };

  it("waits for a ready connection, then answers exactly the approval the alert named", () => {
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
        // Another approval waiting beside it does not matter: the alert named "a".
        pendingApprovals: [approval("b"), approval("a")],
      }),
    ).toEqual({
      kind: "respond",
      approval: { requestId: "a", approvalIdentity: undefined },
      decision: "accept",
    });
    expect(
      decideNotificationThreadAction({
        ...base,
        pending: { action: { kind: "deny", turnId: null, requestId: "a" }, at: T },
        pendingApprovals: [approval("a")],
      }),
    ).toMatchObject({ kind: "respond", decision: "decline" });
  });

  it("never answers a newer approval of the same turn from an older alert", () => {
    // Approval "a" was answered on another device; the agent then asked "b" in the same turn.
    expect(
      decideNotificationThreadAction({
        ...base,
        pending: approve,
        pendingApprovals: [approval("b")],
      }),
    ).toEqual({
      kind: "refuse",
      message: "That approval was already answered. Another one waits here.",
    });
    // The same id in another turn (a restarted provider counting again) is not the same approval.
    expect(
      decideNotificationThreadAction({
        ...base,
        pending: approve,
        pendingApprovals: [approval("a", { turnId: TurnId.make("turn-2") })],
      }),
    ).toMatchObject({ kind: "refuse" });
  });

  it("answers nothing from an alert that names no approval", () => {
    expect(
      decideNotificationThreadAction({
        ...base,
        pending: { action: { kind: "approve", turnId: "turn-1", requestId: null }, at: T },
        pendingApprovals: [approval("a")],
      }),
    ).toEqual({
      kind: "refuse",
      message: "This alert does not say which approval it was. Choose here.",
    });
  });

  it("refuses when the approval was answered or is on its way", () => {
    expect(
      decideNotificationThreadAction({ ...base, pending: approve, pendingApprovals: [] }),
    ).toEqual({ kind: "refuse", message: "That approval was already answered." });
    expect(
      decideNotificationThreadAction({
        ...base,
        pending: approve,
        pendingApprovals: [approval("a", { responseState: "submitting" })],
      }),
    ).toMatchObject({ kind: "refuse" });
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
    expect(
      decideNotificationThreadAction({
        ...base,
        threadLoaded: false,
        pending: approve,
        pendingApprovals: [approval("a")],
      }),
    ).toEqual({ kind: "wait" });
  });

  const reply: PendingThreadAction = { action: { kind: "reply", text: "go on" }, at: T };

  it("sends a reply once ready, or after the grace through the outbox", () => {
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
    // Approvals waiting do not change it: the reply never answers them.
    expect(
      decideNotificationThreadAction({
        ...base,
        pending: reply,
        pendingApprovals: [approval("a")],
      }),
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

  it("answers a waiting free-text question with the reply instead of queuing behind it", () => {
    const waiting = question("q", freeText, { userInputIdentity: undefined });
    expect(
      decideNotificationThreadAction({
        ...base,
        pending: reply,
        pendingApprovals: [],
        pendingUserInputs: [waiting],
      }),
    ).toEqual({
      kind: "answer",
      userInput: { requestId: "q", userInputIdentity: undefined },
      answers: { q1: "go on" },
    });
    // An answer needs the live connection: no grace, no outbox.
    expect(
      decideNotificationThreadAction({
        ...base,
        ready: false,
        nowMs: T + NOTIFICATION_REPLY_GRACE_MS,
        pending: reply,
        pendingApprovals: [],
        pendingUserInputs: [waiting],
      }),
    ).toEqual({ kind: "wait" });
  });

  it("leaves a question with options, or several questions, to its card", () => {
    for (const questions of [withOptions, [...freeText, { ...freeText[0]!, id: "q2" }]]) {
      expect(
        decideNotificationThreadAction({
          ...base,
          pending: reply,
          pendingApprovals: [],
          pendingUserInputs: [question("q", questions)],
        }),
      ).toEqual({
        kind: "refuse",
        message: "The reply was not sent: this question needs a choice. Answer it here.",
      });
    }
  });

  it("never sends over a queued message being edited, nor while the composer is closed", () => {
    expect(
      decideNotificationThreadAction({
        ...base,
        composer: { disabled: false, editingQueuedMessage: true },
        pending: reply,
        pendingApprovals: [],
      }),
    ).toMatchObject({ kind: "refuse" });
    // Closed past the grace: it still waits, and gives up at the limit.
    expect(
      decideNotificationThreadAction({
        ...base,
        ready: false,
        composer: { disabled: true, editingQueuedMessage: false },
        nowMs: T + NOTIFICATION_REPLY_GRACE_MS,
        pending: reply,
        pendingApprovals: [],
      }),
    ).toEqual({ kind: "wait" });
    expect(
      decideNotificationThreadAction({
        ...base,
        composer: { disabled: true, editingQueuedMessage: false },
        nowMs: T + NOTIFICATION_ACTION_TTL_MS,
        pending: reply,
        pendingApprovals: [],
      }),
    ).toMatchObject({ kind: "refuse" });
  });
});
