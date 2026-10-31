import {
  ApprovalRequestId,
  CommandId,
  EventId,
  MessageId,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  type EnvironmentApi,
  type OrchestrationThreadActivity,
} from "@ryco/contracts";
import { describe, expect, it, vi } from "vitest";

import { deriveThreadActivityViewModel } from "../session/session-logic.ts";
import {
  optionalAnswerMessageText,
  optionalAnswerTakesAttachments,
  resolveOptionalAnswerRoute,
  sendOptionalAnswerAsMessage,
} from "./optionalAnswer.ts";

const identity = {
  requestEventId: EventId.make("asked"),
  runtimeSessionId: RuntimeSessionId.make("runtime-1"),
};
const asked: OrchestrationThreadActivity = {
  id: EventId.make("asked"),
  kind: "user-input.requested",
  tone: "info",
  summary: "Optional question — agent continues working",
  turnId: TurnId.make("turn-1"),
  createdAt: "2026-10-31T10:00:00.000Z",
  payload: {
    requestId: "optional:1",
    runtimeSessionId: "runtime-1",
    nonBlocking: true,
    itemId: "item-1",
    userInputIdentity: identity,
    questions: [{ id: "0", header: "Question 1", question: "Audience?", options: [] }],
  },
};
const optional = deriveThreadActivityViewModel([asked], undefined).optionalUserInputs[0]!;

describe("optional question answers", () => {
  it("carries the asking turn and item, which the answer names", () => {
    expect(optional).toMatchObject({
      requestId: "optional:1",
      turnId: "turn-1",
      itemId: "item-1",
      userInputIdentity: identity,
    });
    expect(optionalAnswerMessageText(optional, { "0": "Engineers" })).toBe(
      "Reply to your optional questions (item item-1, turn turn-1):\n\nAudience?\nAnswer: Engineers",
    );
  });

  it("steers the asking turn while it runs, waits behind another, and sends a message after", () => {
    const route = (
      orchestrationStatus: "running" | "starting" | "ready" | "stopped",
      turn?: string,
    ) =>
      resolveOptionalAnswerRoute({
        userInput: optional,
        session: {
          orchestrationStatus,
          activeTurnId: turn === undefined ? undefined : TurnId.make(turn),
        },
      });
    expect(route("running", "turn-1")).toBe("steer");
    expect(route("running", "turn-2")).toBe("wait");
    expect(route("starting")).toBe("wait");
    expect(route("ready")).toBe("message");
    expect(route("stopped")).toBe("message");
    expect(resolveOptionalAnswerRoute({ userInput: optional, session: null })).toBe("message");
    // Only a message carries files; a steer cannot.
    expect(optionalAnswerTakesAttachments("message")).toBe(true);
    expect(optionalAnswerTakesAttachments("steer")).toBe(false);
  });

  it("sends an answer after its turn as a turn start that claims the question", async () => {
    const dispatchCommand = vi.fn(async (_command: unknown) => ({ sequence: 1 }));
    const api = { orchestration: { dispatchCommand } } as unknown as EnvironmentApi;
    const assertMutationReady = vi.fn();
    const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" };
    await sendOptionalAnswerAsMessage({
      api,
      threadId: ThreadId.make("thread-1"),
      userInput: optional,
      answers: { "0": "Engineers" },
      attachments: [
        {
          type: "file",
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 5,
          uploadToken: "token-1",
        },
      ],
      thread: {
        title: "Plan",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        tokenMode: "off",
      },
      providerDriver: "codex" as never,
      assertMutationReady,
      newCommandId: () => CommandId.make("command-1"),
      newMessageId: () => MessageId.make("message-1"),
    });
    expect(assertMutationReady).toHaveBeenCalled();
    expect(dispatchCommand).toHaveBeenCalledTimes(1);
    expect(dispatchCommand.mock.calls[0]?.[0]).toMatchObject({
      type: "thread.turn.start",
      commandId: "command-1",
      threadId: "thread-1",
      message: {
        messageId: "message-1",
        text: optionalAnswerMessageText(optional, { "0": "Engineers" }),
        attachments: [expect.objectContaining({ uploadToken: "token-1" })],
      },
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      optionalAnswer: {
        requestId: ApprovalRequestId.make("optional:1"),
        userInputIdentity: identity,
        answers: { "0": "Engineers" },
      },
    });
  });

  it("refuses to send a blocking question or an empty answer as a message", async () => {
    const dispatchCommand = vi.fn(async () => ({ sequence: 1 }));
    const input = {
      api: { orchestration: { dispatchCommand } } as unknown as EnvironmentApi,
      threadId: ThreadId.make("thread-1"),
      attachments: [],
      thread: {
        title: "Plan",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        tokenMode: "off" as const,
      },
      newCommandId: () => CommandId.make("command-1"),
      newMessageId: () => MessageId.make("message-1"),
    };
    await expect(
      sendOptionalAnswerAsMessage({
        ...input,
        userInput: { ...optional, nonBlocking: false },
        answers: { "0": "Engineers" },
      }),
    ).rejects.toThrow();
    await expect(
      sendOptionalAnswerAsMessage({ ...input, userInput: optional, answers: {} }),
    ).rejects.toThrow();
    expect(dispatchCommand).not.toHaveBeenCalled();
  });
});
