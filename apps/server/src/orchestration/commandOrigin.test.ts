import { describe, expect, it } from "vite-plus/test";

import { isUserOriginatedCommandId } from "./commandOrigin.ts";

describe("isUserOriginatedCommandId", () => {
  it.each([
    ["5f0c1d2e-client-generated", true],
    ["session-stop-for-archive:5f0c", true],
    ["provider:turn-complete:1", false],
    ["server:pr-watch:thread:watch:2:uuid", false],
    ["agent-control:operation:turn-interrupt", false],
  ])("%s → %s", (commandId, expected) => {
    expect(isUserOriginatedCommandId(commandId)).toBe(expected);
  });
});
