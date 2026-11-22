import { UserActionRequestError, UserActionRequestId } from "@ryco/contracts/user-action-request";
import { ThreadId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  hasUserActionRequestActivity,
  USER_ACTION_OPEN_TAB_LABEL,
  USER_ACTION_REMOTE_VIEW_ENDED_TEXT,
  USER_ACTION_REMOTE_VIEW_HINT,
  userActionOffersRemoteView,
  userActionRemoteViewTabId,
  userActionAnswerAccess,
  userActionAnswerInput,
  userActionContinueElsewhereHint,
  userActionRequestCards,
  userActionRequestFailureText,
} from "./userActionRequests.ts";

const threadId = ThreadId.make("thread-1");
const requestId = UserActionRequestId.make(`user-action-${"c".repeat(32)}`);
const requested = {
  id: "requested",
  kind: "user-action.requested",
  createdAt: "2026-11-21T12:00:00.000Z",
  turnId: "turn-1",
  payload: {
    requestId,
    surface: "browser",
    need: "sign-in",
    message: "Sign in to Jira.",
    target: "tab-1",
    expiresAt: "2026-11-21T12:10:00.000Z",
  },
};

describe("user action request cards", () => {
  it("shows a card per pending, unexpired request", () => {
    expect(hasUserActionRequestActivity([{ kind: "tool.completed" }])).toBe(false);
    expect(hasUserActionRequestActivity([requested])).toBe(true);
    expect(userActionRequestCards([requested], Date.parse("2026-11-21T12:05:00.000Z"))).toEqual([
      expect.objectContaining({ requestId, surface: "browser", target: "tab-1" }),
    ]);
    expect(userActionRequestCards([requested], Date.parse("2026-11-21T12:10:00.000Z"))).toEqual([]);
  });

  it("builds the answer and words a refusal by its reason", () => {
    expect(userActionAnswerInput(threadId, requestId, "declined")).toEqual({
      threadId,
      requestId,
      answer: "declined",
    });
    expect(
      userActionRequestFailureText(new UserActionRequestError({ reason: "already-resolved" })),
    ).toBe("This request already ended.");
    expect(userActionRequestFailureText(new Error("socket closed"))).toMatch(/Could not answer/);
    expect(userActionContinueElsewhereHint("browser")).toMatch(/Continue on your desktop/);
  });

  it("lets only the owner answer, on a node that offers it, over a ready connection", () => {
    expect(
      userActionAnswerAccess({ nodeSupports: true, role: "owner", mutationReady: true }),
    ).toEqual({ canAnswer: true, reason: null });
    expect(
      userActionAnswerAccess({ nodeSupports: true, role: "operator", mutationReady: true })
        .canAnswer,
    ).toBe(false);
    expect(
      userActionAnswerAccess({ nodeSupports: false, role: "owner", mutationReady: true }).reason,
    ).toMatch(/Update this node/);
    expect(
      userActionAnswerAccess({ nodeSupports: true, role: undefined, mutationReady: true })
        .canAnswer,
    ).toBe(false);
  });

  it("offers Open tab only for a remote-view browser tab the session may answer", () => {
    const owner = { canAnswer: true };
    expect(userActionOffersRemoteView({ surface: "browser", remoteView: true }, owner)).toBe(true);
    expect(userActionOffersRemoteView({ surface: "browser", remoteView: false }, owner)).toBe(
      false,
    );
    expect(userActionOffersRemoteView({ surface: "terminal", remoteView: true }, owner)).toBe(
      false,
    );
    expect(
      userActionOffersRemoteView({ surface: "browser", remoteView: true }, { canAnswer: false }),
    ).toBe(false);
    expect(userActionRemoteViewTabId(requestId)).toBe(`handoff-${"c".repeat(32)}`);
    expect(USER_ACTION_OPEN_TAB_LABEL).toBe("Open tab");
    expect(USER_ACTION_REMOTE_VIEW_HINT).toMatch(/Open the tab here/);
    expect(USER_ACTION_REMOTE_VIEW_ENDED_TEXT).toMatch(/Continue on your desktop/);
    // Without a remote view the card still says where to continue.
    expect(userActionContinueElsewhereHint("browser")).toMatch(/Browser panel/);
  });
});
