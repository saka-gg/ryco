import {
  ThreadId,
  UserActionRequestError,
  UserActionRequestId,
  type EnvironmentApi,
} from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  answerThreadUserActionRequest,
  mobileUserActionRequestCards,
  sendUserActionRequestAnswer,
  UserActionRequestUnavailableError,
} from "./userActionRequestCardModel";

const threadId = ThreadId.make("thread-1");
const requestId = UserActionRequestId.make(`user-action-${"d".repeat(32)}`);
const activities = [
  {
    id: "requested",
    kind: "user-action.requested",
    createdAt: "2026-11-21T08:00:00.000Z",
    turnId: "turn-1",
    payload: {
      requestId,
      surface: "browser",
      need: "sign-in",
      message: "Sign in to GitHub in the tab.",
      target: "tab-1",
      expiresAt: "2026-11-21T08:10:00.000Z",
    },
  },
];
const now = Date.parse("2026-11-21T08:01:00.000Z");
const base = {
  activities,
  nowMs: now,
  nodeSupports: true,
  role: "owner" as const,
  mutationReady: true,
  promptsDisabled: false,
};
type Threads = NonNullable<EnvironmentApi["threads"]>;
/** A node's thread API with only the given answer RPC, or none. */
const apiWith = (threads: Partial<Threads>): Pick<EnvironmentApi, "threads"> => ({
  threads: { setManualBucket: async () => ({}), setManualPosition: async () => ({}), ...threads },
});

describe("mobile user action request cards", () => {
  it("lists the thread's unanswered requests and lets the owner answer them", () => {
    const view = mobileUserActionRequestCards(base);
    expect(view.requests.map((request) => [request.surface, request.need])).toEqual([
      ["browser", "sign-in"],
    ]);
    expect(view.access).toEqual({ canAnswer: true, reason: null });
  });

  it("drops answered and expired requests", () => {
    expect(
      mobileUserActionRequestCards({
        ...base,
        activities: [
          ...activities,
          {
            id: "resolved",
            kind: "user-action.resolved",
            createdAt: "2026-11-21T08:02:00.000Z",
            turnId: "turn-1",
            payload: { requestId, outcome: "done" },
          },
        ],
      }).requests,
    ).toEqual([]);
    expect(
      mobileUserActionRequestCards({ ...base, nowMs: Date.parse("2026-11-21T08:10:00.000Z") })
        .requests,
    ).toEqual([]);
    expect(mobileUserActionRequestCards({ ...base, activities: undefined }).requests).toEqual([]);
  });

  it("keeps the card read-only for other roles, cached views and older nodes", () => {
    // A direct pairing that is not the node's owner is a viewer to it.
    for (const role of ["client", "operator", "viewer", undefined] as const) {
      expect(mobileUserActionRequestCards({ ...base, role }).access.canAnswer, String(role)).toBe(
        false,
      );
    }
    expect(mobileUserActionRequestCards({ ...base, promptsDisabled: true }).access).toEqual({
      canAnswer: false,
      reason: "Reconnect to answer.",
    });
    expect(mobileUserActionRequestCards({ ...base, nodeSupports: false }).access).toEqual({
      canAnswer: false,
      reason: "Update this node to answer this request.",
    });
  });

  it("sends Done or Won't do once", async () => {
    const answerUserActionRequest = vi.fn(async () => ({ outcome: "done" as const }));
    await expect(
      answerThreadUserActionRequest({
        api: apiWith({ answerUserActionRequest }),
        threadId,
        requestId,
        answer: "done",
      }),
    ).resolves.toEqual({ outcome: "done" });
    expect(answerUserActionRequest).toHaveBeenCalledTimes(1);
    expect(answerUserActionRequest).toHaveBeenCalledWith({ threadId, requestId, answer: "done" });
  });

  it("refuses on a node without the answer RPC", async () => {
    await expect(
      answerThreadUserActionRequest({
        api: apiWith({}),
        threadId,
        requestId,
        answer: "declined",
      }),
    ).rejects.toBeInstanceOf(UserActionRequestUnavailableError);
  });
});

describe("the card's send", () => {
  it("turns every outcome into a result, never a throw", async () => {
    // The request may have ended otherwise meanwhile: the node's outcome is what the card says.
    expect(
      await sendUserActionRequestAnswer({
        api: () => apiWith({ answerUserActionRequest: async () => ({ outcome: "timeout" }) }),
        threadId,
        requestId,
        answer: "declined",
      }),
    ).toEqual({ kind: "answered", outcome: "timeout" });

    expect(
      await sendUserActionRequestAnswer({
        api: () =>
          apiWith({
            answerUserActionRequest: async () => {
              throw new UserActionRequestError({ reason: "already-resolved" });
            },
          }),
        threadId,
        requestId,
        answer: "done",
      }),
    ).toEqual({ kind: "failed", error: "This request already ended." });

    expect(
      await sendUserActionRequestAnswer({
        api: () => apiWith({}),
        threadId,
        requestId,
        answer: "done",
      }),
    ).toEqual({ kind: "failed", error: "This node cannot answer this request." });

    // No connection: finding the API throws, and the transport's text is never shown.
    const offline = await sendUserActionRequestAnswer({
      api: () => {
        throw new Error("socket closed at wss://node.internal");
      },
      threadId,
      requestId,
      answer: "done",
    });
    expect(offline).toEqual({
      kind: "failed",
      error: "Could not answer the request. Check the connection and try again.",
    });
  });
});

describe("hand-off link hints on the phone", () => {
  it("shows the host the node stored (punycode) and flags it, never parsing the link here", () => {
    const cards = mobileUserActionRequestCards({
      ...base,
      activities: [
        ...activities,
        {
          id: "hint",
          kind: "user-action.hint",
          createdAt: "2026-11-21T08:01:00.000Z",
          turnId: "turn-1",
          payload: {
            requestId,
            links: [{ url: "https://xn--gthub-zsa.com/login/device", host: "xn--gthub-zsa.com" }],
            codes: ["WXYZ-5678"],
          },
        },
      ],
    });
    expect(cards.hints.get(requestId)).toEqual({
      links: [
        {
          url: "https://xn--gthub-zsa.com/login/device",
          host: "xn--gthub-zsa.com",
          international: true,
        },
      ],
      codes: ["WXYZ-5678"],
    });
  });
});
