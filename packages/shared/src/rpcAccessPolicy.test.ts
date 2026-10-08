import { describe, expect, it } from "vite-plus/test";

import {
  AGENT_CONTROL_WS_METHODS,
  CONTEXT_HANDOFF_WS_METHODS,
  DEVICE_WS_METHODS,
  ORCHESTRATION_WS_METHODS,
  WS_METHODS,
} from "@ryco/contracts";
import {
  hostedRoleAllows,
  RPC_ACCESS_POLICY,
  RPC_DELIVERY_EFFECT_POLICY,
  rpcAccessFor,
  rpcDeliveryEffectFor,
} from "./rpcAccessPolicy.ts";

describe("shared RPC access policy", () => {
  it("requires current owner authority to inspect and redeem reset credits", () => {
    for (const method of [
      WS_METHODS.serverReadCodexResetCredits,
      WS_METHODS.serverConsumeCodexResetCredit,
    ]) {
      expect(hostedRoleAllows("viewer", method)).toBe(false);
      expect(hostedRoleAllows("operator", method)).toBe(false);
      expect(hostedRoleAllows("owner", method, false)).toBe(false);
      expect(hostedRoleAllows("owner", method)).toBe(true);
    }
  });
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

  it("requires current operator authority for side questions and cancellation", () => {
    for (const method of [
      WS_METHODS.textGenerationAskSideQuestion,
      WS_METHODS.textGenerationCancelSideQuestion,
    ]) {
      expect(hostedRoleAllows("viewer", method)).toBe(false);
      expect(hostedRoleAllows("operator", method, false)).toBe(false);
      expect(hostedRoleAllows("operator", method)).toBe(true);
    }
  });

  it("lets viewers read worktree notes and operators change them", () => {
    expect(hostedRoleAllows("viewer", WS_METHODS.notesList)).toBe(true);
    expect(hostedRoleAllows("viewer", WS_METHODS.notesCommand)).toBe(false);
    expect(hostedRoleAllows("operator", WS_METHODS.notesCommand)).toBe(true);
    expect(hostedRoleAllows("operator", WS_METHODS.notesCommand, false)).toBe(false);
    expect(rpcDeliveryEffectFor(WS_METHODS.notesList)).toBe("read");
    expect(rpcDeliveryEffectFor(WS_METHODS.notesCommand)).toBe("mutation");
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

  it("classifies every RPC method's delivery effect independently of its access tier", () => {
    expect(new Set(Object.keys(RPC_DELIVERY_EFFECT_POLICY))).toEqual(
      new Set(Object.keys(RPC_ACCESS_POLICY)),
    );
    // Operator-tier reads are still reads: the tier is not an effect.
    for (const method of [
      WS_METHODS.projectsReadFile,
      WS_METHODS.vcsReadLocalChanges,
      WS_METHODS.vcsReadComparison,
      WS_METHODS.sourceControlListChangeRequests,
      ORCHESTRATION_WS_METHODS.getTaskOutput,
    ]) {
      expect(rpcAccessFor(method)).toBe("operator");
      expect(rpcDeliveryEffectFor(method)).toBe("read");
    }
    // Long-lived read streams outside the session-sync set.
    expect(rpcDeliveryEffectFor(AGENT_CONTROL_WS_METHODS.subscribeProposals)).toBe("read");
    expect(rpcDeliveryEffectFor(DEVICE_WS_METHODS.subscribeEvents)).toBe("read");
    // Viewer-tier is not a proxy for read either.
    expect(rpcDeliveryEffectFor(ORCHESTRATION_WS_METHODS.dispatchCommand)).toBe("receipted");
    for (const method of [
      WS_METHODS.terminalWrite,
      WS_METHODS.projectsWriteFile,
      WS_METHODS.gitRunStackedAction,
      WS_METHODS.vcsPull,
      AGENT_CONTROL_WS_METHODS.acceptProposal,
    ]) {
      expect(rpcDeliveryEffectFor(method)).toBe("mutation");
    }
  });

  it("treats an unclassified method's delivery as uncertain", () => {
    expect(rpcDeliveryEffectFor("server.someFutureMethod")).toBe("mutation");
  });
});
