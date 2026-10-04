import { describe, expect, it } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import {
  claudeWakeSignal,
  isClaudeRootTurnOutput,
  shouldOpenClaudeWakeTurn,
  type ClaudeWakeTurnGate,
} from "./claudeWakeTurn.ts";

const frame = (value: Record<string, unknown>) =>
  ({ uuid: "frame", session_id: "sdk-session", ...value }) as unknown as SDKMessage;

const status = (value: "requesting" | "compacting" | null, extra: Record<string, unknown> = {}) =>
  frame({ type: "system", subtype: "status", status: value, ...extra });
const init = frame({ type: "system", subtype: "init", model: "claude-sonnet-4-6" });
const taskNotification = frame({
  type: "system",
  subtype: "task_notification",
  task_id: "task-1",
  status: "completed",
});
const assistant = (parent: string | null) =>
  frame({ type: "assistant", parent_tool_use_id: parent, message: { content: [] } });
const user = (parent: string | null) =>
  frame({ type: "user", parent_tool_use_id: parent, message: { content: [] } });
const streamEvent = (parent: string | null) =>
  frame({ type: "stream_event", parent_tool_use_id: parent, event: { type: "message_start" } });
const result = frame({ type: "result", subtype: "success", result: "done" });

describe("claudeWakeSignal", () => {
  it("treats root requesting and compacting status frames as status signals", () => {
    expect(claudeWakeSignal(status("requesting"))).toBe("status");
    expect(claudeWakeSignal(status("compacting"))).toBe("status");
  });

  it("ignores a status frame that only reports a compaction result", () => {
    expect(claudeWakeSignal(status(null, { compact_result: "success" }))).toBeUndefined();
  });

  it("treats root init as an init signal", () => {
    expect(claudeWakeSignal(init)).toBe("init");
  });

  it("never treats a subagent frame as a signal", () => {
    expect(claudeWakeSignal(status("requesting", { parent_tool_use_id: "x" }))).toBeUndefined();
    expect(
      claudeWakeSignal(frame({ type: "system", subtype: "init", parent_tool_use_id: "x" })),
    ).toBeUndefined();
  });

  it("ignores every other frame", () => {
    expect(claudeWakeSignal(taskNotification)).toBeUndefined();
    expect(claudeWakeSignal(assistant(null))).toBeUndefined();
    expect(claudeWakeSignal(result)).toBeUndefined();
  });
});

describe("shouldOpenClaudeWakeTurn", () => {
  const open: ClaudeWakeTurnGate = {
    signal: "status",
    hasOpenTurn: false,
    sessionStopped: false,
    promptSent: true,
    turnInstallsInFlight: 0,
    requestingStatusObserved: true,
  };

  it("opens on a status signal regardless of what the CLI emitted before", () => {
    expect(shouldOpenClaudeWakeTurn(open)).toBe(true);
    expect(shouldOpenClaudeWakeTurn({ ...open, requestingStatusObserved: false })).toBe(true);
  });

  it.each([
    ["a turn is open", { hasOpenTurn: true }],
    ["the session is stopped", { sessionStopped: true }],
    ["no prompt was ever sent", { promptSent: false }],
    ["a send is installing", { turnInstallsInFlight: 1 }],
    ["two sends are installing", { turnInstallsInFlight: 2 }],
  ] as const)("denies when %s", (_label, deny) => {
    for (const signal of ["status", "init"] as const) {
      for (const requestingStatusObserved of [true, false]) {
        expect(
          shouldOpenClaudeWakeTurn({ ...open, signal, requestingStatusObserved, ...deny }),
        ).toBe(false);
      }
    }
  });

  it("opens on init only for CLIs never seen to emit status: requesting", () => {
    expect(
      shouldOpenClaudeWakeTurn({ ...open, signal: "init", requestingStatusObserved: false }),
    ).toBe(true);
    expect(
      shouldOpenClaudeWakeTurn({ ...open, signal: "init", requestingStatusObserved: true }),
    ).toBe(false);
  });
});

describe("isClaudeRootTurnOutput", () => {
  it("accepts root stream, assistant and user frames and rejects subagent ones", () => {
    for (const make of [streamEvent, assistant, user]) {
      expect(isClaudeRootTurnOutput(make(null))).toBe(true);
      expect(isClaudeRootTurnOutput(make("parent-tool"))).toBe(false);
    }
    expect(isClaudeRootTurnOutput(frame({ type: "assistant", message: { content: [] } }))).toBe(
      true,
    );
  });

  it("accepts results, compaction boundaries and API retries", () => {
    expect(isClaudeRootTurnOutput(result)).toBe(true);
    expect(isClaudeRootTurnOutput(frame({ type: "system", subtype: "compact_boundary" }))).toBe(
      true,
    );
    expect(
      isClaudeRootTurnOutput(frame({ type: "system", subtype: "api_retry", attempt: 1 })),
    ).toBe(true);
  });

  it("accepts the compacting heartbeat but not the requesting status", () => {
    expect(isClaudeRootTurnOutput(status("compacting"))).toBe(true);
    expect(isClaudeRootTurnOutput(status("requesting"))).toBe(false);
    expect(isClaudeRootTurnOutput(status(null))).toBe(false);
  });

  it("rejects background and session frames", () => {
    expect(isClaudeRootTurnOutput(init)).toBe(false);
    expect(isClaudeRootTurnOutput(taskNotification)).toBe(false);
    expect(
      isClaudeRootTurnOutput(frame({ type: "system", subtype: "background_tasks_changed" })),
    ).toBe(false);
    expect(isClaudeRootTurnOutput(frame({ type: "rate_limit_event", rate_limit_info: {} }))).toBe(
      false,
    );
    expect(
      isClaudeRootTurnOutput(
        frame({ type: "system", subtype: "compact_boundary", parent_tool_use_id: "x" }),
      ),
    ).toBe(false);
  });
});
