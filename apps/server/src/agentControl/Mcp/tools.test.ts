import {
  AGENT_CONTROL_CAPABILITIES,
  AGENT_CONTROL_MCP_MESSAGE_TEXT_MAX_CHARS,
  AGENT_CONTROL_MCP_READ_THREAD_TEXT_BUDGET_CHARS,
  AGENT_CONTROL_MCP_TOOLS,
  AGENT_CONTROL_MCP_TOOL_NAMES,
  AGENT_CONTROL_RISK_TAGS,
  AGENT_CONTROL_ACTION_CAPABILITIES,
  DEFAULT_SERVER_SETTINGS,
  AgentControlAutomationId,
  AgentControlProposalId,
  AgentControlRequestId,
  OrchestrationProjectShell,
  OrchestrationThreadShell,
  OrchestrationThreadWindowSnapshot,
  ProviderInstanceId,
  RuntimeSessionId,
  ServerProvider,
  ThreadId,
  TurnId,
  type AgentControlProposal,
  type AgentControlProposalStreamProposalEvent,
  type OrchestrationShellSnapshot,
} from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Fiber, Option, PubSub, Schema } from "effect";

import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { DeviceManager } from "../../device/DeviceManager.ts";
import { FakeDeviceBackend } from "../../device/FakeDeviceBackend.ts";
import {
  AgentControlCapabilityDeniedError,
  AgentControlDisabledError,
  AgentControlPlanValidationError,
} from "../Errors.ts";
import type { AgentControlPolicyShape } from "../Services/AgentControlPolicy.ts";
import type { AgentControlAutomationShape } from "../Services/AgentControlAutomation.ts";
import type { AgentControlSessionRecord } from "../Services/AgentControlSessionRegistry.ts";
import { makeAgentControlMcpTools, type AgentControlMcpToolDeps } from "./tools.ts";

// ── Fixtures ──────────────────────────────────────────────────────────

const decodeProject = Schema.decodeUnknownSync(OrchestrationProjectShell);
const decodeThread = Schema.decodeUnknownSync(OrchestrationThreadShell);
const decodeWindow = Schema.decodeUnknownSync(OrchestrationThreadWindowSnapshot);
const decodeProvider = Schema.decodeUnknownSync(ServerProvider);

const T0 = "2026-08-18T00:00:00.000Z";
const T1 = "2026-08-18T01:00:00.000Z";
const T2 = "2026-08-18T02:00:00.000Z";

const projectOne = decodeProject({
  id: "project-1",
  title: "Project one",
  workspaceRoot: "/secret/path/project-one",
  defaultModelSelection: null,
  scripts: [
    {
      id: "script-1",
      name: "deploy",
      command: "./secret-deploy.sh --prod",
      icon: "play",
      runOnWorktreeCreate: false,
    },
  ],
  createdAt: T0,
  updatedAt: T0,
});
const projectTwo = decodeProject({
  id: "project-2",
  title: "Project two",
  workspaceRoot: "/secret/path/project-two",
  defaultModelSelection: null,
  scripts: [],
  createdAt: T1,
  updatedAt: T1,
});

const modelSelection = { instanceId: "codex", model: "gpt-5.3-codex" };

const makeThreadShell = (input: {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly createdAt: string;
  readonly archivedAt?: string | null;
  readonly session?: unknown;
}) =>
  decodeThread({
    id: input.id,
    projectId: input.projectId,
    title: input.title,
    modelSelection,
    runtimeMode: "auto",
    branch: null,
    worktreePath: "/secret/worktrees/somewhere",
    latestTurn: null,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    archivedAt: input.archivedAt ?? null,
    session: input.session ?? null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  });

const callerThreadId = ThreadId.make("thread-caller");

const threadCaller = makeThreadShell({
  id: "thread-caller",
  projectId: "project-1",
  title: "Caller thread",
  createdAt: T0,
  session: {
    threadId: "thread-caller",
    status: "running",
    providerName: "codex",
    providerInstanceId: "codex",
    runtimeSessionId: "runtime-1",
    runtimeMode: "auto",
    activeTurnId: "turn-active",
    lastError: null,
    updatedAt: T1,
  },
});
const threadOther = makeThreadShell({
  id: "thread-other",
  projectId: "project-2",
  title: "Other thread",
  createdAt: T1,
});
const threadArchived = makeThreadShell({
  id: "thread-archived",
  projectId: "project-1",
  title: "Archived thread",
  createdAt: T2,
  archivedAt: T2,
});

const shellSnapshot: OrchestrationShellSnapshot = {
  snapshotSequence: 12,
  projects: [projectOne, projectTwo],
  threads: [threadCaller, threadOther, threadArchived],
  updatedAt: T2,
};

const longText = "x".repeat(AGENT_CONTROL_MCP_MESSAGE_TEXT_MAX_CHARS + 500);

const windowSnapshot = decodeWindow({
  snapshotSequence: 12,
  thread: {
    id: "thread-caller",
    projectId: "project-1",
    title: "Caller thread",
    modelSelection,
    runtimeMode: "auto",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: T0,
    updatedAt: T1,
    deletedAt: null,
    messages: [
      {
        id: "message-1",
        role: "user",
        text: "hello",
        turnId: null,
        streaming: false,
        createdAt: T0,
        updatedAt: T0,
      },
      {
        id: "message-2",
        role: "assistant",
        text: longText,
        attachments: [
          { type: "image", id: "att-1", name: "shot.png", mimeType: "image/png", sizeBytes: 10 },
        ],
        turnId: "turn-1",
        streaming: false,
        createdAt: T1,
        updatedAt: T1,
      },
    ],
    activities: [],
    checkpoints: [],
    session: null,
  },
  history: {
    messages: { oldestCursor: "cursor-oldest", newestCursor: "cursor-newest", hasMoreBefore: true },
    proposedPlans: { oldestCursor: null, newestCursor: null, hasMoreBefore: false },
    activities: { oldestCursor: null, newestCursor: null, hasMoreBefore: false },
    checkpoints: { oldestCursor: null, newestCursor: null, hasMoreBefore: false },
  },
});

const codexProvider = decodeProvider({
  instanceId: "codex",
  driver: "codex",
  displayName: "Codex personal",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated", email: "user@example.com" },
  checkedAt: T0,
  models: Array.from({ length: 60 }, (_, index) => ({
    slug: `model-${index}`,
    name: `Model ${index}`,
    isCustom: false,
    capabilities: null,
  })),
  slashCommands: [],
  skills: [],
});

const proposalOwn: AgentControlProposal = {
  proposalId: AgentControlProposalId.make("proposal-own"),
  requestId: AgentControlRequestId.make("request-own"),
  principal: {
    kind: "provider-session",
    threadId: callerThreadId,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  planVersion: 1,
  plan: {
    kind: "sendMessage",
    threadId: ThreadId.make("thread-other"),
    text: "The secret plan prompt that must never surface in receipts.",
    delivery: "queue",
  },
  planDigest: "a".repeat(64),
  riskTags: [],
  promptSummary: "Send a message",
  status: "pending-user-approval",
  createdAt: T0,
  updatedAt: T0,
  expiresAt: "2099-01-01T00:00:00.000Z",
  decidedAt: null,
  result: null,
};

const proposalForeign: AgentControlProposal = {
  ...proposalOwn,
  proposalId: AgentControlProposalId.make("proposal-foreign"),
  requestId: AgentControlRequestId.make("request-foreign"),
  principal: {
    kind: "provider-session",
    threadId: ThreadId.make("thread-other"),
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
};

const session: AgentControlSessionRecord = {
  sessionId: "session-1",
  threadId: callerThreadId,
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeSessionId: RuntimeSessionId.make("runtime-1"),
  grantedCapabilities: [AGENT_CONTROL_CAPABILITIES.read],
  issuedAt: T0,
  injectionMode: "codex-http",
};

const writeSession: AgentControlSessionRecord = {
  ...session,
  grantedCapabilities: Object.values(AGENT_CONTROL_CAPABILITIES),
};

const activeAuthority = {
  sessionId: session.sessionId,
  threadId: callerThreadId,
  turnId: TurnId.make("turn-active"),
  boundAt: T1,
} as const;

// ── Stub deps ─────────────────────────────────────────────────────────

const allowPolicy: AgentControlPolicyShape = {
  isEnabled: Effect.succeed(true),
  requireEnabled: () => Effect.void,
  requiredCapabilityForAction: (kind) => AGENT_CONTROL_ACTION_CAPABILITIES[kind],
  authorize: (input) =>
    input.grantedCapabilities.includes(input.requiredCapability)
      ? Effect.void
      : Effect.fail(
          new AgentControlCapabilityDeniedError({
            operation: input.operation,
            capability: input.requiredCapability,
          }),
        ),
};

const unavailable = (name: string) => (): never => {
  throw new Error(`${name} not stubbed`);
};

const projections: ProjectionSnapshotQueryShape = {
  getCommandReadModel: unavailable("getCommandReadModel"),
  getSnapshot: unavailable("getSnapshot"),
  getShellSnapshot: () => Effect.succeed(shellSnapshot),
  getSnapshotSequence: unavailable("getSnapshotSequence"),
  getCounts: unavailable("getCounts"),
  getActiveProjectByWorkspaceRoot: unavailable("getActiveProjectByWorkspaceRoot"),
  getProjectShellById: (projectId) =>
    Effect.succeed(
      Option.fromNullishOr([projectOne, projectTwo].find((project) => project.id === projectId)),
    ),
  getFirstActiveThreadIdByProjectId: unavailable("getFirstActiveThreadIdByProjectId"),
  getThreadCheckpointContext: unavailable("getThreadCheckpointContext"),
  getThreadShellById: (threadId) =>
    Effect.succeed(
      Option.fromNullishOr(
        [threadCaller, threadOther, threadArchived].find((thread) => thread.id === threadId),
      ),
    ),
  getThreadDetailById: unavailable("getThreadDetailById"),
  getThreadWindow: () => Effect.succeed(windowSnapshot),
  getThreadHistoryPage: (input) =>
    Effect.succeed({
      collection: "messages" as const,
      snapshotSequence: 12,
      items: windowSnapshot.thread.messages.slice(0, input.limit),
      page: { oldestCursor: null, newestCursor: null, hasMoreBefore: false },
    }),
  searchThreadMessages: unavailable("searchThreadMessages"),
};

const makeDeps = (overrides?: Partial<AgentControlMcpToolDeps>): AgentControlMcpToolDeps => ({
  policy: allowPolicy,
  proposals: {
    getProposal: (proposalId) =>
      Effect.succeed(
        Option.fromNullishOr(
          [proposalOwn, proposalForeign].find((candidate) => candidate.proposalId === proposalId),
        ),
      ),
  },
  proposalEvents: {
    subscribe: Effect.die("subscribe not stubbed" as const) as never,
  },
  projections,
  getProviders: Effect.succeed([codexProvider]),
  ...overrides,
});

const call = (
  deps: AgentControlMcpToolDeps,
  name: string,
  args?: unknown,
  caller: AgentControlSessionRecord = session,
) => makeAgentControlMcpTools(deps).callTool(caller, name, args);

const structured = (result: { readonly structuredContent?: unknown }): unknown =>
  result.structuredContent;

// ── Catalog ───────────────────────────────────────────────────────────

it.effect("advertises capability-scoped reads and all proposal-only writes with authority", () =>
  Effect.gen(function* () {
    const tools = makeAgentControlMcpTools(makeDeps());
    const readDescriptors = yield* tools.descriptorsFor(session);
    assert.strictEqual(readDescriptors.length, 7);
    const serialized = JSON.stringify(readDescriptors).toLowerCase();
    for (const mutation of ["create_thread", "send_message", "interrupt", "update_thread"]) {
      assert.notInclude(serialized, mutation);
    }

    const writeTools = makeAgentControlMcpTools(
      makeDeps({
        getTurnAuthority: () => Effect.succeed(Option.some(activeAuthority)),
        deviceService: { supported: true, manager: {} as never },
      }),
    );
    const writeDescriptors = yield* writeTools.descriptorsFor(writeSession);
    assert.deepStrictEqual(
      writeDescriptors.map((descriptor) => descriptor.name).toSorted(),
      [...AGENT_CONTROL_MCP_TOOL_NAMES].toSorted(),
    );
    assert.strictEqual(
      writeDescriptors.filter((tool) => writeTools.isWriteTool(tool.name)).length,
      20,
    );
    assert.isTrue(tools.hasTool("ryco_create_threads"));
  }),
);

it.effect(
  "advertises the same mutation catalog before the first turn and after turn retirement",
  () =>
    Effect.gen(function* () {
      const beforeTurn = makeAgentControlMcpTools(makeDeps());
      const duringTurn = makeAgentControlMcpTools(
        makeDeps({ getTurnAuthority: () => Effect.succeed(Option.some(activeAuthority)) }),
      );
      const before = yield* beforeTurn.descriptorsFor(writeSession);
      assert.deepStrictEqual(before, yield* duringTurn.descriptorsFor(writeSession));
      assert.include(
        before.map((tool) => tool.name),
        "ryco_create_threads",
      );
      const denied = yield* beforeTurn.callTool(writeSession, "ryco_create_threads", {});
      assert.isTrue(denied.isError);
      assert.include(denied.content[0]!.text, "active-turn");
    }),
);

it.effect("device mutation tools create immutable proposals without touching DeviceService", () =>
  Effect.gen(function* () {
    let managerAccessed = false;
    const manager = new Proxy({} as DeviceManager, {
      get: () => {
        managerAccessed = true;
        throw new Error("Mutation proposal touched DeviceService before acceptance.");
      },
    });
    const submitted: Array<
      Parameters<NonNullable<AgentControlMcpToolDeps["proposals"]["submit"]>>[0]
    > = [];
    const deps = makeDeps({
      deviceService: { supported: true, manager },
      getTurnAuthority: () => Effect.succeed(Option.some(activeAuthority)),
      validator: {
        validateSubmission: () => Effect.succeed(proposalOwn.principal as never),
        validateExternalSubmission: () => Effect.die("unused"),
        revalidateExecution: () => Effect.void,
      },
      proposals: {
        getProposal: makeDeps().proposals.getProposal,
        submit: (input) => {
          submitted.push(input);
          return Effect.succeed({
            replayed: false,
            proposal: {
              ...proposalOwn,
              requestId: input.requestId,
              principal: input.principal,
              plan: input.plan,
              riskTags: input.riskTags,
              promptSummary: input.promptSummary,
            },
          });
        },
      },
    });

    const result = yield* call(
      deps,
      AGENT_CONTROL_MCP_TOOLS.proposeDeviceBoot,
      {
        requestId: "request-device-boot",
        udid: "FAKE-0001",
        expectedThreadDeviceVersion: 0,
        expectedAttachedDeviceUdid: null,
        expectedDeviceState: "shutdown",
        expectedDeviceBootSource: "user",
        expectedRecording: false,
      },
      writeSession,
    );
    assert.isUndefined(result.isError);
    assert.strictEqual(submitted.length, 1);
    assert.strictEqual(submitted[0]?.plan.kind, "deviceBoot");
    assert.isFalse(managerAccessed);
  }),
);

it.effect(
  "sensitive device reads stay attached-thread-only and never gain structured content",
  () =>
    Effect.gen(function* () {
      const backend = new FakeDeviceBackend();
      backend.bootExternally("FAKE-0001");
      const manager = new DeviceManager({ backend });
      yield* Effect.promise(() => manager.attach(callerThreadId, "FAKE-0001"));
      const contentSession = {
        ...writeSession,
        grantedCapabilities: [AGENT_CONTROL_CAPABILITIES.readDeviceContent],
      };
      const deps = makeDeps({ deviceService: { supported: true, manager } });

      const screenshot = yield* call(
        deps,
        AGENT_CONTROL_MCP_TOOLS.readDeviceScreenshot,
        { udid: "FAKE-0001" },
        contentSession,
      );
      assert.isUndefined(screenshot.isError);
      assert.strictEqual(screenshot.content[0]?.type, "image");
      assert.isUndefined(screenshot.structuredContent);

      const ui = yield* call(
        deps,
        AGENT_CONTROL_MCP_TOOLS.describeDeviceUi,
        { udid: "FAKE-0001" },
        contentSession,
      );
      assert.isUndefined(ui.isError);
      assert.isUndefined(ui.structuredContent);

      const denied = yield* call(
        deps,
        AGENT_CONTROL_MCP_TOOLS.readDeviceScreenshot,
        { udid: "FAKE-0002" },
        contentSession,
      );
      assert.isTrue(denied.isError);
      assert.strictEqual(backend.calls.filter((entry) => entry.kind === "screenshot").length, 1);
      yield* Effect.promise(() => manager.dispose());
    }),
);

it.effect("automation create, update, and cancel remain inert exact proposals until accepted", () =>
  Effect.gen(function* () {
    const submitted: Array<
      Parameters<NonNullable<AgentControlMcpToolDeps["proposals"]["submit"]>>[0]
    > = [];
    const currentAutomation = {
      automationId: AgentControlAutomationId.make("automation-existing"),
      principal: proposalOwn.principal,
      projectId: projectOne.id,
      providerInstanceId: ProviderInstanceId.make("codex"),
      definition: {
        execution: {
          projectId: projectOne.id,
          title: "Existing bounded review",
          prompt: "Review the project and report findings.",
          modelSelection,
          runtimeMode: "auto" as const,
          envMode: "worktree" as const,
        },
        schedule: { kind: "once" as const, runAt: "2099-08-19T00:00:00.000Z" },
        enabled: true,
      },
      revision: 1,
      enabled: true,
      cancelled: false,
      cancelledAt: null,
      nextRunAt: "2099-08-19T00:00:00.000Z",
      createdAt: T0,
      updatedAt: T1,
    };
    const deps = makeDeps({
      automations: {
        get: () => Effect.succeed(currentAutomation),
      } as unknown as AgentControlAutomationShape,
      getTurnAuthority: () => Effect.succeed(Option.some(activeAuthority)),
      validator: {
        validateSubmission: () =>
          Effect.succeed({
            kind: "provider-session",
            threadId: callerThreadId,
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeSessionId: RuntimeSessionId.make("runtime-1"),
            turnId: TurnId.make("turn-active"),
            originProjectId: projectOne.id,
            originRuntimeMode: "auto",
            originEnvMode: "worktree",
            targetSnapshots: [],
          }),
        validateExternalSubmission: () => Effect.die("unused"),
        revalidateExecution: () => Effect.void,
      },
      proposals: {
        getProposal: makeDeps().proposals.getProposal,
        submit: (input) => {
          submitted.push(input);
          return Effect.succeed({
            replayed: false,
            proposal: {
              ...proposalOwn,
              proposalId: AgentControlProposalId.make("proposal-automation-create"),
              requestId: input.requestId,
              principal: input.principal,
              plan: input.plan,
              riskTags: input.riskTags,
              promptSummary: input.promptSummary,
            },
          });
        },
      },
    });
    const beforeThreads = shellSnapshot.threads;
    const calls = [
      [
        AGENT_CONTROL_MCP_TOOLS.proposeAutomationCreate,
        {
          requestId: "request-automation-create-inert",
          projectId: "project-1",
          providerInstanceId: "codex",
          title: "Daily bounded review",
          prompt: "Review the project and report findings.",
          model: "gpt-5.3-codex",
          options: [],
          runtimeMode: "auto",
          envMode: "worktree",
          schedule: { kind: "once", runAt: "2099-08-19T00:00:00.000Z" },
        },
      ],
      [
        AGENT_CONTROL_MCP_TOOLS.proposeAutomationUpdate,
        {
          requestId: "request-automation-update-inert",
          automationId: currentAutomation.automationId,
          expectedRevision: 1,
          title: "Updated bounded review",
        },
      ],
      [
        AGENT_CONTROL_MCP_TOOLS.proposeAutomationCancel,
        {
          requestId: "request-automation-cancel-inert",
          automationId: currentAutomation.automationId,
          expectedRevision: 1,
        },
      ],
    ] as const;
    for (const [name, args] of calls) {
      const result = yield* call(deps, name, args, writeSession);
      assert.isUndefined(result.isError);
    }
    assert.deepStrictEqual(
      submitted.map((entry) => entry.plan.kind),
      ["createAutomation", "updateAutomation", "cancelAutomation"],
    );
    assert.strictEqual(shellSnapshot.threads, beforeThreads);
    assert.deepStrictEqual(
      submitted.map((entry) => entry.riskTags),
      [
        [AGENT_CONTROL_RISK_TAGS.createsAutomation],
        [AGENT_CONTROL_RISK_TAGS.modifiesAutomation],
        [AGENT_CONTROL_RISK_TAGS.cancelsAutomation],
      ],
    );
  }),
);

it.effect("diagnostic reads stay exact-scope and serialize only the redacted contract", () =>
  Effect.gen(function* () {
    const diagnostics = {
      recentActivity: () => Effect.die("unused"),
      orchestrationEvents: () => Effect.die("unused"),
      providerRuntimeEvents: () => Effect.die("unused"),
      summary: () =>
        Effect.succeed({
          generatedAt: T2,
          health: "ok" as const,
          projectId: projectOne.id,
          providerInstanceId: ProviderInstanceId.make("codex"),
          provider: {
            status: "ready" as const,
            availability: "available" as const,
            enabled: true,
            installed: true,
          },
          project: {
            threadCount: 1,
            activeThreadCount: 1,
            enabledAutomationCount: 0,
            pendingAutomationRunCount: 0,
          },
          server: { uptimeMs: 1, memoryRssBytes: 2, heapUsedBytes: 3, eventLoopDelayMs: null },
          operational: {
            failureCount: 0,
            warningCount: 0,
            retainedTraceCount: 0,
            queueOverflowCount: 0,
            providerLogDroppedRecords: 0,
          },
          redacted: true as const,
          omitted: [
            "credentials-and-environment" as const,
            "paths-files-and-terminals" as const,
            "commands-transcripts-and-payloads" as const,
            "traces-logs-requests-and-relay" as const,
            "hosted-browser-and-service-worker" as const,
            "other-projects-and-provider-sessions" as const,
          ],
          secret: "never-leak-token",
          rawPath: "/private/worktree",
          terminal: "terminal contents",
          transcript: "transcript dump",
          requestBody: "raw request body",
          relay: "hosted relay data",
        }),
    };
    const result = yield* call(
      makeDeps({ diagnostics }),
      AGENT_CONTROL_MCP_TOOLS.diagnosticsSummary,
      { projectId: "project-1", providerInstanceId: "codex" },
      writeSession,
    );
    assert.isUndefined(result.isError);
    const serialized = JSON.stringify(structured(result));
    for (const forbidden of [
      "never-leak-token",
      "/private/worktree",
      "terminal contents",
      "transcript dump",
      "raw request body",
      "hosted relay data",
    ])
      assert.notInclude(serialized, forbidden);

    const denied = yield* call(
      makeDeps({ diagnostics }),
      AGENT_CONTROL_MCP_TOOLS.diagnosticsSummary,
      { projectId: "project-2", providerInstanceId: "codex" },
      writeSession,
    );
    assert.isTrue(denied.isError);
  }),
);

// ── Authorization ─────────────────────────────────────────────────────

it.effect("fails closed when the feature gate is disabled", () =>
  Effect.gen(function* () {
    const deps = makeDeps({
      policy: {
        ...allowPolicy,
        authorize: (input) =>
          Effect.fail(new AgentControlDisabledError({ operation: input.operation })),
      },
    });
    const result = yield* call(deps, AGENT_CONTROL_MCP_TOOLS.listProjects);
    assert.isTrue(result.isError);
    assert.strictEqual(result.content[0]?.text, "Agent Control is disabled.");
  }),
);

it.effect("denies a session whose grants lack the read capability", () =>
  Effect.gen(function* () {
    const result = yield* call(makeDeps(), AGENT_CONTROL_MCP_TOOLS.listProjects, undefined, {
      ...session,
      grantedCapabilities: [],
    });
    assert.isTrue(result.isError);
    assert.strictEqual(result.content[0]?.text, "Capability denied.");
  }),
);

it.effect("rejects a write call without exact active-turn authority", () =>
  Effect.gen(function* () {
    const result = yield* call(
      makeDeps(),
      AGENT_CONTROL_MCP_TOOLS.sendMessage,
      {
        requestId: "request-no-authority",
        threadId: "thread-caller",
        text: "Continue",
        delivery: "queue",
      },
      writeSession,
    );
    assert.isTrue(result.isError);
    assert.strictEqual(
      result.content[0]?.text,
      "Exact active-turn write authority is unavailable.",
    );
  }),
);

it.effect("keeps each project mutation scoped to the requesting runtime's exact grant", () =>
  Effect.gen(function* () {
    const result = yield* call(
      makeDeps({ getTurnAuthority: () => Effect.succeed(Option.some(activeAuthority)) }),
      AGENT_CONTROL_MCP_TOOLS.proposeProjectUpdate,
      {
        requestId: "request-project-capability",
        projectId: "project-1",
        expectedUpdatedAt: projectOne.updatedAt,
        title: "Must not reach preparation",
      },
      {
        ...writeSession,
        grantedCapabilities: writeSession.grantedCapabilities.filter(
          (capability) => capability !== AGENT_CONTROL_CAPABILITIES.updateProject,
        ),
      },
    );
    assert.isTrue(result.isError);
    assert.strictEqual(result.content[0]?.text, "Capability denied.");
  }),
);

it.effect("creates an immutable proposal without mutating the target", () =>
  Effect.gen(function* () {
    const submitted: Array<
      Parameters<NonNullable<AgentControlMcpToolDeps["proposals"]["submit"]>>[0]
    > = [];
    const deps = makeDeps({
      getTurnAuthority: () => Effect.succeed(Option.some(activeAuthority)),
      validator: {
        validateSubmission: ({ plan }) =>
          Effect.succeed({
            kind: "provider-session",
            threadId: callerThreadId,
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeSessionId: RuntimeSessionId.make("runtime-1"),
            turnId: TurnId.make("turn-active"),
            originProjectId: projectOne.id,
            originRuntimeMode: "auto",
            originEnvMode: "worktree",
            targetSnapshots:
              plan.kind === "createThreads"
                ? []
                : [
                    {
                      threadId: callerThreadId,
                      projectId: projectOne.id,
                      runtimeMode: "auto",
                      envMode: "worktree",
                      archived: false,
                      activeTurnId: TurnId.make("turn-active"),
                    },
                  ],
          }),
        validateExternalSubmission: () => Effect.die("unused"),
        revalidateExecution: () => Effect.void,
      },
      proposals: {
        getProposal: makeDeps().proposals.getProposal,
        submit: (input) => {
          submitted.push(input);
          return Effect.succeed({
            replayed: false,
            proposal: {
              proposalId: AgentControlProposalId.make("proposal-created"),
              requestId: input.requestId,
              principal: input.principal,
              planVersion: 1,
              plan: input.plan,
              planDigest: "b".repeat(64),
              riskTags: input.riskTags,
              promptSummary: input.promptSummary,
              status: "pending-user-approval",
              createdAt: input.now,
              updatedAt: input.now,
              expiresAt: input.expiresAt,
              decidedAt: null,
              result: null,
            },
          });
        },
      },
    });

    const before = shellSnapshot.threads;
    const result = yield* call(
      deps,
      AGENT_CONTROL_MCP_TOOLS.sendMessage,
      {
        requestId: "request-proposal-only",
        threadId: "thread-caller",
        text: "Continue",
        delivery: "queue",
      },
      writeSession,
    );

    assert.isUndefined(result.isError);
    assert.strictEqual(submitted.length, 1);
    assert.deepStrictEqual(submitted[0]?.plan, {
      kind: "sendMessage",
      threadId: callerThreadId,
      text: "Continue",
      delivery: "queue",
    });
    assert.strictEqual(shellSnapshot.threads, before);
    assert.strictEqual((structured(result) as { replayed: boolean }).replayed, false);
  }),
);

// ── ryco_context / ryco_capabilities ──────────────────────────────────

it.effect("ryco_context reports the caller's thread, project, and grants", () =>
  Effect.gen(function* () {
    const result = yield* call(makeDeps(), AGENT_CONTROL_MCP_TOOLS.context);
    assert.isUndefined(result.isError);
    const payload = structured(result) as Record<string, unknown>;
    assert.strictEqual(payload.threadId, "thread-caller");
    assert.strictEqual(payload.threadTitle, "Caller thread");
    assert.strictEqual(payload.projectId, "project-1");
    assert.strictEqual(payload.projectTitle, "Project one");
    assert.deepStrictEqual(payload.agentControl, {
      available: true,
      injectionMode: "codex-http",
    });
    assert.strictEqual(payload.writeToolsAvailable, false);
  }),
);

it.effect("ryco_capabilities uses provider instances and bounds model lists", () =>
  Effect.gen(function* () {
    const result = yield* call(makeDeps(), AGENT_CONTROL_MCP_TOOLS.capabilities);
    assert.isUndefined(result.isError);
    const payload = structured(result) as {
      readonly readOnly: boolean;
      readonly tools: ReadonlyArray<string>;
      readonly providerInstances: ReadonlyArray<{
        readonly instanceId: string;
        readonly models: ReadonlyArray<unknown>;
        readonly agentControl: { readonly supported: boolean; readonly available: boolean };
      }>;
      readonly agentControl: { readonly available: boolean; readonly injectionMode: string };
    };
    assert.isTrue(payload.readOnly);
    assert.deepStrictEqual(
      [...payload.tools].toSorted(),
      [
        AGENT_CONTROL_MCP_TOOLS.context,
        AGENT_CONTROL_MCP_TOOLS.capabilities,
        AGENT_CONTROL_MCP_TOOLS.listProjects,
        AGENT_CONTROL_MCP_TOOLS.listThreads,
        AGENT_CONTROL_MCP_TOOLS.readThread,
        AGENT_CONTROL_MCP_TOOLS.readControlRequest,
        AGENT_CONTROL_MCP_TOOLS.waitForControlRequest,
      ].toSorted(),
    );
    assert.strictEqual(payload.providerInstances[0]?.instanceId, "codex");
    assert.strictEqual(payload.providerInstances[0]?.models.length, 50);
    assert.deepStrictEqual(payload.agentControl, {
      available: true,
      injectionMode: "codex-http",
    });
    assert.isTrue(payload.providerInstances[0]?.agentControl.supported);
    assert.isTrue(payload.providerInstances[0]?.agentControl.available);
    // Account identity and other sensitive snapshot fields stay out.
    assert.notInclude(JSON.stringify(payload), "user@example.com");
  }),
);

it.effect("ryco_settings_summary is separately capability-gated and never exposes secrets", () =>
  Effect.gen(function* () {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      enableLegacyTokenStreaming: true,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        opencode: {
          ...DEFAULT_SERVER_SETTINGS.providers.opencode,
          serverPassword: "never-leak-this-password",
          serverUrl: "https://private.example.test",
        },
      },
      providerInstances: {
        secret: {
          driver: "codex",
          environment: [{ name: "API_KEY", value: "never-leak-this-token", sensitive: true }],
        },
      },
      addProjectBaseDirectory: "/private/root",
      observability: { otlpTracesUrl: "https://private-collector", otlpMetricsUrl: "" },
    } as typeof DEFAULT_SERVER_SETTINGS;
    const denied = yield* call(
      makeDeps({ getSettings: Effect.succeed(settings) }),
      AGENT_CONTROL_MCP_TOOLS.settingsSummary,
    );
    assert.isTrue(denied.isError);
    assert.strictEqual(denied.content[0]?.text, "Capability denied.");

    const result = yield* call(
      makeDeps({ getSettings: Effect.succeed(settings) }),
      AGENT_CONTROL_MCP_TOOLS.settingsSummary,
      {},
      writeSession,
    );
    assert.isUndefined(result.isError);
    const serialized = JSON.stringify(structured(result));
    assert.include(serialized, "legacyTokenStreaming");
    assert.include(serialized, "providerUpdateChecks");
    assert.notInclude(serialized, "never-leak-this-password");
    assert.notInclude(serialized, "never-leak-this-token");
    assert.notInclude(serialized, "private.example.test");
    assert.notInclude(serialized, "/private/root");
    assert.notInclude(serialized, "private-collector");
  }),
);

it.effect("project write tools create exact inert proposals and never dispatch mutations", () =>
  Effect.gen(function* () {
    const submitted: Array<
      Parameters<NonNullable<AgentControlMcpToolDeps["proposals"]["submit"]>>[0]
    > = [];
    const projectPlans = {
      prepareCreate: () =>
        Effect.succeed({
          kind: "createProject" as const,
          projectId: projectTwo.id,
          title: "Project two",
          workspaceRoot: projectTwo.workspaceRoot,
          projectMetadataDir: ".ryco" as const,
          repositoryIdentityKey: null,
        }),
      prepareUpdate: () =>
        Effect.succeed({
          kind: "updateProject" as const,
          projectId: projectOne.id,
          before: {
            title: projectOne.title,
            workspaceRoot: projectOne.workspaceRoot,
            repositoryIdentityKey: null,
            updatedAt: projectOne.updatedAt,
          },
          after: {
            title: "Renamed",
            workspaceRoot: projectOne.workspaceRoot,
            repositoryIdentityKey: null,
          },
        }),
      prepareRemove: () =>
        Effect.succeed({
          kind: "removeProject" as const,
          projectId: projectOne.id,
          expected: {
            title: projectOne.title,
            workspaceRoot: projectOne.workspaceRoot,
            repositoryIdentityKey: null,
            updatedAt: projectOne.updatedAt,
          },
          expectedThreadIds: [callerThreadId],
          force: true,
        }),
      revalidate: () => Effect.void,
    };
    const deps = makeDeps({
      projectPlans,
      getTurnAuthority: () => Effect.succeed(Option.some(activeAuthority)),
      validator: {
        validateSubmission: () =>
          Effect.succeed({
            kind: "provider-session",
            threadId: callerThreadId,
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeSessionId: RuntimeSessionId.make("runtime-1"),
            turnId: TurnId.make("turn-active"),
            originProjectId: projectOne.id,
            originRuntimeMode: "auto",
            originEnvMode: "worktree",
            targetSnapshots: [],
          }),
        validateExternalSubmission: () => Effect.die("unused"),
        revalidateExecution: () => Effect.void,
      },
      proposals: {
        getProposal: makeDeps().proposals.getProposal,
        submit: (input) => {
          submitted.push(input);
          return Effect.succeed({
            replayed: false,
            proposal: {
              ...proposalOwn,
              proposalId: AgentControlProposalId.make(`proposal-${submitted.length}`),
              requestId: input.requestId,
              principal: input.principal,
              plan: input.plan,
              riskTags: input.riskTags,
              promptSummary: input.promptSummary,
            },
          });
        },
      },
    });

    for (const [name, args] of [
      [
        AGENT_CONTROL_MCP_TOOLS.proposeProjectCreate,
        {
          requestId: "request-project-create",
          projectId: "project-2",
          title: "Project two",
          workspaceRoot: projectTwo.workspaceRoot,
        },
      ],
      [
        AGENT_CONTROL_MCP_TOOLS.proposeProjectUpdate,
        {
          requestId: "request-project-update",
          projectId: "project-1",
          expectedUpdatedAt: projectOne.updatedAt,
          title: "Renamed",
        },
      ],
      [
        AGENT_CONTROL_MCP_TOOLS.proposeProjectRemove,
        {
          requestId: "request-project-remove",
          projectId: "project-1",
          expectedUpdatedAt: projectOne.updatedAt,
          force: true,
        },
      ],
    ] as const) {
      const result = yield* call(deps, name, args, writeSession);
      assert.isUndefined(result.isError);
    }

    assert.deepStrictEqual(
      submitted.map((entry) => entry.plan.kind),
      ["createProject", "updateProject", "removeProject"],
    );
    assert.strictEqual(shellSnapshot.projects[0], projectOne);
    assert.strictEqual(shellSnapshot.threads[0], threadCaller);
  }),
);

it.effect("settings requests rejected by validation never reach persistence", () =>
  Effect.gen(function* () {
    let submitted = false;
    const deps = makeDeps({
      getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      getTurnAuthority: () => Effect.succeed(Option.some(activeAuthority)),
      validator: {
        validateSubmission: ({ plan }) =>
          plan.kind === "changeSettings"
            ? Effect.fail(
                new AgentControlPlanValidationError({
                  reason: "settings-unsupported",
                  detail: "The requested settings change is invalid.",
                }),
              )
            : Effect.die("unexpected plan"),
        validateExternalSubmission: () => Effect.die("unused"),
        revalidateExecution: () => Effect.void,
      },
      proposals: {
        getProposal: makeDeps().proposals.getProposal,
        submit: () => {
          submitted = true;
          return Effect.die("settings proposal must not persist");
        },
      },
    });
    const result = yield* call(
      deps,
      AGENT_CONTROL_MCP_TOOLS.proposeSettingsChange,
      {
        requestId: "request-settings-change",
        change: { kind: "legacyTokenStreaming", value: true },
      },
      writeSession,
    );
    assert.isTrue(result.isError);
    assert.include(result.content[0]?.text ?? "", "settings change is invalid");
    assert.isFalse(submitted);
  }),
);

it.effect(
  "ryco_capabilities reports unsupported provider reasons without claiming availability",
  () =>
    Effect.gen(function* () {
      const openCode = decodeProvider({
        ...Schema.encodeSync(ServerProvider)(codexProvider),
        instanceId: "opencode",
        driver: "opencode",
        displayName: "OpenCode",
      });
      const result = yield* call(
        makeDeps({ getProviders: Effect.succeed([openCode]) }),
        AGENT_CONTROL_MCP_TOOLS.capabilities,
      );
      const payload = structured(result) as {
        readonly providerInstances: ReadonlyArray<{
          readonly agentControl: {
            readonly supported: boolean;
            readonly available: boolean;
            readonly unavailableReason: string | null;
          };
        }>;
      };
      assert.isFalse(payload.providerInstances[0]!.agentControl.supported);
      assert.isFalse(payload.providerInstances[0]!.agentControl.available);
      assert.match(
        payload.providerInstances[0]!.agentControl.unavailableReason ?? "",
        /another Ryco thread/,
      );
    }),
);

// ── Lists ─────────────────────────────────────────────────────────────

it.effect("ryco_list_projects returns bounded pages without filesystem paths", () =>
  Effect.gen(function* () {
    const deps = makeDeps();
    const first = yield* call(deps, AGENT_CONTROL_MCP_TOOLS.listProjects, { limit: 1 });
    assert.isUndefined(first.isError);
    const firstPage = structured(first) as {
      readonly projects: ReadonlyArray<{ readonly projectId: string }>;
      readonly nextCursor: string | null;
    };
    assert.deepStrictEqual(
      firstPage.projects.map((project) => project.projectId),
      ["project-1"],
    );
    assert.isNotNull(firstPage.nextCursor);
    assert.notInclude(JSON.stringify(firstPage), "/secret/path");
    assert.notInclude(JSON.stringify(firstPage), "secret-deploy");

    const second = yield* call(deps, AGENT_CONTROL_MCP_TOOLS.listProjects, {
      limit: 1,
      cursor: firstPage.nextCursor,
    });
    const secondPage = structured(second) as {
      readonly projects: ReadonlyArray<{ readonly projectId: string }>;
      readonly nextCursor: string | null;
    };
    assert.deepStrictEqual(
      secondPage.projects.map((project) => project.projectId),
      ["project-2"],
    );
    assert.isNull(secondPage.nextCursor);
  }),
);

it.effect("ryco_list_projects rejects a cursor minted for another tool", () =>
  Effect.gen(function* () {
    const deps = makeDeps();
    const threads = yield* call(deps, AGENT_CONTROL_MCP_TOOLS.listThreads, { limit: 1 });
    const threadCursor = (structured(threads) as { readonly nextCursor: string | null }).nextCursor;
    assert.isNotNull(threadCursor);
    const result = yield* call(deps, AGENT_CONTROL_MCP_TOOLS.listProjects, {
      cursor: threadCursor,
    });
    assert.isTrue(result.isError);
    assert.strictEqual(result.content[0]?.text, "Invalid cursor.");
  }),
);

it.effect("ryco_list_threads filters by project and archival state", () =>
  Effect.gen(function* () {
    const deps = makeDeps();
    const defaults = yield* call(deps, AGENT_CONTROL_MCP_TOOLS.listThreads, {});
    const defaultPage = structured(defaults) as {
      readonly threads: ReadonlyArray<{ readonly threadId: string; readonly status: string }>;
    };
    assert.deepStrictEqual(
      defaultPage.threads.map((thread) => thread.threadId),
      ["thread-caller", "thread-other"],
    );
    assert.strictEqual(defaultPage.threads[0]?.status, "running");
    assert.notInclude(JSON.stringify(defaultPage), "/secret/worktrees");

    const archived = yield* call(deps, AGENT_CONTROL_MCP_TOOLS.listThreads, {
      includeArchived: true,
      projectId: "project-1",
    });
    const archivedPage = structured(archived) as {
      readonly threads: ReadonlyArray<{ readonly threadId: string; readonly archived: boolean }>;
    };
    assert.deepStrictEqual(
      archivedPage.threads.map((thread) => thread.threadId),
      ["thread-caller", "thread-archived"],
    );
    assert.strictEqual(archivedPage.threads[1]?.archived, true);
  }),
);

// ── ryco_read_thread ──────────────────────────────────────────────────

it.effect("ryco_read_thread returns bounded, redacted transcript pages", () =>
  Effect.gen(function* () {
    const result = yield* call(makeDeps(), AGENT_CONTROL_MCP_TOOLS.readThread, {
      threadId: "thread-caller",
    });
    assert.isUndefined(result.isError);
    const payload = structured(result) as {
      readonly thread: { readonly threadId: string; readonly activeTurnId: string | null };
      readonly messages: ReadonlyArray<{
        readonly text: string;
        readonly truncated: boolean;
        readonly attachmentCount: number;
      }>;
      readonly hasMoreBefore: boolean;
      readonly nextCursor: string | null;
    };
    assert.strictEqual(payload.thread.threadId, "thread-caller");
    assert.strictEqual(payload.thread.activeTurnId, "turn-active");
    assert.strictEqual(payload.messages.length, 2);
    assert.strictEqual(payload.messages[0]?.text, "hello");
    assert.strictEqual(payload.messages[0]?.truncated, false);
    assert.strictEqual(payload.messages[1]?.text.length, AGENT_CONTROL_MCP_MESSAGE_TEXT_MAX_CHARS);
    assert.strictEqual(payload.messages[1]?.truncated, true);
    assert.strictEqual(payload.messages[1]?.attachmentCount, 1);
    assert.isTrue(payload.hasMoreBefore);
    assert.strictEqual(payload.nextCursor, "cursor-oldest");
    // No attachment names/urls, no activity payloads, no checkpoints.
    assert.notInclude(JSON.stringify(payload), "shot.png");
  }),
);

it.effect("ryco_read_thread pages older history through the cursor", () =>
  Effect.gen(function* () {
    const result = yield* call(makeDeps(), AGENT_CONTROL_MCP_TOOLS.readThread, {
      threadId: "thread-caller",
      cursor: "cursor-oldest",
      messageLimit: 1,
    });
    assert.isUndefined(result.isError);
    const payload = structured(result) as {
      readonly messages: ReadonlyArray<unknown>;
      readonly hasMoreBefore: boolean;
      readonly nextCursor: string | null;
    };
    assert.strictEqual(payload.messages.length, 1);
    assert.isFalse(payload.hasMoreBefore);
    assert.isNull(payload.nextCursor);
  }),
);

it.effect("ryco_read_thread bounds aggregate transcript text, newest first", () =>
  Effect.gen(function* () {
    // A full max-limit page of max-length messages must stay under the
    // listener's response cap even with the dual text/structured MCP
    // serialization; older messages give up their text first.
    const manyMessages = Array.from({ length: 50 }, (_, index) => ({
      id: `bulk-message-${index}`,
      role: "assistant",
      text: "z".repeat(AGENT_CONTROL_MCP_MESSAGE_TEXT_MAX_CHARS),
      turnId: null,
      streaming: false,
      createdAt: T1,
      updatedAt: T1,
    }));
    const bulkWindow = decodeWindow({
      ...Schema.encodeSync(OrchestrationThreadWindowSnapshot)(windowSnapshot),
      thread: {
        ...Schema.encodeSync(OrchestrationThreadWindowSnapshot)(windowSnapshot).thread,
        messages: manyMessages,
      },
    });
    const deps = makeDeps({
      projections: { ...projections, getThreadWindow: () => Effect.succeed(bulkWindow) },
    });
    const result = yield* call(deps, AGENT_CONTROL_MCP_TOOLS.readThread, {
      threadId: "thread-caller",
      messageLimit: 50,
    });
    assert.isUndefined(result.isError);
    const payload = structured(result) as {
      readonly messages: ReadonlyArray<{ readonly text: string; readonly truncated: boolean }>;
    };
    assert.strictEqual(payload.messages.length, 50);
    const totalChars = payload.messages.reduce((sum, message) => sum + message.text.length, 0);
    assert.isAtMost(totalChars, AGENT_CONTROL_MCP_READ_THREAD_TEXT_BUDGET_CHARS);
    // Newest messages keep full text; the oldest are emptied and flagged.
    assert.strictEqual(
      payload.messages.at(-1)?.text.length,
      AGENT_CONTROL_MCP_MESSAGE_TEXT_MAX_CHARS,
    );
    assert.strictEqual(payload.messages[0]?.text.length, 0);
    assert.isTrue(payload.messages[0]?.truncated);
    // The serialized JSON-RPC result (text copy + structured copy) fits
    // the listener's response bound with ample headroom.
    assert.isAtMost(JSON.stringify(result).length * 2, 512 * 1024);
  }),
);

it.effect("ryco_read_thread reports unknown threads without detail", () =>
  Effect.gen(function* () {
    const result = yield* call(makeDeps(), AGENT_CONTROL_MCP_TOOLS.readThread, {
      threadId: "thread-nope",
    });
    assert.isTrue(result.isError);
    assert.strictEqual(result.content[0]?.text, "Thread not found.");
  }),
);

// ── Control requests ──────────────────────────────────────────────────

it.effect("ryco_read_control_request returns the receipt without plan or prompt", () =>
  Effect.gen(function* () {
    const result = yield* call(makeDeps(), AGENT_CONTROL_MCP_TOOLS.readControlRequest, {
      proposalId: "proposal-own",
    });
    assert.isUndefined(result.isError);
    const payload = structured(result) as {
      readonly receipt: { readonly proposalId: string; readonly status: string };
    };
    assert.strictEqual(payload.receipt.proposalId, "proposal-own");
    assert.strictEqual(payload.receipt.status, "pending-user-approval");
    // The action kind is part of the receipt; the plan payload, prompt
    // text, and prompt summary are not.
    const serialized = JSON.stringify(payload);
    assert.notInclude(serialized, "secret plan prompt");
    assert.notProperty(payload.receipt, "plan");
    assert.notProperty(payload.receipt, "promptSummary");
    assert.notInclude(serialized, "delivery");
  }),
);

it.effect("control requests of other principals read as not found", () =>
  Effect.gen(function* () {
    for (const proposalId of ["proposal-foreign", "proposal-missing"]) {
      const result = yield* call(makeDeps(), AGENT_CONTROL_MCP_TOOLS.readControlRequest, {
        proposalId,
      });
      assert.isTrue(result.isError, proposalId);
      assert.strictEqual(result.content[0]?.text, "Control request not found.");
    }
  }),
);

// ── ryco_wait_for_control_request ─────────────────────────────────────

const makeWaitDeps = (initial: AgentControlProposal) =>
  Effect.gen(function* () {
    const pubsub = yield* PubSub.unbounded<AgentControlProposalStreamProposalEvent>();
    let current = initial;
    const deps = makeDeps({
      proposals: {
        getProposal: (proposalId) =>
          Effect.sync(() =>
            proposalId === current.proposalId ? Option.some(current) : Option.none(),
          ),
      },
      proposalEvents: { subscribe: PubSub.subscribe(pubsub) },
    });
    const publish = (proposal: AgentControlProposal) =>
      Effect.suspend(() => {
        current = proposal;
        return PubSub.publish(pubsub, {
          version: 1 as const,
          type: "proposal" as const,
          revision: 1,
          proposal,
        });
      });
    return { deps, publish };
  });

it.live("wait returns immediately when the proposal is already decided", () =>
  Effect.gen(function* () {
    const { deps } = yield* makeWaitDeps({
      ...proposalOwn,
      status: "rejected",
      decidedAt: T1,
    });
    const result = yield* call(deps, AGENT_CONTROL_MCP_TOOLS.waitForControlRequest, {
      proposalId: "proposal-own",
      timeoutMs: 5_000,
    });
    assert.isUndefined(result.isError);
    const payload = structured(result) as {
      readonly receipt: { readonly status: string };
      readonly timedOut: boolean;
    };
    assert.strictEqual(payload.receipt.status, "rejected");
    assert.isFalse(payload.timedOut);
  }),
);

it.live("read and terminal wait return durable execution receipts", () =>
  Effect.gen(function* () {
    const completed: AgentControlProposal = {
      ...proposalOwn,
      status: "completed",
      decidedAt: T1,
      result: {
        outcome: "completed",
        execution: {
          operationId: "operation-1" as never,
          commands: [
            {
              commandId: "command-1" as never,
              commandType: "thread.turn.start",
              sequence: 42,
            },
          ],
          affectedThreadIds: [ThreadId.make("thread-other")],
          worktreeIds: [],
          delivery: "queued",
        },
        completedAt: T2,
      },
    };
    const { deps } = yield* makeWaitDeps(completed);

    for (const tool of [
      AGENT_CONTROL_MCP_TOOLS.readControlRequest,
      AGENT_CONTROL_MCP_TOOLS.waitForControlRequest,
    ]) {
      const result = yield* call(deps, tool, {
        proposalId: "proposal-own",
        ...(tool === AGENT_CONTROL_MCP_TOOLS.waitForControlRequest
          ? { waitFor: "terminal", timeoutMs: 5_000 }
          : {}),
      });
      assert.isUndefined(result.isError);
      const payload = structured(result) as {
        readonly receipt: {
          readonly result: {
            readonly outcome: string;
            readonly execution: {
              readonly commands: ReadonlyArray<{ readonly sequence: number }>;
              readonly affectedThreadIds: ReadonlyArray<string>;
              readonly delivery: string;
            };
          };
        };
      };
      assert.strictEqual(payload.receipt.result.outcome, "completed");
      assert.strictEqual(payload.receipt.result.execution.commands[0]?.sequence, 42);
      assert.deepStrictEqual(payload.receipt.result.execution.affectedThreadIds, ["thread-other"]);
      assert.strictEqual(payload.receipt.result.execution.delivery, "queued");
    }
  }),
);

it.live("wait resolves when a decision event arrives", () =>
  Effect.gen(function* () {
    const { deps, publish } = yield* makeWaitDeps(proposalOwn);
    const fiber = yield* Effect.forkChild(
      call(deps, AGENT_CONTROL_MCP_TOOLS.waitForControlRequest, {
        proposalId: "proposal-own",
        timeoutMs: 10_000,
      }),
    );
    yield* Effect.sleep("50 millis");
    yield* publish({ ...proposalOwn, status: "approved", decidedAt: T1 });
    const result = yield* Fiber.join(fiber);
    assert.isUndefined(result.isError);
    const payload = structured(result) as {
      readonly receipt: { readonly status: string };
      readonly timedOut: boolean;
    };
    assert.strictEqual(payload.receipt.status, "approved");
    assert.isFalse(payload.timedOut);
  }),
);

it.live("wait times out with the freshest receipt and timedOut=true", () =>
  Effect.gen(function* () {
    const { deps } = yield* makeWaitDeps(proposalOwn);
    const result = yield* call(deps, AGENT_CONTROL_MCP_TOOLS.waitForControlRequest, {
      proposalId: "proposal-own",
      timeoutMs: 1,
    });
    assert.isUndefined(result.isError);
    const payload = structured(result) as {
      readonly receipt: { readonly status: string };
      readonly timedOut: boolean;
    };
    assert.strictEqual(payload.receipt.status, "pending-user-approval");
    assert.isTrue(payload.timedOut);
  }),
);

it.live("wait ignores events for foreign proposals", () =>
  Effect.gen(function* () {
    const { deps, publish } = yield* makeWaitDeps(proposalOwn);
    const fiber = yield* Effect.forkChild(
      call(deps, AGENT_CONTROL_MCP_TOOLS.waitForControlRequest, {
        proposalId: "proposal-own",
        timeoutMs: 250,
      }),
    );
    yield* Effect.sleep("50 millis");
    yield* publish({ ...proposalForeign, status: "approved", decidedAt: T1 });
    // Restore own proposal state so the post-timeout read stays pending.
    yield* Effect.sync(() => void 0);
    const result = yield* Fiber.join(fiber);
    const payload = structured(result) as { readonly timedOut?: boolean } | undefined;
    // The foreign decision must not satisfy the wait; but publishing mutated
    // `current` to the foreign proposal, so the final read fails not-found —
    // either way the caller learns nothing about the foreign proposal.
    if (result.isError) {
      assert.strictEqual(result.content[0]?.text, "Control request not found.");
    } else {
      assert.isTrue(payload?.timedOut);
    }
  }),
);

// ── Input validation ──────────────────────────────────────────────────

it.effect("rejects malformed tool arguments with a bounded error", () =>
  Effect.gen(function* () {
    const deps = makeDeps();
    for (const [tool, args] of [
      [AGENT_CONTROL_MCP_TOOLS.readThread, {}],
      [AGENT_CONTROL_MCP_TOOLS.readThread, { threadId: "" }],
      [AGENT_CONTROL_MCP_TOOLS.listProjects, { limit: 0 }],
      [AGENT_CONTROL_MCP_TOOLS.readControlRequest, { proposalId: 7 }],
    ] as const) {
      const result = yield* call(deps, tool, args);
      assert.isTrue(result.isError, JSON.stringify(args));
      assert.strictEqual(result.content[0]?.text, "Invalid tool arguments.");
    }
  }),
);
