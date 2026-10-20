import { describe, expect, it } from "vite-plus/test";

import {
  isRestartContinuationNotice,
  isRestartReleasedSession,
  ORPHANED_PROVIDER_SESSION_ERROR,
} from "./restartContinuation.ts";

describe("isRestartReleasedSession", () => {
  it("recognises only an error session that carries the restart marker", () => {
    expect(
      isRestartReleasedSession({ status: "error", lastError: ORPHANED_PROVIDER_SESSION_ERROR }),
    ).toBe(true);
  });

  it.each([
    { status: "error", lastError: "Provider exited (code 1)" },
    { status: "error", lastError: null },
    { status: "error" },
    { status: "stopped", lastError: ORPHANED_PROVIDER_SESSION_ERROR },
    { status: "ready", lastError: ORPHANED_PROVIDER_SESSION_ERROR },
  ])("is false for a genuine error or a session that is not in error: %j", (session) => {
    expect(isRestartReleasedSession(session)).toBe(false);
  });

  it("is false without a session", () => {
    expect(isRestartReleasedSession(null)).toBe(false);
    expect(isRestartReleasedSession(undefined)).toBe(false);
  });
});

describe("isRestartContinuationNotice", () => {
  it("matches the notices a node appends about restart continuation", () => {
    expect(isRestartContinuationNotice({ kind: "restart.continuation-skipped" })).toBe(true);
    expect(isRestartContinuationNotice({ kind: "restart.continuation-failed" })).toBe(true);
    expect(isRestartContinuationNotice({ kind: "restart.background-work-stopped" })).toBe(false);
    expect(isRestartContinuationNotice({ kind: "tool.completed" })).toBe(false);
  });
});
