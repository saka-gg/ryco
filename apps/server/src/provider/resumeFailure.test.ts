import * as AcpErrors from "effect-acp/errors";
import * as CodexErrors from "effect-codex-app-server/errors";
import { describe, expect, it } from "vite-plus/test";

import { ProviderAdapterProcessError, ProviderAdapterRequestError } from "./Errors.ts";
import { isMissingConversationError, isMissingConversationText } from "./resumeFailure.ts";

describe("isMissingConversationText", () => {
  it.each([
    // Codex app-server's `thread/resume` for a thread without a rollout (-32600).
    "no rollout found for thread id 019a0000-0000-7000-8000-000000000001",
    // Codex app-server for a thread it does not know.
    "thread not found",
    "thread not found: 019a0000-0000-7000-8000-000000000001",
    "Thread does not exist",
    // The Claude CLI on a resume of a deleted session.
    "No conversation found with session ID: 0f3c1d2e-0000-4000-8000-000000000001",
    // The Claude adapter's transcript check before it resumes.
    "No conversation found with session ID 0f3c1d2e-0000-4000-8000-000000000001: Claude no longer keeps its transcript.",
    // ACP agents (`session/load`, `session/resume`) and Copilot, in their own words.
    "Session not found",
    "Session not found: 0f3c",
    "Session 0f3c1d2e-0000-4000-8000-000000000001 not found",
    "Session 'ses_01' was not found",
    "Session ID: 0f3c not found",
    // A uuid without a digit is still an id.
    "session cafebabe-dead-beef-face-decafbadcafe does not exist",
    "session abc-123 does not exist",
    "session id abc-123 does not exist",
    "thread 019a not found",
    "no such thread",
    "no such thread: 019a",
    "No such session.",
    "No such session exists",
    "no such thread exists: 019a",
    "No such conversation exists.",
    "no such session exist",
    "Unknown session: abc",
    "Unknown session ID abc-123",
    "unknown session id: 0f3c1d2e",
    "missing rollout",
    "missing thread 019a",
  ])("recognizes %j", (text) => {
    expect(isMissingConversationText(text)).toBe(true);
  });

  it.each([
    "Permission denied",
    "Config file not found",
    "Model does not exist",
    "Unknown error in session startup",
    "Session closed",
    // A missing thing next to a conversation noun is not a missing conversation.
    "Failed to start provider for thread t-1: codex binary not found",
    "thread/resume failed: model not found",
    "session start failed: config file not found",
    "Provider adapter process error (codex) for thread t-1: Not found",
    "Method not found: session/load",
    "Method not found: thread/resume",
    "Missing session id",
    "No threads found",
    "Unknown claudeAgent adapter thread: t-1",
    // The noun qualifies another word that is the unknown or missing thing.
    "Unknown session mode: plan",
    "unknown session config option",
    "Unknown session ID",
    "missing thread parameter",
    "missing session token",
    "No such session option",
    "No such session option exists",
    "Codex stderr: state db missing rollout path for thread 019a",
    // A word that is not an id between the noun and the missing phrase, hex letters included.
    "Session config not found",
    "Session decade not found",
    "unknown session facade",
  ])("ignores %j", (text) => {
    expect(isMissingConversationText(text)).toBe(false);
  });

  it("limits the nouns when asked", () => {
    expect(isMissingConversationText("Session not found", ["thread"])).toBe(false);
    expect(isMissingConversationText("Thread not found", ["thread"])).toBe(true);
    // Each list compiles once: a second call answers the same.
    expect(isMissingConversationText("Session not found", ["thread"])).toBe(false);
    expect(isMissingConversationText("Session not found", ["thread", "session"])).toBe(true);
    expect(isMissingConversationText("Thread not found", [])).toBe(false);
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

  it("reads the Claude adapter's missing-transcript error", () => {
    expect(
      isMissingConversationError(
        new ProviderAdapterRequestError({
          provider: "claudeAgent",
          method: "session/resume",
          detail:
            "No conversation found with session ID 0f3c1d2e-0000-4000-8000-000000000001: Claude no longer keeps its transcript.",
        }),
      ),
    ).toBe(true);
  });

  it("reads an ACP agent's failed session/load", () => {
    const cause = new AcpErrors.AcpRequestError({
      code: -32002,
      errorMessage: "Session not found: 0f3c",
    });
    expect(
      isMissingConversationError(
        new ProviderAdapterProcessError({
          provider: "acp",
          threadId: "thread-1",
          detail: cause.message,
          cause,
        }),
      ),
    ).toBe(true);
  });

  it("ignores a wrapper that names a thread next to some other missing thing", () => {
    expect(
      isMissingConversationError(
        new ProviderAdapterProcessError({
          provider: "codex",
          threadId: "t-1",
          detail: "codex binary not found",
        }),
      ),
    ).toBe(false);
    expect(
      isMissingConversationError(
        new ProviderAdapterRequestError({
          provider: "codex",
          method: "thread/resume",
          detail: "model not found",
        }),
      ),
    ).toBe(false);
    expect(
      isMissingConversationError(
        new ProviderAdapterProcessError({
          provider: "acp",
          threadId: "thread-1",
          detail: "Method not found: session/load",
          cause: AcpErrors.AcpRequestError.methodNotFound("session/load"),
        }),
      ),
    ).toBe(false);
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
