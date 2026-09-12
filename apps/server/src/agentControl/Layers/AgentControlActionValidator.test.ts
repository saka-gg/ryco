import {
  AGENT_CONTROL_CAPABILITIES,
  AgentControlAutomationId,
  AgentControlIntegrationId,
  AgentControlProposalId,
  AgentControlRequestId,
  OrchestrationProjectShell,
  OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  RuntimeSessionId,
  ServerProvider,
  ThreadId,
  TurnId,
  WorktreeId,
  type AgentControlProposal,
  type AgentControlExternalIntegration,
  type OrchestrationShellSnapshot,
} from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Ref, Schema } from "effect";

import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { DeviceManager } from "../../device/DeviceManager.ts";
import { FakeDeviceBackend } from "../../device/FakeDeviceBackend.ts";
import type { DeviceServiceShape } from "../../device/Services/DeviceService.ts";
import type {
  AgentControlSessionRecord,
  AgentControlTurnAuthority,
} from "../Services/AgentControlSessionRegistry.ts";
import type { AgentControlProjectPlansShape } from "../Services/AgentControlProjectPlans.ts";
import type { AgentControlAutomationShape } from "../Services/AgentControlAutomation.ts";
import { makeAgentControlActionValidatorFromDeps } from "./AgentControlActionValidator.ts";

const now = "2026-08-18T00:00:00.000Z";
const projectId = ProjectId.make("project-1");
const providerInstanceId = ProviderInstanceId.make("codex");
const callerThreadId = ThreadId.make("thread-caller");
const targetThreadId = ThreadId.make("thread-target");
const runtimeSessionId = RuntimeSessionId.make("runtime-caller");
const turnId = TurnId.make("turn-caller");

const project = Schema.decodeUnknownSync(OrchestrationProjectShell)({
  id: projectId,
  title: "Project",
  workspaceRoot: "/workspace/project",
  defaultModelSelection: null,
  scripts: [],
  createdAt: now,
  updatedAt: now,
});

const provider = Schema.decodeUnknownSync(ServerProvider)({
  instanceId: providerInstanceId,
  driver: "codex",
  displayName: "Codex",
  enabled: true,
  installed: true,
  version: "1",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: now,
  models: [{ slug: "gpt-5.6", name: "GPT-5.6", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
});

const thread = (input: {
  readonly id: ThreadId;
  readonly runtimeMode: "approval-required" | "auto" | "full-access";
  readonly envMode: "local" | "worktree";
  readonly archived?: boolean;
  readonly running?: boolean;
}) =>
  Schema.decodeUnknownSync(OrchestrationThreadShell)({
    id: input.id,
    projectId,
    title: String(input.id),
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5.6" },
    runtimeMode: input.runtimeMode,
    interactionMode: "default",
    branch: input.envMode === "worktree" ? "feature" : null,
    worktreePath:
      input.envMode === "worktree" ? `/workspace/worktrees/${input.id}` : "/workspace/project",
    worktreeId: input.envMode === "worktree" ? WorktreeId.make(`worktree-${input.id}`) : null,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: input.archived ? now : null,
    session: input.running
      ? {
          threadId: input.id,
          status: "running",
          providerName: "codex",
          providerInstanceId,
          runtimeSessionId: input.id === callerThreadId ? runtimeSessionId : "runtime-target",
          runtimeMode: input.runtimeMode,
          activeTurnId: input.id === callerThreadId ? turnId : "turn-target",
          lastError: null,
          updatedAt: now,
        }
      : null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  });

const session: AgentControlSessionRecord = {
  sessionId: "agent-control-session",
  threadId: callerThreadId,
  providerInstanceId,
  runtimeSessionId,
  grantedCapabilities: [],
  issuedAt: now,
  injectionMode: "codex-http",
};

const authority: AgentControlTurnAuthority = {
  sessionId: session.sessionId,
  threadId: callerThreadId,
  turnId,
  boundAt: now,
};

const makeSnapshot = (
  caller = thread({
    id: callerThreadId,
    runtimeMode: "approval-required",
    envMode: "worktree",
    running: true,
  }),
  target = thread({ id: targetThreadId, runtimeMode: "approval-required", envMode: "worktree" }),
): OrchestrationShellSnapshot => ({
  snapshotSequence: 1,
  projects: [project],
  threads: [caller, target],
  updatedAt: now,
});

const makeValidator = (
  snapshotRef: Ref.Ref<OrchestrationShellSnapshot>,
  providersRef: Ref.Ref<ReadonlyArray<typeof provider>>,
  availableRefs: ReadonlyArray<string> = [],
  revalidateExternal?: (
    integrationId: AgentControlIntegrationId,
  ) => Effect.Effect<AgentControlExternalIntegration>,
  projectPlans?: AgentControlProjectPlansShape,
  automations?: AgentControlAutomationShape,
  deviceService?: DeviceServiceShape,
) =>
  makeAgentControlActionValidatorFromDeps({
    projections: {
      getShellSnapshot: () => Ref.get(snapshotRef),
    } as unknown as ProjectionSnapshotQueryShape,
    getProviders: Ref.get(providersRef),
    listRefs: () =>
      Effect.succeed({
        refs: availableRefs.map((name) => ({
          name,
          current: name === "main",
          isDefault: name === "main",
          worktreePath: null,
        })),
        isRepo: true,
        hasPrimaryRemote: true,
        nextCursor: null,
        totalCount: availableRefs.length,
      }),
    ...(revalidateExternal === undefined ? {} : { revalidateExternal }),
    ...(projectPlans === undefined ? {} : { projectPlans }),
    ...(automations === undefined ? {} : { automations }),
    ...(deviceService === undefined ? {} : { deviceService }),
  });

it.effect("binds device plans to exact thread, project, provider, attachment, and version", () =>
  Effect.gen(function* () {
    const snapshot = yield* Ref.make(makeSnapshot());
    const providers = yield* Ref.make<ReadonlyArray<typeof provider>>([provider]);
    const backend = new FakeDeviceBackend();
    backend.bootExternally("FAKE-0001");
    const manager = new DeviceManager({ backend });
    yield* Effect.promise(() => manager.attach(callerThreadId, "FAKE-0001"));
    const deviceState = yield* Effect.promise(() => manager.getThreadState(callerThreadId));
    const descriptor = deviceState.devices.find((device) => device.udid === "FAKE-0001")!;
    const plan = {
      kind: "deviceTap" as const,
      threadId: callerThreadId,
      projectId,
      expectedProjectUpdatedAt: project.updatedAt,
      providerInstanceId,
      udid: descriptor.udid,
      expectedThreadDeviceVersion: deviceState.version,
      expectedAttachedDeviceUdid: descriptor.udid,
      expectedDeviceState: descriptor.state,
      expectedDeviceBootSource: descriptor.bootSource,
      expectedRecording: false,
      executionSummary: "Tap iOS Simulator FAKE-0001",
      riskClass: "device-control" as const,
      x: 10,
      y: 20,
    };
    let submissionManagerAccessed = false;
    const submissionValidator = makeValidator(
      snapshot,
      providers,
      [],
      undefined,
      undefined,
      undefined,
      {
        supported: true,
        manager: new Proxy({} as DeviceManager, {
          get: () => {
            submissionManagerAccessed = true;
            throw new Error("Submission touched DeviceService before acceptance.");
          },
        }),
      },
    );
    const validator = makeValidator(snapshot, providers, [], undefined, undefined, undefined, {
      supported: true,
      manager,
    });

    const principal = yield* submissionValidator.validateSubmission({ session, authority, plan });
    assert.isFalse(submissionManagerAccessed);
    const wrongProvider = yield* Effect.flip(
      submissionValidator.validateSubmission({
        session,
        authority,
        plan: { ...plan, providerInstanceId: ProviderInstanceId.make("other") },
      }),
    );
    assert.strictEqual(wrongProvider.reason, "project-scope");
    const wrongThread = yield* Effect.flip(
      submissionValidator.validateSubmission({
        session,
        authority,
        plan: { ...plan, threadId: targetThreadId },
      }),
    );
    assert.strictEqual(wrongThread.reason, "project-scope");

    const proposal: AgentControlProposal = {
      proposalId: AgentControlProposalId.make("proposal-device"),
      requestId: AgentControlRequestId.make("request-device"),
      principal,
      planVersion: 1,
      plan,
      planDigest: "d".repeat(64),
      riskTags: [],
      promptSummary: null,
      status: "approved",
      createdAt: now,
      updatedAt: now,
      expiresAt: "2099-01-01T00:00:00.000Z",
      decidedAt: now,
      result: null,
    };
    yield* validator.revalidateExecution(proposal);

    yield* Ref.set(snapshot, {
      ...makeSnapshot(),
      projects: [{ ...project, updatedAt: "2026-08-18T00:00:01.000Z" }],
    });
    const staleProject = yield* Effect.flip(validator.revalidateExecution(proposal));
    assert.strictEqual(staleProject.reason, "project-stale");
    yield* Ref.set(snapshot, makeSnapshot());

    yield* Effect.promise(() => manager.detach(callerThreadId));
    const stale = yield* Effect.flip(validator.revalidateExecution(proposal));
    assert.strictEqual(stale.reason, "thread-stale");
    yield* Effect.promise(() => manager.dispose());
  }),
);

it.effect("rejects a boot plan for a device deliberately attached to another thread", () =>
  Effect.gen(function* () {
    const snapshot = yield* Ref.make(makeSnapshot());
    const providers = yield* Ref.make<ReadonlyArray<typeof provider>>([provider]);
    const manager = new DeviceManager({ backend: new FakeDeviceBackend() });
    yield* Effect.promise(() => manager.attach(targetThreadId, "FAKE-0001"));
    const callerState = yield* Effect.promise(() => manager.getThreadState(callerThreadId));
    const descriptor = callerState.devices.find((device) => device.udid === "FAKE-0001")!;
    const plan = {
      kind: "deviceBoot" as const,
      threadId: callerThreadId,
      projectId,
      expectedProjectUpdatedAt: project.updatedAt,
      providerInstanceId,
      udid: descriptor.udid,
      expectedThreadDeviceVersion: callerState.version,
      expectedAttachedDeviceUdid: null,
      expectedDeviceState: descriptor.state,
      expectedDeviceBootSource: descriptor.bootSource,
      expectedRecording: false,
      executionSummary: "Boot iOS Simulator FAKE-0001",
      riskClass: "device-lifecycle" as const,
    };
    const validator = makeValidator(snapshot, providers, [], undefined, undefined, undefined, {
      supported: true,
      manager,
    });
    const principal = yield* validator.validateSubmission({ session, authority, plan });
    const proposal: AgentControlProposal = {
      proposalId: AgentControlProposalId.make("proposal-cross-thread-device"),
      requestId: AgentControlRequestId.make("request-cross-thread-device"),
      principal,
      planVersion: 1,
      plan,
      planDigest: "e".repeat(64),
      riskTags: [],
      promptSummary: null,
      status: "approved",
      createdAt: now,
      updatedAt: now,
      expiresAt: "2099-01-01T00:00:00.000Z",
      decidedAt: now,
      result: null,
    };

    const rejected = yield* Effect.flip(validator.revalidateExecution(proposal));
    assert.strictEqual(rejected.reason, "thread-stale");
    yield* Effect.promise(() => manager.dispose());
  }),
);

it.effect("scopes project mutations and allows closed non-secret settings plans", () =>
  Effect.gen(function* () {
    const snapshot = yield* Ref.make(makeSnapshot());
    const providers = yield* Ref.make<ReadonlyArray<typeof provider>>([provider]);
    let revalidations = 0;
    const projectPlans: AgentControlProjectPlansShape = {
      prepareCreate: () => Effect.die("unused"),
      prepareUpdate: () => Effect.die("unused"),
      prepareRemove: () => Effect.die("unused"),
      revalidate: () =>
        Effect.sync(() => {
          revalidations += 1;
        }),
    };
    const validator = makeValidator(snapshot, providers, [], undefined, projectPlans);
    const state = {
      title: project.title,
      workspaceRoot: project.workspaceRoot,
      repositoryIdentityKey: null,
      updatedAt: project.updatedAt,
    } as const;

    yield* validator.validateSubmission({
      session,
      authority,
      plan: {
        kind: "updateProject",
        projectId,
        before: state,
        after: {
          title: "Renamed",
          workspaceRoot: state.workspaceRoot,
          repositoryIdentityKey: state.repositoryIdentityKey,
        },
      },
    });
    assert.strictEqual(revalidations, 1);

    const scopeError = yield* Effect.flip(
      validator.validateSubmission({
        session,
        authority,
        plan: {
          kind: "removeProject",
          projectId: ProjectId.make("project-other"),
          expected: state,
          expectedThreadIds: [],
          force: false,
        },
      }),
    );
    assert.strictEqual(scopeError.reason, "project-scope");

    const settingsPrincipal = yield* validator.validateSubmission({
      session,
      authority,
      plan: {
        kind: "changeSettings",
        change: { kind: "legacyTokenStreaming", before: false, after: true },
      },
    });
    assert.strictEqual(settingsPrincipal.kind, "provider-session");
  }),
);

it.effect("verifies an exact worktree base ref before creating a proposal", () =>
  Effect.gen(function* () {
    const snapshot = yield* Ref.make(makeSnapshot());
    const providers = yield* Ref.make<ReadonlyArray<typeof provider>>([provider]);
    const plan = {
      kind: "createThreads" as const,
      entries: [
        {
          projectId,
          title: "New task",
          prompt: "Implement it",
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5.6" },
          runtimeMode: "approval-required" as const,
          envMode: "worktree" as const,
          baseRef: "main",
        },
      ],
    };

    const unavailable = yield* Effect.flip(
      makeValidator(snapshot, providers).validateSubmission({ session, authority, plan }),
    );
    assert.strictEqual(unavailable.reason, "worktree-preflight");

    yield* makeValidator(snapshot, providers, ["main"]).validateSubmission({
      session,
      authority,
      plan,
    });
  }),
);

it.effect("blocks runtime and worktree privilege escalation before proposal creation", () =>
  Effect.gen(function* () {
    const providers = yield* Ref.make<ReadonlyArray<typeof provider>>([provider]);

    const runtimeSnapshot = yield* Ref.make(
      makeSnapshot(
        undefined,
        thread({ id: targetThreadId, runtimeMode: "full-access", envMode: "worktree" }),
      ),
    );
    const runtimeError = yield* Effect.flip(
      makeValidator(runtimeSnapshot, providers).validateSubmission({
        session,
        authority,
        plan: {
          kind: "updateThread",
          threadId: targetThreadId,
          title: "No elevation",
        },
      }),
    );
    assert.strictEqual(runtimeError.reason, "privilege-escalation");

    const localSnapshot = yield* Ref.make(
      makeSnapshot(
        undefined,
        thread({ id: targetThreadId, runtimeMode: "approval-required", envMode: "local" }),
      ),
    );
    const localError = yield* Effect.flip(
      makeValidator(localSnapshot, providers).validateSubmission({
        session,
        authority,
        plan: {
          kind: "sendMessage",
          threadId: targetThreadId,
          text: "No checkout proxy",
          delivery: "queue",
        },
      }),
    );
    assert.strictEqual(localError.reason, "worktree-escalation");
  }),
);

it.effect("revalidates target state and provider/model availability at execution time", () =>
  Effect.gen(function* () {
    const snapshot = yield* Ref.make(makeSnapshot());
    const providers = yield* Ref.make<ReadonlyArray<typeof provider>>([provider]);
    const validator = makeValidator(snapshot, providers);
    const principal = yield* validator.validateSubmission({
      session,
      authority,
      plan: {
        kind: "sendMessage",
        threadId: targetThreadId,
        text: "Continue",
        delivery: "queue",
      },
    });
    const proposal: AgentControlProposal = {
      proposalId: AgentControlProposalId.make("proposal-1"),
      requestId: AgentControlRequestId.make("request-1"),
      principal,
      planVersion: 1,
      plan: {
        kind: "sendMessage",
        threadId: targetThreadId,
        text: "Continue",
        delivery: "queue",
      },
      planDigest: "a".repeat(64),
      riskTags: [],
      promptSummary: null,
      status: "approved",
      createdAt: now,
      updatedAt: now,
      expiresAt: "2099-01-01T00:00:00.000Z",
      decidedAt: now,
      result: null,
    };

    yield* Ref.set(snapshot, { ...makeSnapshot(), threads: [makeSnapshot().threads[0]!] });
    const deleted = yield* Effect.flip(validator.revalidateExecution(proposal));
    assert.strictEqual(deleted.reason, "thread-unavailable");

    yield* Ref.set(
      snapshot,
      makeSnapshot(
        undefined,
        thread({ id: targetThreadId, runtimeMode: "auto", envMode: "worktree" }),
      ),
    );
    const changed = yield* Effect.flip(validator.revalidateExecution(proposal));
    assert.strictEqual(changed.reason, "privilege-escalation");

    yield* Ref.set(
      snapshot,
      makeSnapshot(
        undefined,
        thread({
          id: targetThreadId,
          runtimeMode: "approval-required",
          envMode: "worktree",
          archived: true,
        }),
      ),
    );
    const archived = yield* Effect.flip(validator.revalidateExecution(proposal));
    assert.strictEqual(archived.reason, "thread-unavailable");

    yield* Ref.set(snapshot, makeSnapshot());
    yield* Ref.set(providers, [{ ...provider, models: [] }]);
    const missingModel = yield* Effect.flip(validator.revalidateExecution(proposal));
    assert.strictEqual(missingModel.reason, "model-unavailable");

    yield* Ref.set(providers, []);
    const unavailable = yield* Effect.flip(validator.revalidateExecution(proposal));
    assert.strictEqual(unavailable.reason, "provider-unavailable");
  }),
);

it.effect("allows an approved proposal to execute after the origin turn is torn down", () =>
  Effect.gen(function* () {
    const snapshot = yield* Ref.make(makeSnapshot());
    const providers = yield* Ref.make<ReadonlyArray<typeof provider>>([provider]);
    const validator = makeValidator(snapshot, providers);
    const plan = {
      kind: "updateThread" as const,
      threadId: targetThreadId,
      title: "Approved title",
    };
    const principal = yield* validator.validateSubmission({ session, authority, plan });
    const originStopped = thread({
      id: callerThreadId,
      runtimeMode: "approval-required",
      envMode: "worktree",
    });
    yield* Ref.set(snapshot, makeSnapshot(originStopped));

    yield* validator.revalidateExecution({
      proposalId: AgentControlProposalId.make("proposal-origin-stopped"),
      requestId: AgentControlRequestId.make("request-origin-stopped"),
      principal,
      planVersion: 1,
      plan,
      planDigest: "b".repeat(64),
      riskTags: [],
      promptSummary: null,
      status: "approved",
      createdAt: now,
      updatedAt: now,
      expiresAt: "2099-01-01T00:00:00.000Z",
      decidedAt: now,
      result: null,
    });
  }),
);

it.effect("binds external proposals to current scope and revalidates grants before execution", () =>
  Effect.gen(function* () {
    const snapshot = yield* Ref.make(makeSnapshot());
    const providers = yield* Ref.make<ReadonlyArray<typeof provider>>([provider]);
    const integrationId = AgentControlIntegrationId.make("integration-validator");
    const integrationRef = yield* Ref.make<AgentControlExternalIntegration>({
      integrationId,
      displayName: "External Codex",
      clientKind: "codex",
      projectScope: { kind: "selected", projectIds: [projectId] },
      capabilities: [
        AGENT_CONTROL_CAPABILITIES.externalCreateTask,
        AGENT_CONTROL_CAPABILITIES.externalReadTask,
      ],
      rateLimitPerMinute: 60,
      activeTaskLimit: 1,
      activeTaskCount: 0,
      expiresAt: null,
      revokedAt: null,
      pairingState: "paired",
      pairingCodeExpiresAt: null,
      pairedAt: now,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
    });
    const validator = makeValidator(snapshot, providers, [], () => Ref.get(integrationRef));
    const plan = {
      kind: "createThreads" as const,
      entries: [
        {
          projectId,
          title: "External task",
          prompt: "Run the focused fix.",
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5.6", options: [] },
          runtimeMode: "approval-required" as const,
          envMode: "worktree" as const,
        },
      ],
    };
    const principal = yield* validator.validateExternalSubmission({
      integration: yield* Ref.get(integrationRef),
      plan,
    });
    assert.strictEqual(principal.kind, "external-integration");
    assert.strictEqual(principal.projectId, projectId);

    const proposal: AgentControlProposal = {
      proposalId: AgentControlProposalId.make("proposal-external"),
      requestId: AgentControlRequestId.make("request-external"),
      principal,
      planVersion: 1,
      plan,
      planDigest: "c".repeat(64),
      riskTags: [],
      promptSummary: "External integration requested one task",
      status: "approved",
      createdAt: now,
      updatedAt: now,
      expiresAt: "2099-01-01T00:00:00.000Z",
      decidedAt: now,
      result: null,
    };
    yield* validator.revalidateExecution(proposal);

    yield* Ref.update(integrationRef, (current) => ({ ...current, capabilities: [] }));
    const changed = yield* Effect.flip(validator.revalidateExecution(proposal));
    assert.strictEqual(changed.reason, "caller-stale");
  }),
);

it.effect("binds external automation proposals to project, provider, and current grants", () =>
  Effect.gen(function* () {
    const snapshot = yield* Ref.make(makeSnapshot());
    const providers = yield* Ref.make<ReadonlyArray<typeof provider>>([provider]);
    const integrationId = AgentControlIntegrationId.make("integration-automation-validator");
    const integrationRef = yield* Ref.make<AgentControlExternalIntegration>({
      integrationId,
      displayName: "External scheduler",
      clientKind: "generic-mcp",
      projectScope: { kind: "selected", projectIds: [projectId] },
      capabilities: [
        AGENT_CONTROL_CAPABILITIES.externalCreateTask,
        AGENT_CONTROL_CAPABILITIES.externalManageAutomations,
      ],
      rateLimitPerMinute: 60,
      activeTaskLimit: 1,
      activeTaskCount: 0,
      expiresAt: null,
      revokedAt: null,
      pairingState: "paired",
      pairingCodeExpiresAt: null,
      pairedAt: now,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
    });
    const automations = {
      validateLifecyclePlan: () => Effect.void,
    } as unknown as AgentControlAutomationShape;
    const validator = makeValidator(
      snapshot,
      providers,
      [],
      () => Ref.get(integrationRef),
      undefined,
      automations,
    );
    const plan = {
      kind: "createAutomation" as const,
      automationId: AgentControlAutomationId.make("automation-external-scope"),
      definition: {
        execution: {
          projectId,
          title: "Scoped scheduled task",
          prompt: "Prepare one exact proposal when due.",
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5.6", options: [] },
          runtimeMode: "approval-required" as const,
          envMode: "worktree" as const,
        },
        schedule: { kind: "once" as const, runAt: "2099-01-01T00:00:00.000Z" },
        enabled: true,
      },
    };

    const principal = yield* validator.validateExternalSubmission({
      integration: yield* Ref.get(integrationRef),
      plan,
    });
    const proposal: AgentControlProposal = {
      proposalId: AgentControlProposalId.make("proposal-external-automation"),
      requestId: AgentControlRequestId.make("request-external-automation"),
      principal,
      planVersion: 1,
      plan,
      planDigest: "d".repeat(64),
      riskTags: [],
      promptSummary: "Create a governed automation",
      status: "approved",
      createdAt: now,
      updatedAt: now,
      expiresAt: "2099-01-01T00:00:00.000Z",
      decidedAt: now,
      result: null,
    };
    yield* validator.revalidateExecution(proposal);

    const deniedScope = yield* Effect.flip(
      validator.validateExternalSubmission({
        integration: {
          ...(yield* Ref.get(integrationRef)),
          projectScope: { kind: "selected", projectIds: [] },
        },
        plan,
      }),
    );
    assert.strictEqual(deniedScope.reason, "project-scope");

    yield* Ref.update(integrationRef, (current) => ({
      ...current,
      capabilities: [AGENT_CONTROL_CAPABILITIES.externalCreateTask],
    }));
    const revoked = yield* Effect.flip(validator.revalidateExecution(proposal));
    assert.strictEqual(revoked.reason, "caller-stale");
  }),
);
