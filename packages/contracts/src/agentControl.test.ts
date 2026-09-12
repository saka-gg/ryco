import { describe, expect, it } from "vite-plus/test";
import { Schema } from "effect";

import {
  AGENT_CONTROL_CAPABILITIES,
  AGENT_CONTROL_ACTION_CAPABILITIES,
  AGENT_CONTROL_PLAN_VERSION,
  AgentControlActionPlan,
  AgentControlCapability,
  AgentControlOperation,
  AgentControlOperationState,
  AgentControlPlanDigest,
  AgentControlPrincipal,
  AgentControlProposal,
  AgentControlProposalStatus,
  AgentControlResultEnvelope,
  AgentControlRiskTag,
} from "./agentControl.ts";

const decodePlan = Schema.decodeUnknownSync(AgentControlActionPlan);
const decodePrincipal = Schema.decodeUnknownSync(AgentControlPrincipal);
const decodeProposal = Schema.decodeUnknownSync(AgentControlProposal);
const decodeOperation = Schema.decodeUnknownSync(AgentControlOperation);
const decodeOperationState = Schema.decodeUnknownSync(AgentControlOperationState);
const decodeResult = Schema.decodeUnknownSync(AgentControlResultEnvelope);
const decodeStatus = Schema.decodeUnknownSync(AgentControlProposalStatus);
const decodeDigest = Schema.decodeUnknownSync(AgentControlPlanDigest);
const decodeCapability = Schema.decodeUnknownSync(AgentControlCapability);
const decodeRiskTag = Schema.decodeUnknownSync(AgentControlRiskTag);

const createThreadsPlan = {
  kind: "createThreads",
  entries: [
    {
      projectId: "project-1",
      title: "Fix the flaky test",
      prompt: "Investigate and fix the flaky worktree test.",
      modelSelection: { instanceId: "codex", model: "gpt-5.6" },
      runtimeMode: "full-access",
      envMode: "worktree",
      baseRef: "main",
    },
  ],
};

const automationDefinition = {
  execution: {
    projectId: "project-1",
    title: "Bounded review",
    prompt: "Review the project and report findings.",
    modelSelection: { instanceId: "codex", model: "gpt-5.6" },
    runtimeMode: "approval-required",
    envMode: "worktree",
  },
  schedule: { kind: "once", runAt: "2026-08-19T00:00:00.000Z" },
  enabled: true,
} as const;

const automationRevision = {
  revision: 1,
  definition: automationDefinition,
  cancelled: false,
  updatedAt: "2026-08-18T00:00:00.000Z",
} as const;

const digest = "a".repeat(64);

const proposalWire = {
  proposalId: "proposal-1",
  requestId: "request-1",
  principal: {
    kind: "provider-session",
    threadId: "thread-1",
    providerInstanceId: "codex",
    runtimeSessionId: "runtime-1",
    turnId: "turn-1",
  },
  planVersion: AGENT_CONTROL_PLAN_VERSION,
  plan: createThreadsPlan,
  planDigest: digest,
  riskTags: ["creates-threads", "starts-provider-turn"],
  promptSummary: "Create 1 thread in project-1",
  status: "pending-user-approval",
  createdAt: "2026-08-17T00:00:00.000Z",
  updatedAt: "2026-08-17T00:00:00.000Z",
  expiresAt: "2026-08-17T01:00:00.000Z",
  decidedAt: null,
  result: null,
};

describe("AgentControlActionPlan", () => {
  it("decodes every initial action kind", () => {
    expect(decodePlan(createThreadsPlan).kind).toBe("createThreads");
    expect(
      decodePlan({
        kind: "sendMessage",
        threadId: "thread-1",
        text: "Please also run the tests.",
        delivery: "queue",
      }).kind,
    ).toBe("sendMessage");
    expect(
      decodePlan({ kind: "interruptThread", threadId: "thread-1", turnId: "turn-9" }).kind,
    ).toBe("interruptThread");
    expect(decodePlan({ kind: "updateThread", threadId: "thread-1", archived: true }).kind).toBe(
      "updateThread",
    );
    expect(
      decodePlan({
        kind: "createProject",
        projectId: "project-new",
        title: "New project",
        workspaceRoot: "/workspace/new",
        projectMetadataDir: ".ryco",
        repositoryIdentityKey: "github.com/example/new",
      }).kind,
    ).toBe("createProject");
    expect(
      decodePlan({
        kind: "updateProject",
        projectId: "project-1",
        before: {
          title: "Before",
          workspaceRoot: "/workspace/before",
          repositoryIdentityKey: null,
          updatedAt: "2026-08-18T00:00:00.000Z",
        },
        after: {
          title: "After",
          workspaceRoot: "/workspace/after",
          repositoryIdentityKey: null,
        },
      }).kind,
    ).toBe("updateProject");
    expect(
      decodePlan({
        kind: "removeProject",
        projectId: "project-1",
        expected: {
          title: "Project",
          workspaceRoot: "/workspace/project",
          repositoryIdentityKey: null,
          updatedAt: "2026-08-18T00:00:00.000Z",
        },
        expectedThreadIds: ["thread-1"],
        force: true,
      }).kind,
    ).toBe("removeProject");
    expect(
      decodePlan({
        kind: "changeSettings",
        change: { kind: "providerUpdateChecks", before: true, after: false },
      }).kind,
    ).toBe("changeSettings");
    expect(
      decodePlan({
        kind: "createAutomation",
        automationId: "automation-1",
        definition: automationDefinition,
      }).kind,
    ).toBe("createAutomation");
    expect(
      decodePlan({
        kind: "updateAutomation",
        automationId: "automation-1",
        before: automationRevision,
        after: automationDefinition,
      }).kind,
    ).toBe("updateAutomation");
    expect(
      decodePlan({
        kind: "cancelAutomation",
        automationId: "automation-1",
        expected: automationRevision,
      }).kind,
    ).toBe("cancelAutomation");
    expect(
      decodePlan({
        kind: "automationRun",
        automationId: "automation-1",
        runId: "automation-run-1",
        automationRevision: 1,
        scheduledFor: automationDefinition.schedule.runAt,
        coalescedOccurrences: 0,
        execution: automationDefinition.execution,
      }).kind,
    ).toBe("automationRun");
  });

  it("accepts only explicit device mutations and bounded relative application artifacts", () => {
    const target = {
      threadId: "thread-1",
      projectId: "project-1",
      expectedProjectUpdatedAt: "2026-08-18T00:00:00.000Z",
      providerInstanceId: "codex",
      udid: "FAKE-0001",
      expectedThreadDeviceVersion: 4,
      expectedAttachedDeviceUdid: "FAKE-0001",
      expectedDeviceState: "booted",
      expectedDeviceBootSource: "ryco",
      expectedRecording: false,
      executionSummary: "Install an approved workspace application",
      riskClass: "device-control",
    };
    expect(
      decodePlan({ kind: "deviceInstall", ...target, artifactPath: "build/Test.apk" }).kind,
    ).toBe("deviceInstall");
    expect(() =>
      decodePlan({ kind: "deviceInstall", ...target, artifactPath: "../Test.apk" }),
    ).toThrow();
    expect(() =>
      decodePlan({ kind: "deviceInstall", ...target, artifactPath: "/tmp/Test.apk" }),
    ).toThrow();
    expect(
      decodePlan({ kind: "deviceInstall", ...target, artifactPath: "build/Test.app" }).kind,
    ).toBe("deviceInstall");
    expect(() =>
      decodePlan({ kind: "deviceInstall", ...target, artifactPath: "/tmp/Test.app" }),
    ).toThrow();
    expect(() =>
      decodePlan({ kind: "deviceInstall", ...target, artifactPath: "../Test.app" }),
    ).toThrow();
    expect(() => decodePlan({ kind: "device.call", method: "tap", payload: {} })).toThrow();
  });

  it("rejects unknown action kinds", () => {
    expect(() => decodePlan({ kind: "runShellCommand", command: "rm -rf /" })).toThrow();
  });

  it("bounds createThreads batches: never empty, never unbounded", () => {
    expect(() => decodePlan({ kind: "createThreads", entries: [] })).toThrow();
    const entry = createThreadsPlan.entries[0];
    expect(() =>
      decodePlan({ kind: "createThreads", entries: Array.from({ length: 11 }, () => entry) }),
    ).toThrow();
  });

  it("targets provider instances via ModelSelection, absorbing the legacy provider key", () => {
    const decoded = decodePlan({
      kind: "createThreads",
      entries: [
        {
          ...createThreadsPlan.entries[0],
          modelSelection: { provider: "codex", model: "gpt-5.6" },
        },
      ],
    });
    if (decoded.kind !== "createThreads") throw new Error("expected createThreads");
    expect(decoded.entries[0]?.modelSelection.instanceId).toBe("codex");
  });
});

describe("AgentControlPrincipal", () => {
  it("decodes both principal kinds", () => {
    expect(decodePrincipal(proposalWire.principal).kind).toBe("provider-session");
    expect(
      decodePrincipal({
        kind: "external-integration",
        integrationId: "integration-1",
        label: "Local Codex CLI",
      }).kind,
    ).toBe("external-integration");
  });

  it("rejects unknown principal kinds", () => {
    expect(() => decodePrincipal({ kind: "browser-session", sessionId: "s" })).toThrow();
  });
});

describe("AgentControlProposal", () => {
  it("round-trips a full proposal through decode and encode", () => {
    const decoded = decodeProposal(proposalWire);
    expect(decoded.status).toBe("pending-user-approval");
    expect(decoded.planDigest).toBe(digest);
    const encoded = Schema.encodeUnknownSync(AgentControlProposal)(decoded);
    expect(decodeProposal(encoded)).toEqual(decoded);
  });

  it("decodes every proposal status and rejects unknown ones", () => {
    for (const status of [
      "pending-user-approval",
      "approved",
      "rejected",
      "expired",
      "executing",
      "completed",
      "failed",
      "cancelled",
    ]) {
      expect(decodeStatus(status)).toBe(status);
    }
    expect(() => decodeStatus("awaiting-review")).toThrow();
  });

  it("only accepts sha-256 hex plan digests", () => {
    expect(decodeDigest(digest)).toBe(digest);
    expect(() => decodeDigest("not-a-digest")).toThrow();
    expect(() => decodeDigest("A".repeat(64))).toThrow();
  });

  it("decodes terminal result envelopes", () => {
    const failed = decodeResult({
      outcome: "failed",
      error: { code: "revalidation-failed", message: "Thread was deleted.", retryable: false },
      failedAt: "2026-08-17T00:10:00.000Z",
    });
    expect(failed.outcome).toBe("failed");
    const completed = decodeResult({
      outcome: "completed",
      createdThreadIds: ["thread-2"],
      completedAt: "2026-08-17T00:10:00.000Z",
    });
    expect(completed.outcome).toBe("completed");
  });
});

describe("forward compatibility (additive extension)", () => {
  it("decodes capability and risk-tag slugs this build does not know about", () => {
    // A newer build may persist capabilities/tags this build has never
    // heard of; decoding must succeed and authorization (not parsing)
    // rejects them.
    expect(decodeCapability("automations.create")).toBe("automations.create");
    expect(decodeRiskTag("touches-settings")).toBe("touches-settings");
  });

  it("rejects malformed slugs", () => {
    expect(() => decodeCapability("Threads.Create")).toThrow();
    expect(() => decodeCapability("1bad")).toThrow();
  });

  it("maps every action kind to a required capability", () => {
    expect(AGENT_CONTROL_ACTION_CAPABILITIES.createThreads).toBe(
      AGENT_CONTROL_CAPABILITIES.createThreads,
    );
    expect(Object.keys(AGENT_CONTROL_ACTION_CAPABILITIES).toSorted()).toEqual([
      "automationRun",
      "cancelAutomation",
      "changeSettings",
      "createAutomation",
      "createProject",
      "createThreads",
      "deviceAttach",
      "deviceBoot",
      "deviceDetach",
      "deviceInstall",
      "deviceLaunch",
      "deviceOpenUrl",
      "devicePressButton",
      "deviceShutdown",
      "deviceStartRecording",
      "deviceStopRecording",
      "deviceSwipe",
      "deviceTap",
      "interruptThread",
      "removeProject",
      "sendMessage",
      "updateAutomation",
      "updateProject",
      "updateThread",
    ]);
  });
});

describe("AgentControlOperation", () => {
  it("decodes a durable operation with recovery evidence", () => {
    const operation = decodeOperation({
      operationId: "operation-1",
      proposalId: "proposal-1",
      actionKind: "createThreads",
      status: "running",
      attempt: 1,
      state: {
        completedSteps: ["worktree-preflight"],
        resources: { threadIds: [], worktreeIds: ["worktree-1"] },
      },
      result: null,
      createdAt: "2026-08-17T00:00:00.000Z",
      updatedAt: "2026-08-17T00:05:00.000Z",
    });
    expect(operation.state.resources.worktreeIds).toEqual(["worktree-1"]);
  });

  it("defaults absent state collections so older rows keep decoding", () => {
    const state = decodeOperationState({});
    expect(state.completedSteps).toEqual([]);
    expect(state.resources).toEqual({
      projectIds: [],
      automationIds: [],
      threadIds: [],
      ownedThreadIds: [],
      worktreeIds: [],
      ownedWorktrees: [],
    });
    expect(state.commandReceipts).toEqual([]);
  });
});

describe("Agent Control MCP contracts", () => {
  it("catalogs the internal reads and proposal-backed mutation tools", async () => {
    const { AGENT_CONTROL_MCP_TOOLS, AGENT_CONTROL_MCP_TOOL_NAMES } =
      await import("./agentControl.ts");
    expect([...AGENT_CONTROL_MCP_TOOL_NAMES].toSorted()).toEqual(
      [
        "ryco_context",
        "ryco_capabilities",
        "ryco_list_projects",
        "ryco_list_threads",
        "ryco_read_thread",
        "ryco_read_control_request",
        "ryco_wait_for_control_request",
        "ryco_create_threads",
        "ryco_diagnostics_summary",
        "ryco_send_message",
        "ryco_interrupt_thread",
        "ryco_update_thread",
        "ryco_list_automations",
        "ryco_read_automation",
        "ryco_list_automation_runs",
        "ryco_propose_automation_create",
        "ryco_propose_automation_update",
        "ryco_propose_automation_cancel",
        "ryco_recent_activity",
        "ryco_orchestration_events",
        "ryco_provider_runtime_events",
        "ryco_settings_summary",
        "ryco_propose_project_create",
        "ryco_propose_project_update",
        "ryco_propose_project_remove",
        "ryco_propose_settings_change",
        "ryco_list_devices",
        "ryco_read_device_state",
        "ryco_read_device_screenshot",
        "ryco_describe_device_ui",
        "ryco_propose_device_boot",
        "ryco_propose_device_attach",
        "ryco_propose_device_detach",
        "ryco_propose_device_install",
        "ryco_propose_device_launch",
        "ryco_propose_device_open_url",
        "ryco_propose_device_input",
        "ryco_propose_device_recording",
        "ryco_propose_device_shutdown",
      ].toSorted(),
    );
    expect(Object.values(AGENT_CONTROL_MCP_TOOLS)).toHaveLength(39);
    for (const name of AGENT_CONTROL_MCP_TOOL_NAMES) {
      expect(name.startsWith("ryco_")).toBe(true);
    }
  });

  it("decodes only exact typed mutation payloads and rejects sensitive settings categories", async () => {
    const {
      AgentControlMcpCreateThreadsInput,
      AgentControlMcpInterruptThreadInput,
      AgentControlMcpSendMessageInput,
      AgentControlMcpUpdateThreadInput,
      AgentControlMcpProposeProjectCreateInput,
      AgentControlMcpProposeProjectUpdateInput,
      AgentControlMcpProposeProjectRemoveInput,
      AgentControlMcpProposeSettingsChangeInput,
    } = await import("./agentControl.ts");

    expect(
      Schema.decodeUnknownSync(AgentControlMcpCreateThreadsInput)({
        requestId: "request-create",
        entries: [createThreadsPlan.entries[0]],
      }).entries,
    ).toHaveLength(1);
    expect(
      Schema.decodeUnknownSync(AgentControlMcpSendMessageInput)({
        requestId: "request-send",
        threadId: "thread-1",
        text: "Continue",
        delivery: "steer",
      }).delivery,
    ).toBe("steer");
    expect(
      Schema.decodeUnknownSync(AgentControlMcpInterruptThreadInput)({
        requestId: "request-interrupt",
        threadId: "thread-1",
      }).threadId,
    ).toBe("thread-1");
    expect(
      Schema.decodeUnknownSync(AgentControlMcpUpdateThreadInput)({
        requestId: "request-update",
        threadId: "thread-1",
        persistentGoal: null,
      }).persistentGoal,
    ).toBeNull();
    expect(() =>
      Schema.decodeUnknownSync(AgentControlMcpUpdateThreadInput)({
        requestId: "request-update",
        threadId: "thread-1",
        metadata: { arbitrary: true },
      }),
    ).toThrow();
    expect(
      Schema.decodeUnknownSync(AgentControlMcpProposeProjectCreateInput)({
        requestId: "request-project-create",
        projectId: "project-new",
        title: "New project",
        workspaceRoot: "/workspace/new",
      }).projectId,
    ).toBe("project-new");
    expect(
      Schema.decodeUnknownSync(AgentControlMcpProposeProjectUpdateInput)({
        requestId: "request-project-update",
        projectId: "project-1",
        expectedUpdatedAt: "2026-08-18T00:00:00.000Z",
        title: "Renamed",
      }).title,
    ).toBe("Renamed");
    expect(
      Schema.decodeUnknownSync(AgentControlMcpProposeProjectRemoveInput)({
        requestId: "request-project-remove",
        projectId: "project-1",
        expectedUpdatedAt: "2026-08-18T00:00:00.000Z",
        force: true,
      }).force,
    ).toBe(true);
    expect(
      Schema.decodeUnknownSync(AgentControlMcpProposeSettingsChangeInput)({
        requestId: "request-settings",
        change: { kind: "legacyTokenStreaming", value: true },
      }).change.kind,
    ).toBe("legacyTokenStreaming");

    for (const kind of [
      "apiKey",
      "providerEnvironment",
      "providerCommand",
      "mcpServerUrl",
      "relayUrl",
      "authentication",
      "filesystemRoot",
      "networkExposure",
      "agentControlEnabled",
      "genericPatch",
    ]) {
      expect(() =>
        Schema.decodeUnknownSync(AgentControlMcpProposeSettingsChangeInput)({
          requestId: `request-${kind}`,
          change: { kind, value: "secret" },
        }),
      ).toThrow();
    }

    for (const [field, value] of [
      ["apiKey", "secret"],
      ["environment", { API_KEY: "secret" }],
      ["providerCommand", ["provider", "--unsafe"]],
      ["mcpServerUrl", "https://private.example.test"],
      ["relayUrl", "wss://relay.example.test"],
      ["filesystemRoot", "/"],
      ["agentControlEnabled", false],
    ] as const) {
      expect(() =>
        Schema.decodeUnknownSync(AgentControlMcpProposeSettingsChangeInput)({
          requestId: `request-extra-${field}`,
          change: { kind: "legacyTokenStreaming", value: true, [field]: value },
        }),
      ).toThrow();
    }
  });

  it("decodes list/read/wait inputs and rejects out-of-bounds payloads", async () => {
    const {
      AgentControlMcpListThreadsInput,
      AgentControlMcpReadThreadInput,
      AgentControlMcpWaitForControlRequestInput,
    } = await import("./agentControl.ts");
    const decodeListThreads = Schema.decodeUnknownSync(AgentControlMcpListThreadsInput);
    const decodeReadThread = Schema.decodeUnknownSync(AgentControlMcpReadThreadInput);
    const decodeWait = Schema.decodeUnknownSync(AgentControlMcpWaitForControlRequestInput);

    expect(
      decodeListThreads({ projectId: "project-1", includeArchived: true, limit: 5 }).limit,
    ).toBe(5);
    expect(decodeReadThread({ threadId: "thread-1" }).threadId).toBe("thread-1");
    expect(decodeWait({ proposalId: "proposal-1", waitFor: "terminal" }).waitFor).toBe("terminal");

    expect(() => decodeReadThread({})).toThrow();
    expect(() => decodeListThreads({ limit: 0 })).toThrow();
    expect(() => decodeWait({ proposalId: "proposal-1", waitFor: "forever" })).toThrow();
    expect(() => decodeReadThread({ threadId: "thread-1", cursor: "x".repeat(2_000) })).toThrow();
  });

  it("bounds the wait/read control-request result to the receipt shape", async () => {
    const { AgentControlMcpControlRequestResult } = await import("./agentControl.ts");
    const decoded = Schema.decodeUnknownSync(AgentControlMcpControlRequestResult)({
      receipt: {
        proposalId: "proposal-1",
        requestId: "request-1",
        actionKind: "sendMessage",
        planDigest: "a".repeat(64),
        riskTags: [],
        status: "completed",
        createdAt: "2026-08-18T00:00:00.000Z",
        updatedAt: "2026-08-18T00:10:00.000Z",
        expiresAt: "2026-08-18T01:00:00.000Z",
        decidedAt: "2026-08-18T00:05:00.000Z",
        result: { outcome: "completed", completedAt: "2026-08-18T00:10:00.000Z" },
      },
      timedOut: false,
    });
    expect(decoded.receipt.status).toBe("completed");
    // The receipt never carries the plan payload or prompt text.
    expect(decoded.receipt).not.toHaveProperty("plan");
    expect(decoded.receipt).not.toHaveProperty("promptSummary");
  });

  it("decodes capability summaries keyed by provider instance id", async () => {
    const { AgentControlMcpCapabilitiesResult } = await import("./agentControl.ts");
    const decoded = Schema.decodeUnknownSync(AgentControlMcpCapabilitiesResult)({
      enabled: true,
      readOnly: true,
      tools: ["ryco_context"],
      grantedCapabilities: ["read"],
      agentControl: { available: true, injectionMode: "codex-http" },
      providerInstances: [
        {
          instanceId: "codex_personal",
          driver: "codex",
          displayName: "Personal",
          enabled: true,
          status: "ready",
          availability: "available",
          models: [{ slug: "gpt-5.6", name: "GPT-5.6" }],
          agentControl: {
            supported: true,
            runtimeScoped: true,
            http: "native",
            stdio: "unsupported",
            configurationScope: "runtime-session",
            credentialIsolation: "scoped-header",
            reason: null,
            available: true,
            unavailableReason: null,
          },
        },
      ],
    });
    expect(decoded.providerInstances[0]?.instanceId).toBe("codex_personal");
  });
});

describe("AgentControl external MCP", () => {
  it("exposes durable installation state without native fingerprints or credentials", async () => {
    const { AgentControlMcpInstallation } = await import("./agentControl.ts");
    const decode = Schema.decodeUnknownSync(AgentControlMcpInstallation);
    const value = decode({
      installationId: "installation-1",
      integrationId: "integration-1",
      workspaceId: "codex:dGVzdA",
      driver: "codex",
      serverName: "ryco",
      state: "connected",
      revision: 4,
      lastError: null,
      ownsNativeConfig: true,
      preservedUserChanges: false,
      createdAt: "2026-08-19T00:00:00.000Z",
      updatedAt: "2026-08-19T00:01:00.000Z",
      connectedAt: "2026-08-19T00:01:00.000Z",
      nativeFingerprint: "forbidden",
      credential: "rycoext_forbidden",
    });
    expect(value).not.toHaveProperty("nativeFingerprint");
    expect(value).not.toHaveProperty("credential");
  });

  it("publishes the scoped task, automation, activity, and diagnostics tools", async () => {
    const { AGENT_CONTROL_EXTERNAL_MCP_TOOL_NAMES } = await import("./agentControl.ts");
    expect([...AGENT_CONTROL_EXTERNAL_MCP_TOOL_NAMES]).toEqual([
      "ryco_overview",
      "ryco_capabilities",
      "ryco_list_allowed_projects",
      "ryco_create_task",
      "ryco_read_task",
      "ryco_wait_for_task",
      "ryco_list_automations",
      "ryco_read_automation",
      "ryco_list_automation_runs",
      "ryco_propose_automation_create",
      "ryco_propose_automation_update",
      "ryco_propose_automation_cancel",
      "ryco_recent_activity",
      "ryco_orchestration_events",
      "ryco_provider_runtime_events",
      "ryco_diagnostics_summary",
    ]);
  });

  it("requires stable task targeting and defaults no elevated policy on the wire", async () => {
    const { AgentControlExternalCreateTaskInput } = await import("./agentControl.ts");
    const decode = Schema.decodeUnknownSync(AgentControlExternalCreateTaskInput);
    const value = decode({
      requestId: "request-1",
      projectId: "project-1",
      providerInstanceId: "codex-main",
      model: "gpt-5.6",
      options: [],
      prompt: "Fix the focused test.",
    });
    expect(value.environment).toBeUndefined();
    expect(value.runtimeMode).toBeUndefined();
    expect(() => decode({ ...value, requestId: undefined })).toThrow();
    expect(() => decode({ ...value, projectId: undefined })).toThrow();
    expect(() => decode({ ...value, options: undefined })).toThrow();
    expect(() => decode({ ...value, runtimeMode: "auto" })).toThrow();
  });

  it("keeps credentials and secret hashes out of public integration schemas", async () => {
    const { AgentControlExternalIntegration } = await import("./agentControl.ts");
    const decode = Schema.decodeUnknownSync(AgentControlExternalIntegration);
    const value = decode({
      integrationId: "integration-1",
      displayName: "Local Codex",
      clientKind: "codex",
      projectScope: { kind: "all" },
      capabilities: ["external.tasks.create"],
      rateLimitPerMinute: 60,
      activeTaskLimit: 1,
      activeTaskCount: 0,
      expiresAt: null,
      revokedAt: null,
      pairingState: "pending",
      pairingCodeExpiresAt: "2026-08-18T01:00:00.000Z",
      pairedAt: null,
      createdAt: "2026-08-18T00:00:00.000Z",
      updatedAt: "2026-08-18T00:00:00.000Z",
      lastUsedAt: null,
      credential: "rycoext_forbidden",
      credentialHash: "a".repeat(64),
    });
    expect(value).not.toHaveProperty("credential");
    expect(value).not.toHaveProperty("credentialHash");
  });
});
