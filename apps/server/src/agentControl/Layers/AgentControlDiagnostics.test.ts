import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type AgentControlAutomation,
} from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { Diagnostics, type DiagnosticsShape } from "../../diagnostics/Services/Diagnostics.ts";
import {
  LocalDiagnosticsMetrics,
  type LocalDiagnosticsMetricsShape,
} from "../../observability/Services/LocalDiagnosticsMetrics.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ProviderRegistry,
  type ProviderRegistryShape,
} from "../../provider/Services/ProviderRegistry.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import {
  AgentControlAutomationService,
  type AgentControlAutomationShape,
} from "../Services/AgentControlAutomation.ts";
import { AgentControlDiagnosticsService } from "../Services/AgentControlDiagnostics.ts";
import { AgentControlDiagnosticsServiceLive } from "./AgentControlDiagnostics.ts";

const projectId = ProjectId.make("project-diagnostics");
const otherProjectId = ProjectId.make("project-diagnostics-other");
const providerInstanceId = ProviderInstanceId.make("provider-diagnostics");
const threadId = ThreadId.make("thread-diagnostics");
const occurredAt = new Date().toISOString();
const forbidden = [
  "never-leak-secret",
  "/private/worktree",
  "terminal contents",
  "transcript dump",
  "raw request body",
  "hosted relay data",
];

const shell = {
  snapshotSequence: 1,
  projects: [
    {
      id: projectId,
      title: "Diagnostics project",
      workspaceRoot: "/private/worktree",
      createdAt: occurredAt,
      updatedAt: occurredAt,
    },
  ],
  threads: [
    {
      id: threadId,
      projectId,
      title: "Diagnostics thread",
      modelSelection: { instanceId: providerInstanceId, model: "test-model" },
      updatedAt: occurredAt,
      session: null,
    },
  ],
  worktrees: [],
  updatedAt: occurredAt,
};

const activities = Array.from({ length: 60 }, (_, index) => ({
  id: `activity-${index}`,
  kind: `safe-kind-${index}`,
  tone: "info" as const,
  turnId: null,
  createdAt: occurredAt,
  summary: `never-leak-secret transcript dump ${index}`,
}));

const projections = {
  getShellSnapshot: () => Effect.succeed(shell),
  getThreadWindow: () =>
    Effect.succeed({
      thread: { id: threadId, activities },
    }),
} as unknown as ProjectionSnapshotQueryShape;

const orchestration = {
  readRecentEvents: () =>
    Effect.succeed(
      Array.from({ length: 60 }, (_, index) => ({
        sequence: index + 1,
        eventId: `event-${index}`,
        type: "project.updated",
        aggregateKind: "project" as const,
        aggregateId: projectId,
        occurredAt,
        commandId: null,
        providerAttributed: false,
      })),
    ),
} as unknown as OrchestrationEngineShape;

const providerService = {
  readRecentEventSummaries: () =>
    Effect.succeed(
      Array.from({ length: 51 }, (_, index) => ({
        eventId: `provider-event-${index}`,
        type: "item.delta",
        threadId,
        providerInstanceId,
        turnId: null,
        occurredAt,
        secret: "never-leak-secret",
      })),
    ),
} as unknown as ProviderServiceShape;

const providerRegistry = {
  getProviders: Effect.succeed([
    {
      instanceId: providerInstanceId,
      driver: "codex",
      enabled: true,
      installed: true,
      status: "ready",
      availability: "available",
    },
  ]),
} as unknown as ProviderRegistryShape;

const automations = {
  list: () => Effect.succeed<ReadonlyArray<AgentControlAutomation>>([]),
  listRuns: () => Effect.succeed([]),
} as unknown as AgentControlAutomationShape;

const diagnostics = {
  getSnapshot: () =>
    Effect.succeed({
      generatedAt: occurredAt,
      uptimeMs: 100,
      resources: {
        current: {
          memory: { rssBytes: 200, heapUsedBytes: 100 },
          eventLoopDelayMs: 1,
        },
      },
      failures: { latest: [] },
      warnings: [],
      tracing: { retainedSpanCount: 0, rawTrace: "never-leak-secret" },
      performance: {
        queues: { liveBufferOverflowCount: 0, providerLogDroppedRecords: 0 },
      },
      environment: { token: "never-leak-secret" },
      terminals: ["terminal contents"],
      transcript: "transcript dump",
      requestBody: "raw request body",
      relay: "hosted relay data",
    }),
} as unknown as DiagnosticsShape;

const localMetrics = {
  snapshot: Effect.succeed({
    turnQuiescenceAvgMs: null,
    checkpointDurationP95Ms: null,
    latestThreadSnapshotDurationMs: null,
    threadSnapshotDurationP95Ms: null,
    wsReconnectCount: 0,
    windowSampleCounts: { turnQuiescence: 0, checkpointDuration: 0, threadSnapshotDuration: 0 },
    capturedAt: occurredAt,
  }),
} as unknown as LocalDiagnosticsMetricsShape;

const layer = it.layer(
  AgentControlDiagnosticsServiceLive.pipe(
    Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery, projections)),
    Layer.provideMerge(Layer.succeed(OrchestrationEngineService, orchestration)),
    Layer.provideMerge(Layer.succeed(ProviderService, providerService)),
    Layer.provideMerge(Layer.succeed(ProviderRegistry, providerRegistry)),
    Layer.provideMerge(Layer.succeed(AgentControlAutomationService, automations)),
    Layer.provideMerge(Layer.succeed(Diagnostics, diagnostics)),
    Layer.provideMerge(Layer.succeed(LocalDiagnosticsMetrics, localMetrics)),
  ),
);

layer("AgentControlDiagnosticsService", (it) => {
  it.effect("bounds operational reads to exact scope and strips privileged payloads", () =>
    Effect.gen(function* () {
      const service = yield* AgentControlDiagnosticsService;
      const scope = { projectId, providerInstanceId };
      const input = {
        projectId,
        providerInstanceId,
        since: "2000-01-01T00:00:00.000Z",
        limit: 999,
      } as const;

      const activity = yield* service.recentActivity(scope, input);
      const events = yield* service.orchestrationEvents(scope, input);
      const runtime = yield* service.providerRuntimeEvents(scope, input);
      const summary = yield* service.summary(scope);

      assert.strictEqual(activity.activity.length, 50);
      assert.strictEqual(events.events.length, 50);
      assert.strictEqual(runtime.events.length, 50);
      assert.strictEqual(activity.coverage.pageLimit, 50);
      assert.strictEqual(events.coverage.pageLimit, 50);
      assert.strictEqual(runtime.coverage.pageLimit, 50);
      assert.isTrue(summary.redacted);

      const serialized = JSON.stringify({ activity, events, runtime, summary });
      for (const value of forbidden) assert.notInclude(serialized, value);

      const denied = yield* Effect.flip(
        service.recentActivity(scope, { ...input, projectId: otherProjectId }),
      );
      assert.strictEqual(denied._tag, "AgentControlDiagnosticsReadError");
    }),
  );
});
