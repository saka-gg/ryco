import { describe, expect, it } from "vite-plus/test";

import {
  AGENT_CONTROL_WS_METHODS,
  CONTEXT_HANDOFF_WS_METHODS,
  DEVICE_WS_METHODS,
  ORCHESTRATION_WS_METHODS,
  WS_METHODS,
} from "@ryco/contracts";
import { hostedRoleAllows, RPC_ACCESS_POLICY, rpcAccessFor } from "./rpcAccessPolicy.ts";

describe("shared RPC access policy", () => {
  it("classifies every current and legacy RPC method", () => {
    expect(new Set(Object.keys(RPC_ACCESS_POLICY))).toEqual(
      new Set([
        ...Object.values(WS_METHODS),
        ...Object.values(ORCHESTRATION_WS_METHODS),
        ...Object.values(CONTEXT_HANDOFF_WS_METHODS),
        ...Object.values(DEVICE_WS_METHODS),
        ...Object.values(AGENT_CONTROL_WS_METHODS),
      ]),
    );
    expect(rpcAccessFor(WS_METHODS.searchThreadMessages)).toBe("owner");
    expect(rpcAccessFor(ORCHESTRATION_WS_METHODS.searchThreadMessages)).toBe("viewer");
    expect(rpcAccessFor(AGENT_CONTROL_WS_METHODS.listProposals)).toBe("owner");
    expect(rpcAccessFor(AGENT_CONTROL_WS_METHODS.acceptProposal)).toBe("owner");
    expect(rpcAccessFor(WS_METHODS.sourceControlGetChangeRequestFilesViewed)).toBe("operator");
    expect(rpcAccessFor(WS_METHODS.sourceControlSetChangeRequestFileViewed)).toBe("operator");
    expect(
      hostedRoleAllows("owner", WS_METHODS.sourceControlSetChangeRequestFileViewed, false),
    ).toBe(false);
    expect(hostedRoleAllows("viewer", WS_METHODS.sourceControlSetChangeRequestFileViewed)).toBe(
      false,
    );
    expect(rpcAccessFor(WS_METHODS.sourceControlMergeChangeRequest)).toBe("operator");
    expect(rpcAccessFor(WS_METHODS.threadPriorityEnsureCurrent)).toBe("operator");
  });

  it("fails closed for missing or stale hosted roles", () => {
    for (const method of [
      WS_METHODS.serverSignalDiagnosticProcess,
      WS_METHODS.serverRetryResourceTelemetry,
      WS_METHODS.serverGetResourceTelemetryHistory,
    ]) {
      expect(hostedRoleAllows("viewer", method)).toBe(false);
      expect(hostedRoleAllows("operator", method)).toBe(false);
      expect(hostedRoleAllows("owner", method, false)).toBe(false);
      expect(hostedRoleAllows("owner", method)).toBe(true);
    }
    expect(hostedRoleAllows(null, WS_METHODS.projectsList)).toBe(false);
    expect(hostedRoleAllows("owner", WS_METHODS.projectsList, false)).toBe(false);
    expect(hostedRoleAllows("viewer", WS_METHODS.projectsList)).toBe(true);
    expect(hostedRoleAllows("viewer", WS_METHODS.terminalOpen)).toBe(false);
    expect(hostedRoleAllows("operator", WS_METHODS.terminalOpen)).toBe(true);
    expect(hostedRoleAllows("operator", WS_METHODS.serverGetStatistics)).toBe(false);
    expect(hostedRoleAllows("owner", WS_METHODS.serverGetStatistics)).toBe(true);
    expect(hostedRoleAllows("operator", WS_METHODS.serverGetUsageSummary)).toBe(false);
    expect(hostedRoleAllows("owner", WS_METHODS.serverGetUsageSummary)).toBe(true);
    expect(hostedRoleAllows("owner", WS_METHODS.subscribeAuthAccess)).toBe(false);
  });
});
