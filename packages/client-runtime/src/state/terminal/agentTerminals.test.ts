import { describe, expect, it } from "vite-plus/test";

import { agentTerminalLabel, isAgentTerminalId } from "./agentTerminals.ts";

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
