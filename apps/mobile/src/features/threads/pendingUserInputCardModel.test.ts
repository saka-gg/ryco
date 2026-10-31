import { describe, expect, it, vi } from "vite-plus/test";

import {
  deliverPendingUserInputAnswer,
  pendingUserInputCardView,
} from "./pendingUserInputCardModel";

const answers = { "0": "Engineers" };

describe("native question card", () => {
  it("says where an optional answer goes and when it can be sent", () => {
    const view = (route: "steer" | "message" | "wait", extra = {}) =>
      pendingUserInputCardView({
        userInput: { nonBlocking: true },
        route,
        answers,
        disabled: false,
        submitting: false,
        ...extra,
      });
    expect(view("steer")).toMatchObject({
      title: "Optional question · agent continues working",
      canSubmit: true,
      canDismiss: true,
    });
    expect(view("message")).toMatchObject({
      title: "Optional question · turn ended",
      hint: expect.stringContaining("starts the next turn"),
      canSubmit: true,
    });
    expect(view("wait")).toMatchObject({ canSubmit: false, canDismiss: true });
    expect(view("message", { disabled: true })).toMatchObject({
      editable: false,
      canSubmit: false,
      canDismiss: false,
    });
    expect(
      pendingUserInputCardView({
        userInput: { nonBlocking: true, responseState: "uncertain" },
        route: "message",
        answers,
        disabled: false,
        submitting: false,
      }).canSubmit,
    ).toBe(false);
    expect(view("message", { answers: null }).canSubmit).toBe(false);
  });

  it("keeps blocking questions as they were: no dismissal, answered in place", () => {
    expect(
      pendingUserInputCardView({
        userInput: {},
        route: "message",
        answers,
        disabled: false,
        submitting: false,
      }),
    ).toEqual({
      title: "Input needed",
      hint: null,
      editable: true,
      canSubmit: true,
      canDismiss: false,
    });
  });

  it("sends a late optional answer as a message and everything else as a response", async () => {
    const respond = vi.fn(async () => {});
    const sendAsMessage = vi.fn(async () => {});
    await expect(
      deliverPendingUserInputAnswer({
        userInput: { nonBlocking: true },
        route: "message",
        answers,
        respond,
        sendAsMessage,
      }),
    ).resolves.toBe("message");
    expect(sendAsMessage).toHaveBeenCalledWith(answers);
    expect(respond).not.toHaveBeenCalled();
    for (const userInput of [{ nonBlocking: true }, {}]) {
      await expect(
        deliverPendingUserInputAnswer({
          userInput,
          route: userInput.nonBlocking ? "steer" : "message",
          answers,
          respond,
          sendAsMessage,
        }),
      ).resolves.toBe("response");
    }
    expect(respond).toHaveBeenCalledTimes(2);
    await expect(
      deliverPendingUserInputAnswer({
        userInput: { nonBlocking: true },
        route: "message",
        answers,
        respond,
      }),
    ).rejects.toThrow();
  });
});
