import { describe, expect, it } from "vite-plus/test";

import { isProcessScopedCommandId } from "./processScopedCommandIds.ts";
import {
  isProviderOriginatedCommandId,
  isUserOriginatedCommandId,
  serverCommandId,
} from "./commandOrigin.ts";

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

describe("serverCommandId", () => {
  it("mints server:<tag>:<uuid>", () => {
    expect(serverCommandId("checkpoint-revert")).toMatch(
      /^server:checkpoint-revert:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    );
  });

  it("mints a fresh id on every call", () => {
    const ids = new Set(Array.from({ length: 100 }, () => serverCommandId("tag")));
    expect(ids.size).toBe(100);
  });

  it("counts as the node's command, not a person's, a provider's or a process-scoped one", () => {
    const commandId = serverCommandId("tag");
    expect(isUserOriginatedCommandId(commandId)).toBe(false);
    expect(isProviderOriginatedCommandId(commandId)).toBe(false);
    expect(isProcessScopedCommandId(commandId)).toBe(false);
  });
});

describe("isProviderOriginatedCommandId", () => {
  it.each([
    ["provider:5f0c1d2e:turn-complete", true],
    ["server:tag:uuid", false],
    ["agent-control:operation:turn-interrupt", false],
    ["client-provider:1", false],
    [null, false],
  ] as const)("%s → %s", (commandId, expected) => {
    expect(isProviderOriginatedCommandId(commandId)).toBe(expected);
  });
});
