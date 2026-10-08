import * as CodexErrors from "effect-codex-app-server/errors";
import { describe, expect, it } from "vite-plus/test";

import { ProviderAdapterProcessError, ProviderAdapterRequestError } from "./Errors.ts";
import { isMissingConversationError, isMissingConversationText } from "./resumeFailure.ts";

describe("isMissingConversationText", () => {
  it.each([
    "No conversation found with session ID: 0f3c",
    "thread not found: 019a",
    "Thread does not exist",
    "no such thread",
    "Unknown session: abc",
    // Codex app-server's `thread/resume` for a thread without a rollout (-32600).
    "no rollout found for thread id 019a0000-0000-7000-8000-000000000001",
  ])("recognizes %j", (text) => {
    expect(isMissingConversationText(text)).toBe(true);
  });

  it.each([
    "Permission denied",
    "Config file not found",
    "Model does not exist",
    "Unknown error in session startup",
    "Session closed",
  ])("ignores %j", (text) => {
    expect(isMissingConversationText(text)).toBe(false);
  });

  it("limits the nouns when asked", () => {
    expect(isMissingConversationText("Session not found", ["thread"])).toBe(false);
    expect(isMissingConversationText("Thread not found", ["thread"])).toBe(true);
  });
});

describe("isMissingConversationError", () => {
  it("reads a typed error's detail", () => {
    expect(
      isMissingConversationError(
        new ProviderAdapterRequestError({
          provider: "claudeAgent",
          method: "session.start",
          detail: "No conversation found with session ID: 0f3c",
        }),
      ),
    ).toBe(true);
  });

  it("reads the native error a typed error wraps", () => {
    expect(
      isMissingConversationError(
        new ProviderAdapterProcessError({
          provider: "codex",
          threadId: "thread-1",
          detail: "Codex App Server failed to open the thread.",
          cause: new Error("thread/resume failed: thread not found"),
        }),
      ),
    ).toBe(true);
  });

  it("reads Codex's missing-rollout resume error", () => {
    expect(
      isMissingConversationError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32600,
          errorMessage: "no rollout found for thread id 019a0000-0000-7000-8000-000000000001",
        }),
      ),
    ).toBe(true);
  });

  it("ignores unrelated failures", () => {
    expect(
      isMissingConversationError(
        new ProviderAdapterRequestError({
          provider: "codex",
          method: "session.start",
          detail: "Permission denied",
        }),
      ),
    ).toBe(false);
    expect(isMissingConversationError(undefined)).toBe(false);
  });
});
