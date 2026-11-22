import { describe, expect, it } from "vite-plus/test";

import { parseTerminalRouteParams } from "./terminalRouteParams";

describe("terminal route params", () => {
  it("accepts array-valued deep-link identifiers", () => {
    expect(
      parseTerminalRouteParams({ environmentId: ["environment"], threadId: ["thread"] }),
    ).toEqual({ environmentId: "environment", threadId: "thread", terminalId: null });
  });

  it("opens on a named terminal and drops one that cannot be a terminal id", () => {
    expect(
      parseTerminalRouteParams({ environmentId: "e", threadId: "t", terminalId: "agent-2" }),
    ).toEqual({ environmentId: "e", threadId: "t", terminalId: "agent-2" });
    expect(
      parseTerminalRouteParams({ environmentId: "e", threadId: "t", terminalId: "x".repeat(129) })
        ?.terminalId,
    ).toBeNull();
    expect(
      parseTerminalRouteParams({ environmentId: "e", threadId: "t", terminalId: "a\u0007b" })
        ?.terminalId,
    ).toBeNull();
  });

  it("rejects missing, empty, control-character and oversized identifiers", () => {
    expect(parseTerminalRouteParams(null)).toBeNull();
    expect(parseTerminalRouteParams({ environmentId: "environment", threadId: "" })).toBeNull();
    expect(
      parseTerminalRouteParams({ environmentId: "environment\nother", threadId: "thread" }),
    ).toBeNull();
    expect(
      parseTerminalRouteParams({ environmentId: "environment", threadId: "x".repeat(257) }),
    ).toBeNull();
  });
});
