import { describe, expect, it } from "vite-plus/test";

import {
  AGENT_CONTROL_WS_METHODS,
  CONTEXT_HANDOFF_WS_METHODS,
  DEVICE_WS_METHODS,
  ORCHESTRATION_WS_METHODS,
  WS_METHODS,
} from "@ryco/contracts";
import { NODE_BROWSER_WS_METHODS } from "@ryco/contracts/node-browser";
import {
  hostedRoleAllows,
  RPC_ACCESS_POLICY,
  RPC_DELIVERY_EFFECT_POLICY,
  rpcAccessFor,
  rpcDeliveryEffectFor,
} from "./rpcAccessPolicy.ts";

describe("shared RPC access policy", () => {
  it("keeps node browser tabs to operators, reads included, and never replays their input", () => {
    for (const method of Object.values(NODE_BROWSER_WS_METHODS)) {
      expect(rpcAccessFor(method)).toBe("operator");
      expect(hostedRoleAllows("viewer", method)).toBe(false);
      expect(hostedRoleAllows("operator", method)).toBe(true);
      expect(hostedRoleAllows("owner", method)).toBe(true);
    }
    expect(rpcDeliveryEffectFor(NODE_BROWSER_WS_METHODS.input)).toBe("mutation");
    expect(rpcDeliveryEffectFor(NODE_BROWSER_WS_METHODS.command)).toBe("mutation");
    expect(rpcDeliveryEffectFor(NODE_BROWSER_WS_METHODS.read)).toBe("read");
  });
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
  it("keeps provider sign-in owner-only, including following a flow", () => {
    for (const method of [
      WS_METHODS.providerSignInSubscribe,
      WS_METHODS.providerSignInStart,
      WS_METHODS.providerSignInRespond,
    ]) {
      expect(rpcAccessFor(method)).toBe("owner");
      expect(hostedRoleAllows("viewer", method)).toBe(false);
      expect(hostedRoleAllows("operator", method)).toBe(false);
      expect(hostedRoleAllows("owner", method, false)).toBe(false);
      expect(hostedRoleAllows("owner", method)).toBe(true);
    }
    expect(rpcDeliveryEffectFor(WS_METHODS.providerSignInSubscribe)).toBe("read");
    expect(rpcDeliveryEffectFor(WS_METHODS.providerSignInStart)).toBe("mutation");
    expect(rpcDeliveryEffectFor(WS_METHODS.providerSignInRespond)).toBe("mutation");
  });
  it("lets any role report client use, which only delays unattended updates", () => {
    for (const role of ["viewer", "operator", "owner"] as const) {
      expect(hostedRoleAllows(role, WS_METHODS.serverNoteClientInteraction)).toBe(true);
    }
    expect(hostedRoleAllows("owner", WS_METHODS.serverNoteClientInteraction, false)).toBe(false);
    expect(rpcDeliveryEffectFor(WS_METHODS.serverNoteClientInteraction)).toBe("read");
    // Whether a node updates unattended is a node setting only its owner may change.
    expect(rpcAccessFor(WS_METHODS.serverUpdateSettings)).toBe("owner");
  });
  it("classifies every current and legacy RPC method", () => {
    expect(new Set(Object.keys(RPC_ACCESS_POLICY))).toEqual(
      new Set([
        ...Object.values(WS_METHODS),
        ...Object.values(ORCHESTRATION_WS_METHODS),
        ...Object.values(CONTEXT_HANDOFF_WS_METHODS),
        ...Object.values(DEVICE_WS_METHODS),
        ...Object.values(NODE_BROWSER_WS_METHODS),
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
  });

  it("lets operators, not viewers, start or stop a pull request watch, as a mutation", () => {
    const method = WS_METHODS.sourceControlSetPullRequestWatch;
    expect(rpcAccessFor(method)).toBe("operator");
    expect(rpcDeliveryEffectFor(method)).toBe("mutation");
    expect(hostedRoleAllows("viewer", method)).toBe(false);
    expect(hostedRoleAllows("operator", method)).toBe(true);
  });

  it("keeps chat-folder methods at the project-mutation tier", () => {
    for (const method of [
      WS_METHODS.projectsPromoteChatPreview,
      WS_METHODS.projectsPromoteChat,
      WS_METHODS.projectsDeleteChatFolder,
    ]) {
      expect(rpcAccessFor(method)).toBe(rpcAccessFor(WS_METHODS.projectsInitializeGit));
      expect(hostedRoleAllows("viewer", method)).toBe(false);
      expect(hostedRoleAllows("operator", method, false)).toBe(false);
      expect(hostedRoleAllows("operator", method)).toBe(true);
    }
    expect(rpcDeliveryEffectFor(WS_METHODS.projectsPromoteChatPreview)).toBe("read");
    expect(rpcDeliveryEffectFor(WS_METHODS.projectsPromoteChat)).toBe("mutation");
    expect(rpcDeliveryEffectFor(WS_METHODS.projectsDeleteChatFolder)).toBe("mutation");
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

  it("keeps every local task method, task files included, owner-only", () => {
    for (const method of [
      WS_METHODS.serverListLocalTasks,
      WS_METHODS.serverGetLocalTask,
      WS_METHODS.serverCreateLocalTask,
      WS_METHODS.serverUpdateLocalTask,
      WS_METHODS.serverDeleteLocalTask,
      WS_METHODS.serverDelegateLocalTask,
      WS_METHODS.serverCreateLocalTaskFileUpload,
      WS_METHODS.serverAddLocalTaskFile,
      WS_METHODS.serverRemoveLocalTaskFile,
      WS_METHODS.serverSubscribeLocalTaskChanges,
    ]) {
      expect(rpcAccessFor(method)).toBe("owner");
      expect(hostedRoleAllows("operator", method)).toBe(false);
    }
    for (const method of [
      WS_METHODS.serverCreateLocalTaskFileUpload,
      WS_METHODS.serverAddLocalTaskFile,
      WS_METHODS.serverRemoveLocalTaskFile,
    ]) {
      expect(rpcDeliveryEffectFor(method)).toBe("mutation");
    }
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
      WS_METHODS.projectsReadFileChunk,
      WS_METHODS.projectsSubscribeFileChanges,
      WS_METHODS.threadsSubscribeLocalServers,
      WS_METHODS.vcsReadLocalChanges,
      // Attaching to a running Git action again observes it and never starts Git.
      WS_METHODS.gitResumeStackedAction,
      WS_METHODS.vcsReadComparison,
      WS_METHODS.sourceControlListChangeRequests,
      WS_METHODS.sourceControlListInvolvedChangeRequests,
      ORCHESTRATION_WS_METHODS.getTaskOutput,
    ]) {
      expect(rpcAccessFor(method)).toBe("operator");
      expect(rpcDeliveryEffectFor(method)).toBe("read");
    }
    // Chunked previews read workspace bytes, which a viewer may not.
    expect(hostedRoleAllows("viewer", WS_METHODS.projectsReadFileChunk)).toBe(false);
    expect(hostedRoleAllows("operator", WS_METHODS.projectsReadFileChunk)).toBe(true);
    // A file's change notices reveal what its read would: operators, not viewers.
    expect(hostedRoleAllows("viewer", WS_METHODS.projectsSubscribeFileChanges)).toBe(false);
    expect(hostedRoleAllows("operator", WS_METHODS.projectsSubscribeFileChanges)).toBe(true);
    // A thread's servers and their stop: the same tier as its terminal, never a viewer.
    expect(hostedRoleAllows("viewer", WS_METHODS.threadsSubscribeLocalServers)).toBe(false);
    expect(hostedRoleAllows("operator", WS_METHODS.threadsSubscribeLocalServers)).toBe(true);
    expect(hostedRoleAllows("viewer", WS_METHODS.threadsStopLocalServer)).toBe(false);
    expect(hostedRoleAllows("operator", WS_METHODS.threadsStopLocalServer)).toBe(true);
    expect(rpcDeliveryEffectFor(WS_METHODS.threadsStopLocalServer)).toBe("mutation");
    // Long-lived read streams outside the session-sync set.
    expect(rpcDeliveryEffectFor(AGENT_CONTROL_WS_METHODS.subscribeProposals)).toBe("read");
    expect(rpcDeliveryEffectFor(DEVICE_WS_METHODS.subscribeEvents)).toBe("read");
    // Viewer-tier is not a proxy for read either.
    expect(rpcDeliveryEffectFor(ORCHESTRATION_WS_METHODS.dispatchCommand)).toBe("receipted");
    for (const method of [
      WS_METHODS.terminalWrite,
      WS_METHODS.projectsWriteFile,
      WS_METHODS.gitRunStackedAction,
      WS_METHODS.gitCancelStackedAction,
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
