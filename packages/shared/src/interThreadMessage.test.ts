import { describe, expect, it } from "vite-plus/test";

import {
  agentSentMessageId,
  agentSentMessageSenderThreadId,
  isAgentSentMessageId,
  parseDelegationReturnSections,
} from "./interThreadMessage.ts";

describe("agent-sent message ids", () => {
  it("names the sending chat and keeps the suffix older clients fold on", () => {
    const id = agentSentMessageId({ operationSlug: "op-1", senderThreadId: "thread:9b/x" });
    expect(id.startsWith("message-agent-control-op-1-from:")).toBe(true);
    expect(id.endsWith("-send-message")).toBe(true);
    expect(isAgentSentMessageId(id)).toBe(true);
    expect(agentSentMessageSenderThreadId(id)).toBe("thread:9b/x");
  });

  it("reads no sender from ids without one", () => {
    expect(
      agentSentMessageSenderThreadId(
        agentSentMessageId({ operationSlug: "op-1", senderThreadId: null }),
      ),
    ).toBeNull();
    expect(agentSentMessageSenderThreadId("message-agent-control-op-1-send-message")).toBeNull();
    expect(agentSentMessageSenderThreadId("message-agent-control-op-1-create-0")).toBeNull();
    expect(agentSentMessageSenderThreadId("message-agent-control-op-from:%E0-send-message")).toBe(
      null,
    );
  });
});

describe("parseDelegationReturnSections", () => {
  it("reads nothing from text without sections", () => {
    expect(parseDelegationReturnSections("Hello")).toEqual([]);
  });

  it("skips sections it does not know and keeps the rest", () => {
    const text = [
      "Ryco delegation update.",
      "",
      "[1/2]",
      "Something else entirely.",
      "",
      "[2/2]",
      "Delegated initial-run result (completed).",
      "Child: [Open task](/ryco/thread/child%201)",
      '{"summary":"Done.","truncated":false}',
    ].join("\n");
    expect(parseDelegationReturnSections(text)).toEqual([
      { childThreadId: "child 1", kind: "result", state: "completed", text: "Done." },
    ]);
  });
});
