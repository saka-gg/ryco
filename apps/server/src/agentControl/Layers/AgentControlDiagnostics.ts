import {
  AGENT_CONTROL_AUTOMATION_RUN_HISTORY_MAX,
  AGENT_CONTROL_MCP_OPERATIONAL_LIMIT_DEFAULT,
  AGENT_CONTROL_MCP_AUTOMATION_LIST_PROMPT_MAX_CHARS,
  AGENT_CONTROL_MCP_OPERATIONAL_LIMIT_MAX,
  AGENT_CONTROL_MCP_OPERATIONAL_RANGE_MAX_MS,
  AGENT_CONTROL_MCP_OPERATIONAL_RETENTION_MS,
  AGENT_CONTROL_MCP_ORCHESTRATION_SCAN_MAX,
  type AgentControlAutomation,
  type AgentControlMcpAutomationSummary,
  type AgentControlMcpOperationalCoverage,
  type AgentControlMcpOperationalReadInput,
  type AgentControlMcpOrchestrationEventSummary,
  type ProjectId,
  type ThreadId,
  type WorktreeId,
} from "@ryco/contracts";
import { Effect, Layer, Metric } from "effect";

import { Diagnostics } from "../../diagnostics/Services/Diagnostics.ts";
import { LocalDiagnosticsMetrics } from "../../observability/Services/LocalDiagnosticsMetrics.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  readScopedShellSnapshot,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { AgentControlAutomationService } from "../Services/AgentControlAutomation.ts";
import { AgentControlDiagnosticsReadError } from "../Errors.ts";
import {
  AgentControlDiagnosticsService,
  type AgentControlDiagnosticsShape,
  type AgentControlDiagnosticsScope,
} from "../Services/AgentControlDiagnostics.ts";

const omitted = [
  "credentials-and-environment",
  "paths-files-and-terminals",
  "commands-transcripts-and-payloads",
  "traces-logs-requests-and-relay",
  "hosted-browser-and-service-worker",
  "other-projects-and-provider-sessions",
] as const;

const readError = (operation: string) => () => new AgentControlDiagnosticsReadError({ operation });

const automationSummary = (
  automation: AgentControlAutomation,
): AgentControlMcpAutomationSummary => {
  const prompt = automation.definition.execution.prompt;
  const promptTruncated = prompt.length > AGENT_CONTROL_MCP_AUTOMATION_LIST_PROMPT_MAX_CHARS;
  return {
    automationId: automation.automationId,
    projectId: automation.projectId,
    providerInstanceId: automation.providerInstanceId,
    execution: {
      ...automation.definition.execution,
      prompt: promptTruncated
        ? prompt.slice(0, AGENT_CONTROL_MCP_AUTOMATION_LIST_PROMPT_MAX_CHARS)
        : prompt,
    },
    promptTruncated,
    schedule: automation.definition.schedule,
    revision: automation.revision,
    enabled: automation.enabled,
    cancelled: automation.cancelled,
    nextRunAt: automation.nextRunAt,
    createdAt: automation.createdAt,
    updatedAt: automation.updatedAt,
  };
};

const bounds = (input: AgentControlMcpOperationalReadInput) => {
  const generatedAtMs = Date.now();
  const retentionStartsAtMs = generatedAtMs - AGENT_CONTROL_MCP_OPERATIONAL_RETENTION_MS;
  const rangeStartsAtMs = generatedAtMs - AGENT_CONTROL_MCP_OPERATIONAL_RANGE_MAX_MS;
  const requestedMs = input.since === undefined ? rangeStartsAtMs : Date.parse(input.since);
  const effectiveSinceMs = Math.max(
    retentionStartsAtMs,
    rangeStartsAtMs,
    Number.isFinite(requestedMs) ? requestedMs : rangeStartsAtMs,
  );
  const pageLimit = Math.min(
    input.limit ?? AGENT_CONTROL_MCP_OPERATIONAL_LIMIT_DEFAULT,
    AGENT_CONTROL_MCP_OPERATIONAL_LIMIT_MAX,
  );
  const coverage = (truncated: boolean): AgentControlMcpOperationalCoverage => ({
    effectiveSince: new Date(effectiveSinceMs).toISOString(),
    retentionStartsAt: new Date(retentionStartsAtMs).toISOString(),
    generatedAt: new Date(generatedAtMs).toISOString(),
    truncated,
    pageLimit,
  });
  return { effectiveSince: new Date(effectiveSinceMs).toISOString(), pageLimit, coverage };
};

const requireScope = (
  scope: AgentControlDiagnosticsScope,
  input: AgentControlMcpOperationalReadInput,
) =>
  input.projectId !== undefined && input.projectId !== scope.projectId
    ? Effect.fail(new Error("Project scope denied."))
    : input.providerInstanceId !== undefined &&
        input.providerInstanceId !== scope.providerInstanceId
      ? Effect.fail(new Error("Provider instance scope denied."))
      : Effect.void;

const makeAgentControlDiagnostics = Effect.gen(function* () {
  const projections = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const providerRegistry = yield* ProviderRegistry;
  const automations = yield* AgentControlAutomationService;
  const diagnostics = yield* Diagnostics;
  const localMetrics = yield* LocalDiagnosticsMetrics;

  // Only the scoped project's summaries: events of other projects' threads and workspaces
  // resolve to no project below and are dropped either way.
  const loadScope = (scope: AgentControlDiagnosticsScope) =>
    readScopedShellSnapshot(projections, { projectIds: [scope.projectId] }).pipe(
      Effect.flatMap((snapshot) => {
        const project = snapshot.projects.find((candidate) => candidate.id === scope.projectId);
        if (!project) return Effect.fail(new Error("Project scope unavailable."));
        const threads = snapshot.threads.filter(
          (thread) =>
            thread.projectId === scope.projectId &&
            thread.modelSelection.instanceId === scope.providerInstanceId,
        );
        return Effect.succeed({ snapshot, project, threads });
      }),
    );

  const recentActivity: AgentControlDiagnosticsShape["recentActivity"] = (scope, input) =>
    Effect.gen(function* () {
      yield* requireScope(scope, input);
      const bounded = bounds(input);
      const { threads } = yield* loadScope(scope);
      const getThreadWindow = projections.getThreadWindow;
      if (getThreadWindow === undefined) {
        return yield* Effect.fail(new Error("Activity history is unavailable."));
      }
      const selectedThreads = threads
        .filter((thread) => input.threadId === undefined || thread.id === input.threadId)
        .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, bounded.pageLimit);
      if (input.threadId !== undefined && selectedThreads.length === 0) {
        return yield* Effect.fail(new Error("Thread scope denied."));
      }
      const windows = yield* Effect.forEach(
        selectedThreads,
        (thread) =>
          getThreadWindow({
            threadId: thread.id,
            limits: {
              messages: 1,
              proposedPlans: 1,
              activities: bounded.pageLimit,
              checkpoints: 1,
            },
          }),
        { concurrency: 4 },
      );
      const activity = windows
        .flatMap((window) =>
          window.thread.activities.map((item) => ({
            activityId: item.id,
            projectId: scope.projectId,
            threadId: window.thread.id,
            kind: item.kind.slice(0, 128),
            tone: item.tone,
            turnId: item.turnId,
            occurredAt: item.createdAt,
          })),
        )
        .filter((item) => item.occurredAt >= bounded.effectiveSince)
        .toSorted((a, b) => b.occurredAt.localeCompare(a.occurredAt));
      const scopedAutomations = yield* automations.list({
        ...scope,
        includeDisabled: true,
        limit: bounded.pageLimit,
      });
      const runs = (yield* Effect.forEach(scopedAutomations, (automation) =>
        automations.listRuns(automation.automationId, {
          ...scope,
          limit: AGENT_CONTROL_AUTOMATION_RUN_HISTORY_MAX,
        }),
      ))
        .flat()
        .filter((run) => run.updatedAt >= bounded.effectiveSince)
        .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return {
        activity: activity.slice(0, bounded.pageLimit),
        automations: scopedAutomations.map(automationSummary),
        runs: runs.slice(0, bounded.pageLimit),
        coverage: bounded.coverage(
          activity.length > bounded.pageLimit || runs.length > bounded.pageLimit,
        ),
      };
    }).pipe(Effect.mapError(readError("recent-activity")));

  const orchestrationEvents: AgentControlDiagnosticsShape["orchestrationEvents"] = (scope, input) =>
    Effect.gen(function* () {
      yield* requireScope(scope, input);
      const bounded = bounds(input);
      const { snapshot, threads } = yield* loadScope(scope);
      const threadProjects = new Map(
        snapshot.threads.map((thread) => [thread.id, thread.projectId]),
      );
      const worktreeProjects = new Map(
        (snapshot.worktrees ?? []).map((worktree) => [worktree.worktreeId, worktree.projectId]),
      );
      const allowedThreads = new Set(threads.map((thread) => thread.id));
      const rows = yield* (
        engine.readRecentEvents?.({
          since: bounded.effectiveSince,
          limit: AGENT_CONTROL_MCP_ORCHESTRATION_SCAN_MAX,
        }) ?? Effect.succeed([])
      );
      const events = rows.flatMap(
        (event): ReadonlyArray<AgentControlMcpOrchestrationEventSummary> => {
          let projectId: ProjectId | undefined;
          let threadId: ThreadId | null = null;
          if (event.aggregateKind === "project") {
            projectId = event.aggregateId as ProjectId;
          } else if (event.aggregateKind === "thread") {
            threadId = event.aggregateId as ThreadId;
            projectId = threadProjects.get(event.aggregateId as ThreadId);
          } else {
            projectId = worktreeProjects.get(event.aggregateId as WorktreeId);
          }
          if (
            projectId !== scope.projectId ||
            (threadId !== null && !allowedThreads.has(threadId)) ||
            (input.threadId !== undefined && threadId !== input.threadId)
          ) {
            return [];
          }
          return [
            {
              sequence: event.sequence,
              eventId: event.eventId,
              type: event.type,
              aggregateKind: event.aggregateKind,
              aggregateId: event.aggregateId,
              projectId: scope.projectId,
              threadId,
              occurredAt: event.occurredAt,
              providerAttributed:
                event.commandId?.startsWith("provider:") === true ||
                event.metadata.providerTurnId !== undefined ||
                event.metadata.providerItemId !== undefined,
            },
          ];
        },
      );
      return {
        events: events.slice(0, bounded.pageLimit),
        coverage: bounded.coverage(
          events.length > bounded.pageLimit ||
            rows.length === AGENT_CONTROL_MCP_ORCHESTRATION_SCAN_MAX,
        ),
      };
    }).pipe(Effect.mapError(readError("orchestration-events")));

  const providerRuntimeEvents: AgentControlDiagnosticsShape["providerRuntimeEvents"] = (
    scope,
    input,
  ) =>
    Effect.gen(function* () {
      yield* requireScope(scope, input);
      const bounded = bounds(input);
      const { threads } = yield* loadScope(scope);
      const allowedThreads = new Set(threads.map((thread) => thread.id));
      if (input.threadId !== undefined && !allowedThreads.has(input.threadId)) {
        return yield* Effect.fail(new Error("Thread scope denied."));
      }
      const rows = yield* (
        providerService.readRecentEventSummaries?.({
          since: bounded.effectiveSince,
          limit: bounded.pageLimit + 1,
          providerInstanceId: scope.providerInstanceId,
          ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
        }) ?? Effect.succeed([])
      );
      const events = rows
        .filter((event) => allowedThreads.has(event.threadId))
        .map((event) => ({
          eventId: event.eventId,
          type: event.type,
          projectId: scope.projectId,
          threadId: event.threadId,
          providerInstanceId: event.providerInstanceId,
          turnId: event.turnId ?? null,
          occurredAt: event.occurredAt,
        }));
      return {
        events: events.slice(0, bounded.pageLimit),
        coverage: bounded.coverage(events.length > bounded.pageLimit),
      };
    }).pipe(Effect.mapError(readError("provider-runtime-events")));

  const summary: AgentControlDiagnosticsShape["summary"] = (scope) =>
    Effect.gen(function* () {
      const [{ threads }, providers, local, metricSnapshots] = yield* Effect.all([
        loadScope(scope),
        providerRegistry.getProviders,
        localMetrics.snapshot,
        Metric.snapshot,
      ]);
      const provider = providers.find(
        (candidate) => candidate.instanceId === scope.providerInstanceId,
      );
      if (!provider) return yield* Effect.fail(new Error("Provider instance unavailable."));
      const snapshot = yield* diagnostics.getSnapshot({
        providers: [
          {
            instanceId: provider.instanceId,
            driver: provider.driver,
            ...(provider.displayName === undefined ? {} : { displayName: provider.displayName }),
            enabled: provider.enabled,
            installed: provider.installed,
            status: provider.status,
            checkedAt: new Date().toISOString(),
          },
        ],
        terminals: [],
        localMetrics: local,
        metricSnapshots,
      });
      const scopedAutomations = yield* automations.list({
        ...scope,
        includeDisabled: true,
        limit: 50,
      });
      const runs = (yield* Effect.forEach(scopedAutomations, (automation) =>
        automations.listRuns(automation.automationId, { ...scope, limit: 50 }),
      )).flat();
      const failureCount = snapshot.failures.latest.length;
      const warningCount = snapshot.warnings.length;
      const queueOverflowCount = snapshot.performance?.queues.liveBufferOverflowCount ?? 0;
      const providerLogDroppedRecords = snapshot.performance?.queues.providerLogDroppedRecords ?? 0;
      return {
        generatedAt: snapshot.generatedAt,
        health:
          failureCount > 0 || warningCount > 0 || provider.status === "error"
            ? ("degraded" as const)
            : ("ok" as const),
        projectId: scope.projectId,
        providerInstanceId: scope.providerInstanceId,
        provider: {
          status: provider.status,
          availability: provider.availability ?? "available",
          enabled: provider.enabled,
          installed: provider.installed,
        },
        project: {
          threadCount: threads.length,
          activeThreadCount: threads.filter((thread) => thread.session?.status === "running")
            .length,
          enabledAutomationCount: scopedAutomations.filter(
            (automation) => automation.enabled && !automation.cancelled,
          ).length,
          pendingAutomationRunCount: runs.filter((run) =>
            ["materializing", "pending-approval", "approved", "executing"].includes(run.status),
          ).length,
        },
        server: {
          uptimeMs: snapshot.uptimeMs,
          memoryRssBytes: snapshot.resources.current.memory.rssBytes,
          heapUsedBytes: snapshot.resources.current.memory.heapUsedBytes,
          eventLoopDelayMs: snapshot.resources.current.eventLoopDelayMs ?? null,
        },
        operational: {
          failureCount,
          warningCount,
          retainedTraceCount: snapshot.tracing.retainedSpanCount,
          queueOverflowCount,
          providerLogDroppedRecords,
        },
        redacted: true as const,
        omitted: [...omitted],
      };
    }).pipe(Effect.mapError(readError("diagnostics-summary")));

  return {
    recentActivity,
    orchestrationEvents,
    providerRuntimeEvents,
    summary,
  } satisfies AgentControlDiagnosticsShape;
});

export const AgentControlDiagnosticsServiceLive = Layer.effect(
  AgentControlDiagnosticsService,
  makeAgentControlDiagnostics,
);
