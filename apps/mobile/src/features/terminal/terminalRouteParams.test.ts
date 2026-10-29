import { describe, expect, it } from "vite-plus/test";

import { parseTerminalRouteParams } from "./terminalRouteParams";

describe("terminal route params", () => {
  it("accepts array-valued deep-link identifiers", () => {
    expect(
      parseTerminalRouteParams({ environmentId: ["environment"], threadId: ["thread"] }),
    ).toEqual({ environmentId: "environment", threadId: "thread" });
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
