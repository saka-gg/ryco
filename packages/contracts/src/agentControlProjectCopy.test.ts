import { describe, expect, it } from "vite-plus/test";
import { Schema } from "effect";

import {
  AGENT_CONTROL_ACTION_CAPABILITIES,
  AGENT_CONTROL_CAPABILITIES,
  AGENT_CONTROL_CLIENT_EXECUTED_PLAN_KINDS,
  AGENT_CONTROL_LEGACY_PLAN_KINDS,
  AGENT_CONTROL_PLAN_VERSION,
  AGENT_CONTROL_RISK_TAGS,
  AgentControlAcceptProposalInput,
  AgentControlActionKind,
  AgentControlActionPlan,
  AgentControlCompletedResult,
  AgentControlOperationState,
  AgentControlPlanView,
  AgentControlProposal,
  AgentControlProposalReceipt,
  AgentControlProposalReceiptView,
  AgentControlProposalView,
  AgentControlProposalStreamEvent,
  AgentControlProposalStreamEventView,
} from "./agentControl.ts";
import {
  AgentControlMcpSuggestProjectDestinationInput,
  AgentControlPublishNodeDirectoryInput,
  AgentControlReportClientExecutionInput,
} from "./agentControlProjectCopy.ts";

const decodePlan = Schema.decodeUnknownSync(AgentControlActionPlan);
const decodePlanView = Schema.decodeUnknownSync(AgentControlPlanView);

const executorId = "7d2c9e4a-3b1f-4c8d-a6e5-0f9b2a7c1d3e";

const importProjectPlan = {
  kind: "importProject",
  projectId: "2a7c1d3e-7d2c-4e4a-9b1f-4c8da6e50f9b",
  title: "ryco",
  destinationPath: "/Users/me/Code/ryco",
  remoteUrl: "git@github.com:example/ryco.git",
  branch: null,
  setup: { command: "bun install", saveAsScript: true },
  followUpThread: {
    title: "Finish setup",
    prompt: "Install the toolchain.",
    runtimeMode: "approval-required",
    envMode: "local",
    modelSelection: { instanceId: "codex", model: "gpt-5.6" },
  },
};

const copyProjectPlan = {
  kind: "copyProjectToNode",
  source: {
    kind: "project",
    projectId: "project-1",
    title: "ryco",
    expectedUpdatedAt: "2026-10-22T00:00:00.000Z",
  },
  target: { environmentId: "env-mac-mini", label: "Mac mini" },
  destination: { kind: "child-of-default", name: "ryco" },
  bringCommits: true,
  bringChanges: false,
  copySettings: true,
  setup: null,
  followUpThread: {
    title: "Finish setup",
    prompt: "Install the toolchain.",
    runtimeMode: "approval-required",
    envMode: "local",
    modelSelection: null,
  },
};

const proposalWire = (plan: unknown) => ({
  proposalId: "proposal-1",
  requestId: "request-1",
  principal: {
    kind: "provider-session",
    threadId: "thread-1",
    providerInstanceId: "codex",
  },
  planVersion: AGENT_CONTROL_PLAN_VERSION,
  plan,
  planDigest: "a".repeat(64),
  riskTags: ["creates-project"],
  promptSummary: null,
  status: "pending-user-approval",
  createdAt: "2026-10-22T00:00:00.000Z",
  updatedAt: "2026-10-22T00:00:00.000Z",
  expiresAt: "2026-10-22T01:00:00.000Z",
  decidedAt: null,
  result: null,
});

describe("cross-node project plans", () => {
  it("decodes both new plan kinds and maps them to their own capabilities", () => {
    expect(decodePlan(importProjectPlan).kind).toBe("importProject");
    expect(decodePlan(copyProjectPlan).kind).toBe("copyProjectToNode");
    expect(
      decodePlan({
        ...copyProjectPlan,
        source: { kind: "repository", remoteUrl: "https://github.com/example/ryco", title: "ryco" },
        destination: { kind: "path", path: "~/Code/ryco" },
      }).kind,
    ).toBe("copyProjectToNode");
    expect(decodePlan({ ...copyProjectPlan, destination: { kind: "default" } }).kind).toBe(
      "copyProjectToNode",
    );
    expect(AGENT_CONTROL_ACTION_CAPABILITIES.importProject).toBe(
      AGENT_CONTROL_CAPABILITIES.importProject,
    );
    expect(AGENT_CONTROL_CAPABILITIES.importProject).toBe("projects.import");
    expect(AGENT_CONTROL_ACTION_CAPABILITIES.copyProjectToNode).toBe("projects.copy");
    expect(AGENT_CONTROL_CAPABILITIES.readNodes).toBe("nodes.read");
    expect(AGENT_CONTROL_RISK_TAGS.crossNode).toBe("cross-node");
    expect(AGENT_CONTROL_RISK_TAGS.runsCommands).toBe("runs-commands");
    expect(AGENT_CONTROL_RISK_TAGS.copiesWorkspaceContent).toBe("copies-workspace-content");
    expect(AGENT_CONTROL_CLIENT_EXECUTED_PLAN_KINDS).toEqual(["copyProjectToNode"]);
  });

  it("pins the follow-up thread's model for importProject and allows the target default for copies", () => {
    expect(() =>
      decodePlan({
        ...importProjectPlan,
        followUpThread: { ...importProjectPlan.followUpThread, modelSelection: null },
      }),
    ).toThrow();
    expect(() =>
      decodePlan({
        ...importProjectPlan,
        followUpThread: { title: "Finish setup", prompt: "Install the toolchain." },
      }),
    ).toThrow();
  });

  it("applies input hygiene to agent-supplied fields", () => {
    for (const overrides of [
      { remoteUrl: "https://user:token@github.com/example/ryco.git" },
      { branch: "--upload-pack=x" },
      { destinationPath: "Code/ryco" },
      { projectId: "../../escape" },
      { runSetupScript: true },
      { setup: { command: "", saveAsScript: false } },
    ]) {
      expect(() => decodePlan({ ...importProjectPlan, ...overrides })).toThrow();
    }
    for (const overrides of [
      { destination: { kind: "child-of-default", name: "../outside" } },
      { destination: { kind: "path", path: "relative/dir" } },
      { target: { environmentId: "e".repeat(129), label: "Mac mini" } },
      { target: { environmentId: "env-1", label: "Mac mini", address: "10.0.0.2" } },
      {
        source: {
          kind: "project",
          projectId: "project-1",
          title: "ryco",
        },
      },
    ]) {
      expect(() => decodePlan({ ...copyProjectPlan, ...overrides })).toThrow();
    }
  });
});

describe("tolerant proposal views", () => {
  it("lists exactly the plan kinds that existed before the cross-node kinds", () => {
    expect(AGENT_CONTROL_LEGACY_PLAN_KINDS).toHaveLength(29);
    expect(AGENT_CONTROL_LEGACY_PLAN_KINDS).not.toContain("importProject");
    expect(AGENT_CONTROL_LEGACY_PLAN_KINDS).not.toContain("copyProjectToNode");
    expect(
      [
        ...AGENT_CONTROL_LEGACY_PLAN_KINDS,
        ...AGENT_CONTROL_CLIENT_EXECUTED_PLAN_KINDS,
        "importProject",
      ].toSorted(),
    ).toEqual([...AgentControlActionKind.literals].toSorted());
  });

  it("decodes an unknown plan kind as unsupported while the strict union rejects it", () => {
    const future = { kind: "mirrorRepository", mirrors: ["a", "b"], nested: { deep: true } };
    expect(() => decodePlan(future)).toThrow();
    expect(decodePlanView(future)).toEqual({
      kind: "unsupported",
      originalKind: "mirrorRepository",
    });
    expect(() => decodePlanView({ mirrors: [] })).toThrow();
  });

  it("decodes every known kind through the view exactly as the strict union does", () => {
    const legacyPlan = { kind: "interruptThread", threadId: "thread-1" };
    for (const plan of [importProjectPlan, copyProjectPlan, legacyPlan]) {
      expect(decodePlanView(plan)).toEqual(decodePlan(plan));
    }
    const decodeProposal = Schema.decodeUnknownSync(AgentControlProposal);
    const decodeProposalView = Schema.decodeUnknownSync(AgentControlProposalView);
    for (const plan of [copyProjectPlan, legacyPlan]) {
      expect(decodeProposalView(proposalWire(plan))).toEqual(decodeProposal(proposalWire(plan)));
    }
  });

  it("degrades a malformed known kind to unsupported instead of failing the stream", () => {
    const fromNewerBuild = { ...copyProjectPlan, newField: 1 };
    expect(() => decodePlan(fromNewerBuild)).toThrow();
    expect(decodePlanView(fromNewerBuild)).toEqual({
      kind: "unsupported",
      originalKind: "copyProjectToNode",
    });
  });

  it("keeps the stream alive for proposals of kinds this build does not know", () => {
    const decodeEvent = Schema.decodeUnknownSync(AgentControlProposalStreamEventView);
    const unknown = proposalWire({ kind: "mirrorRepository" });
    const snapshot = {
      version: 1,
      type: "snapshot",
      queue: { revision: 3, active: [unknown, proposalWire(importProjectPlan)], recent: [] },
    };
    expect(() => Schema.decodeUnknownSync(AgentControlProposalStreamEvent)(snapshot)).toThrow();
    const decoded = decodeEvent(snapshot);
    if (decoded.type !== "snapshot") throw new Error("expected a snapshot");
    expect(decoded.queue.active.map((proposal) => proposal.plan.kind)).toEqual([
      "unsupported",
      "importProject",
    ]);
    const event = decodeEvent({ version: 1, type: "proposal", revision: 4, proposal: unknown });
    expect(event.type === "proposal" && event.proposal.plan).toEqual({
      kind: "unsupported",
      originalKind: "mirrorRepository",
    });
  });

  it("encodes strict proposals unchanged through the view", () => {
    const proposal = Schema.decodeUnknownSync(AgentControlProposal)(proposalWire(copyProjectPlan));
    const event = { version: 1 as const, type: "proposal" as const, revision: 1, proposal };
    const encoded = Schema.encodeUnknownSync(AgentControlProposalStreamEventView)(event);
    expect(encoded).toEqual(Schema.encodeUnknownSync(AgentControlProposalStreamEvent)(event));
  });

  it("reads a receipt of an unknown kind through the receipt view only", () => {
    const receipt = {
      proposalId: "proposal-1",
      requestId: "request-1",
      actionKind: "mirrorRepository",
      planDigest: "a".repeat(64),
      riskTags: [],
      status: "rejected",
      createdAt: "2026-10-22T00:00:00.000Z",
      updatedAt: "2026-10-22T00:00:00.000Z",
      expiresAt: "2026-10-22T01:00:00.000Z",
      decidedAt: "2026-10-22T00:00:01.000Z",
      result: null,
    };
    expect(() => Schema.decodeUnknownSync(AgentControlProposalReceipt)(receipt)).toThrow();
    expect(Schema.decodeUnknownSync(AgentControlProposalReceiptView)(receipt).actionKind).toBe(
      "mirrorRepository",
    );
  });
});

describe("client-executed proposals", () => {
  it("binds acceptance to a UUIDv4 executor and keeps plain accepts valid", () => {
    const decode = Schema.decodeUnknownSync(AgentControlAcceptProposalInput);
    expect(decode({ proposalId: "proposal-1" }).executeOnClient).toBeUndefined();
    expect(
      decode({ proposalId: "proposal-1", executeOnClient: { executorId } }).executeOnClient,
    ).toEqual({ executorId });
    expect(() => decode({ proposalId: "proposal-1", executeOnClient: true })).toThrow();
    expect(() =>
      decode({ proposalId: "proposal-1", executeOnClient: { executorId: "client-1" } }),
    ).toThrow();
  });

  it("bounds client reports", () => {
    const decode = Schema.decodeUnknownSync(AgentControlReportClientExecutionInput);
    const started = {
      proposalId: "proposal-1",
      executorId,
      outcome: "started",
      importId: "0b8f4c2e-6a1d-4f3b-9c7e-2d5a8b1c4e6f",
    };
    expect(decode(started).outcome).toBe("started");
    const completed = {
      proposalId: "proposal-1",
      executorId,
      outcome: "completed",
      result: {
        targetEnvironmentId: "env-mac-mini",
        projectId: "project-2",
        workspaceRoot: "/Users/me/Code/ryco",
        warnings: [],
      },
      error: null,
    };
    expect(decode(completed).result?.projectId).toBe("project-2");
    expect(() => decode({ ...started, outcome: "running" })).toThrow();
    expect(() => decode({ ...completed, error: "x".repeat(2_001) })).toThrow();
    expect(() =>
      decode({
        ...completed,
        result: { ...completed.result, warnings: Array.from({ length: 21 }, () => "warning") },
      }),
    ).toThrow();
  });

  it("records the remote project and the executor binding additively", () => {
    const result = Schema.decodeUnknownSync(AgentControlCompletedResult)({
      outcome: "completed",
      remoteProject: { environmentId: "env-mac-mini", projectId: "project-2" },
      detail: "Copied to Mac mini",
      completedAt: "2026-10-22T00:10:00.000Z",
    });
    expect(result.remoteProject?.environmentId).toBe("env-mac-mini");
    const state = Schema.decodeUnknownSync(AgentControlOperationState)({
      clientExecution: {
        executorIdHash: "b".repeat(64),
        deadlineAt: "2026-10-22T02:00:00.000Z",
        importId: null,
        targetEnvironmentId: "env-mac-mini",
      },
    });
    expect(state.clientExecution?.importId).toBeNull();
    expect(
      Schema.decodeUnknownSync(AgentControlOperationState)({}).clientExecution,
    ).toBeUndefined();
  });
});

describe("node directory", () => {
  it("accepts only bounded, non-secret entries", () => {
    const decode = Schema.decodeUnknownSync(AgentControlPublishNodeDirectoryInput);
    const entry = {
      environmentId: "env-mac-mini",
      label: "Mac mini",
      platformOs: "darwin",
      online: true,
      projectCopySupport: "unknown",
    };
    expect(decode({ nodes: [entry] }).nodes).toHaveLength(1);
    expect(() => decode({ nodes: [{ ...entry, bearerToken: "secret" }] })).toThrow();
    expect(() => decode({ nodes: [{ ...entry, projectCopySupport: "maybe" }] })).toThrow();
    expect(() => decode({ nodes: Array.from({ length: 65 }, () => entry) })).toThrow();
  });

  it("bounds the folder name an agent asks a destination for", () => {
    const decode = Schema.decodeUnknownSync(AgentControlMcpSuggestProjectDestinationInput);
    expect(decode({ name: "ryco" }).name).toBe("ryco");
    expect(() => decode({ name: "../ryco" })).toThrow();
  });
});
