import { describe, expect, it } from "vite-plus/test";

import {
  AGENT_CONTROL_WS_METHODS,
  CONTEXT_HANDOFF_WS_METHODS,
  DEVICE_WS_METHODS,
  ORCHESTRATION_WS_METHODS,
  WS_METHODS,
} from "@ryco/contracts";

import { RPC_ACCESS_POLICY, rpcAccessFor } from "./RpcAccessPolicy.ts";

describe("RPC access policy", () => {
  it("classifies every public RPC method exactly once and fails closed for unknown methods", () => {
    const contractMethods = new Set([
      ...Object.values(WS_METHODS),
      ...Object.values(ORCHESTRATION_WS_METHODS),
      ...Object.values(CONTEXT_HANDOFF_WS_METHODS),
      ...Object.values(DEVICE_WS_METHODS),
      ...Object.values(AGENT_CONTROL_WS_METHODS),
    ]);
    expect(new Set(Object.keys(RPC_ACCESS_POLICY))).toEqual(contractMethods);
    expect(() => rpcAccessFor("future.unclassifiedMethod")).toThrow(
      "no explicit access classification",
    );
  });

  it("preserves owner-only statistics and legacy message-search boundaries", () => {
    expect(rpcAccessFor(WS_METHODS.serverGetStatistics)).toBe("owner");
    expect(rpcAccessFor(WS_METHODS.serverGetUsageSummary)).toBe("owner");
    expect(rpcAccessFor(WS_METHODS.searchThreadMessages)).toBe("owner");
    expect(rpcAccessFor(ORCHESTRATION_WS_METHODS.searchThreadMessages)).toBe("viewer");
    expect(rpcAccessFor(WS_METHODS.sourceControlMergeChangeRequest)).toBe("operator");
  });

  it("keeps the entire Agent Control approval surface owner-only", () => {
    for (const method of Object.values(AGENT_CONTROL_WS_METHODS)) {
      expect(rpcAccessFor(method)).toBe("owner");
    }
  });
});
