import { describe, expect, it } from "vite-plus/test";

import {
  agentTerminalLabel,
  isAgentTerminalId,
  terminalsWaitingForUser,
} from "./agentTerminals.ts";

describe("agentTerminalLabel", () => {
  it("numbers an agent's terminals", () => {
    expect(agentTerminalLabel("agent-2")).toBe("Agent 2");
    expect(agentTerminalLabel("agent-12")).toBe("Agent 12");
  });

  it("names an agent terminal without a number plainly", () => {
    expect(agentTerminalLabel("agent-x")).toBe("Agent");
    expect(agentTerminalLabel("agent-12345")).toBe("Agent");
  });

  it("has no label for other terminals", () => {
    expect(agentTerminalLabel("terminal-3f2a")).toBe(null);
    expect(agentTerminalLabel("default")).toBe(null);
    expect(isAgentTerminalId("default")).toBe(false);
    expect(isAgentTerminalId("agent-1")).toBe(true);
  });
});

describe("terminalsWaitingForUser", () => {
  const requested = (
    requestId: string,
    target: string,
    surface = "terminal",
    expiresAt = "2026-11-21T12:10:00.000Z",
  ) => ({
    kind: "user-action.requested",
    payload: { requestId, surface, need: "input", message: "m", target, expiresAt },
  });
  const resolved = (requestId: string) => ({
    kind: "user-action.resolved",
    payload: { requestId, outcome: "done" },
  });
  const now = Date.parse("2026-11-21T12:00:00.000Z");

  it("lists terminals with a pending hand-off", () => {
    expect(terminalsWaitingForUser([requested("a", "agent-1")], now)).toEqual(["agent-1"]);
  });

  it("drops resolved, expired and browser hand-offs", () => {
    expect(
      terminalsWaitingForUser(
        [
          requested("a", "agent-1"),
          resolved("a"),
          requested("b", "agent-2", "terminal", "2026-11-21T11:59:00.000Z"),
          requested("c", "tab-1", "browser"),
          { kind: "tool.started", payload: null },
        ],
        now,
      ),
    ).toEqual([]);
  });

  it("ignores malformed payloads", () => {
    expect(
      terminalsWaitingForUser([{ kind: "user-action.requested", payload: "nope" }], now),
    ).toEqual([]);
  });
});
