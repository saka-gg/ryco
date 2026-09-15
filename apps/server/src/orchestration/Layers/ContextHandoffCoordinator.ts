import {
  hasRetiredProjectMemory,
  REMOVED_PROJECT_MEMORY_MESSAGE,
} from "@ryco/shared/retiredFeatures";
import {
  CONTEXT_HANDOFF_ACTIVITY_KIND,
  CONTEXT_HANDOFF_CONTEXT_VERSION,
  CONTEXT_HANDOFF_ERROR_MAX_CHARS,
  CONTEXT_HANDOFF_SCHEMA_VERSION,
  CommandId,
  ContextHandoffActivityPayload,
  type ContextHandoffInspectionSummaryMetadata,
  DEFAULT_AGENT_TOKEN_MODE,
  type ContextHandoffEndpointSnapshot,
  type ContextHandoffId,
  EventId,
  ProviderDriverKind,
  RuntimeSessionId,
  type ModelSelection,
  type OrchestrationSession,
  type OrchestrationThread,
  type ProviderSession,
  type ServerProvider,
  type ThreadId,
  type TurnId,
} from "@ryco/contracts";
import { DEFAULT_CONTEXT_HANDOFF_INPUT_BUDGET } from "@ryco/shared/contextWindow";
import { getModelDisplayLabel } from "@ryco/shared/model";
import { Cause, Effect, Layer, Option, Ref, Schema } from "effect";

import { ModelManifest, BUNDLED_MODEL_MANIFEST } from "../../provider/ModelManifest.ts";
import { resolveHandoffBudgetFromManifest } from "../../provider/ModelContextWindow.ts";
import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import {
  contextHandoffContextBytesTotal,
  contextHandoffContextEntriesTotal,
  contextHandoffDispatchDuration,
  contextHandoffPreparationDuration,
  contextHandoffsTotal,
  increment,
  withMetrics,
} from "../../observability/Metrics.ts";
import {
  ContextHandoffRepository,
  type ContextHandoffRecord,
  makeRequestedContextHandoffRecord,
} from "../../persistence/Services/ContextHandoffs.ts";
import type { ProviderRuntimeBinding } from "../../provider/Services/ProviderSessionDirectory.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import {
  ContextHandoffCoordinator,
  type ContextHandoffCoordinatorShape,
} from "../Services/ContextHandoffCoordinator.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ContextHandoffDeliveryArtifact,
  type ContextHandoffDeliveryArtifact as ContextHandoffDeliveryArtifactType,
} from "../contextHandoff/ContextHandoffArtifacts.ts";
import {
  ContextHandoffService,
  type PreparedContextHandoffArtifact,
} from "../contextHandoff/ContextHandoffService.ts";
import { truncateUnicodeSafe } from "../contextHandoff/ContextHandoffBuilder.ts";

interface HandoffPresentation {
  readonly source: ContextHandoffEndpointSnapshot;
  readonly target: ContextHandoffEndpointSnapshot;
}

interface TerminalProjectionInput extends HandoffPresentation {
  readonly record: ContextHandoffRecord;
  readonly activityId: EventId;
  readonly sources: ReadonlyArray<ContextHandoffEndpointSnapshot>;
  readonly targetRuntimeSessionId?: RuntimeSessionId;
  readonly targetTurnId?: TurnId;
  readonly contextDigest?: string;
  readonly error?: string;
  readonly inspection?: ContextHandoffInspectionSummaryMetadata;
  readonly status: "consumed" | "failed" | "delivery-uncertain";
}

function inspectionSummary(input: {
  readonly artifact: PreparedContextHandoffArtifact;
  readonly deliveryArtifact?: ContextHandoffDeliveryArtifactType;
  readonly acceptedAt?: string;
}): ContextHandoffInspectionSummaryMetadata {
  return {
    completeEntryCount: input.artifact.entryCount,
    completeDigest: input.artifact.digest,
    ...(input.deliveryArtifact
      ? {
          includedEntryCount: input.deliveryArtifact.includedEntryCount,
          truncated: input.deliveryArtifact.truncated,
          providerInputDigest: input.deliveryArtifact.providerInputDigest,
          preparedAt: input.deliveryArtifact.preparedAt,
        }
      : {}),
    ...(input.acceptedAt ? { acceptedAt: input.acceptedAt } : {}),
  };
}

function deliveryArtifactFromRecord(
  record: ContextHandoffRecord,
): ContextHandoffDeliveryArtifactType | undefined {
  if (record.deliveryArtifact === null) return undefined;
  return Option.getOrUndefined(
    Schema.decodeUnknownOption(ContextHandoffDeliveryArtifact)(record.deliveryArtifact),
  );
}

const serverCommandId = (tag: string): CommandId =>
  CommandId.make(`server:${tag}:${crypto.randomUUID()}`);

const nowIso = () => new Date().toISOString();

function boundedFailureDetail(cause: Cause.Cause<unknown>): string {
  const failure = cause.reasons.find(Cause.isFailReason)?.error;
  const candidate =
    failure && typeof failure === "object" && "detail" in failure
      ? (failure as { readonly detail?: unknown }).detail
      : failure instanceof Error
        ? failure.message
        : undefined;
  const detail =
    typeof candidate === "string" && candidate.trim().length > 0
      ? candidate.trim()
      : "The target provider did not accept the context handoff.";
  return truncateUnicodeSafe(detail, CONTEXT_HANDOFF_ERROR_MAX_CHARS);
}

function runtimeBindingFromSession(
  session: ProviderSession,
  modelSelection: ModelSelection,
): ProviderRuntimeBinding | undefined {
  if (session.providerInstanceId === undefined || session.runtimeSessionId === undefined) {
    return undefined;
  }
  return {
    threadId: session.threadId,
    provider: session.provider,
    providerInstanceId: session.providerInstanceId,
    runtimeSessionId: session.runtimeSessionId,
    runtimeMode: session.runtimeMode,
    ...(session.status === "closed"
      ? { status: "stopped" as const }
      : session.status === "running"
        ? { status: "running" as const }
        : session.status === "error"
          ? { status: "error" as const }
          : {}),
    runtimePayload: { modelSelection },
  };
}

function targetRuntimeBinding(input: {
  readonly record: ContextHandoffRecord;
  readonly target: ContextHandoffEndpointSnapshot;
  readonly runtimeMode: OrchestrationThread["runtimeMode"];
}): ProviderRuntimeBinding | undefined {
  if (input.record.targetRuntimeSessionId === null) {
    return undefined;
  }
  return {
    threadId: input.record.threadId,
    provider: input.target.driverKind,
    providerInstanceId: input.record.targetSelection.instanceId,
    runtimeSessionId: input.record.targetRuntimeSessionId,
    runtimeMode: input.runtimeMode,
    runtimePayload: { modelSelection: input.record.targetSelection },
  };
}

function decodeRequestedActivity(
  thread: OrchestrationThread,
  activityId: EventId,
): typeof ContextHandoffActivityPayload.Type | undefined {
  const activity = thread.activities.find((entry) => entry.id === activityId);
  if (!activity || activity.kind !== CONTEXT_HANDOFF_ACTIVITY_KIND) {
    return undefined;
  }
  return Option.getOrUndefined(
    Schema.decodeUnknownOption(ContextHandoffActivityPayload)(activity.payload),
  );
}

function findActivityId(
  thread: OrchestrationThread,
  handoffId: ContextHandoffId,
): EventId | undefined {
  for (const activity of thread.activities) {
    if (activity.kind !== CONTEXT_HANDOFF_ACTIVITY_KIND) continue;
    const payload = Option.getOrUndefined(
      Schema.decodeUnknownOption(ContextHandoffActivityPayload)(activity.payload),
    );
    if (payload?.handoffId === handoffId) {
      return activity.id;
    }
  }
  return undefined;
}

function sessionProjection(input: {
  readonly thread: OrchestrationThread;
  readonly endpoint: ContextHandoffEndpointSnapshot;
  readonly runtimeSessionId: RuntimeSessionId;
  readonly status: OrchestrationSession["status"];
  readonly lastError: string | null;
  readonly createdAt: string;
}): OrchestrationSession {
  return {
    threadId: input.thread.id,
    status: input.status,
    providerName: input.endpoint.driverKind,
    providerInstanceId: input.endpoint.providerInstanceId,
    runtimeSessionId: input.runtimeSessionId,
    runtimeMode: input.thread.runtimeMode,
    tokenMode: input.thread.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE,
    activeTurnId: null,
    lastError: input.lastError,
    updatedAt: input.createdAt,
  };
}

function fallbackSourceDriver(thread: OrchestrationThread): ProviderDriverKind {
  const providerName = thread.session?.providerName;
  return Schema.is(ProviderDriverKind)(providerName)
    ? providerName
    : ProviderDriverKind.make(String(thread.modelSelection.instanceId));
}

function resolveModelDisplayName(
  providers: ReadonlyArray<ServerProvider>,
  selection: ModelSelection,
): string | undefined {
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  const model = provider?.models.find((candidate) => candidate.slug === selection.model);
  return model ? getModelDisplayLabel(model, { preferShortName: true }) : undefined;
}

function refreshEndpointPresentation(
  providers: ReadonlyArray<ServerProvider>,
  endpoint: ContextHandoffEndpointSnapshot,
): ContextHandoffEndpointSnapshot {
  const provider = providers.find(
    (candidate) => candidate.instanceId === endpoint.providerInstanceId,
  );
  const model = provider?.models.find((candidate) => candidate.slug === endpoint.modelSlug);
  return {
    ...endpoint,
    ...(provider?.displayName ? { providerDisplayName: provider.displayName } : {}),
    ...(provider?.accentColor ? { providerAccentColor: provider.accentColor } : {}),
    ...(model
      ? {
          modelDisplayName: getModelDisplayLabel(model, {
            preferShortName: true,
          }),
        }
      : {}),
  };
}

export const makeContextHandoffCoordinator = Effect.gen(function* () {
  const manifestService = yield* Effect.serviceOption(ModelManifest);
  const repository = yield* ContextHandoffRepository;
  const contextService = yield* ContextHandoffService;
  const providerService = yield* ProviderService;
  const providerRegistry = yield* ProviderRegistry;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const inFlight = yield* Ref.make(new Set<ContextHandoffId>());

  const resolveThread = (threadId: ThreadId) =>
    projectionSnapshotQuery.getThreadDetailById(threadId).pipe(Effect.map(Option.getOrUndefined));

  const setThreadSession = (input: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession;
    readonly createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.session.set",
      commandId: serverCommandId("context-handoff-session"),
      threadId: input.threadId,
      session: input.session,
      createdAt: input.createdAt,
    });

  const resolvePresentation = Effect.fn("ContextHandoffCoordinator.resolvePresentation")(function* (
    thread: OrchestrationThread,
    record: ContextHandoffRecord,
  ) {
    const [targetInfo, sourceInfo, providers] = yield* Effect.all(
      [
        providerService.getInstanceInfo(record.targetSelection.instanceId),
        providerService.getInstanceInfo(record.sourceSelection.instanceId).pipe(Effect.option),
        providerRegistry.getProviders,
      ],
      { concurrency: "unbounded" },
    );
    const sourceDriver = Option.isSome(sourceInfo)
      ? sourceInfo.value.driverKind
      : fallbackSourceDriver(thread);
    const sourceModelDisplayName = resolveModelDisplayName(providers, record.sourceSelection);
    const targetModelDisplayName = resolveModelDisplayName(providers, record.targetSelection);
    return {
      source: {
        providerInstanceId: record.sourceSelection.instanceId,
        driverKind: sourceDriver,
        ...(Option.isSome(sourceInfo) && sourceInfo.value.displayName
          ? { providerDisplayName: sourceInfo.value.displayName }
          : {}),
        ...(Option.isSome(sourceInfo) && sourceInfo.value.accentColor
          ? { providerAccentColor: sourceInfo.value.accentColor }
          : {}),
        modelSlug: record.sourceSelection.model,
        ...(sourceModelDisplayName ? { modelDisplayName: sourceModelDisplayName } : {}),
      },
      target: {
        providerInstanceId: record.targetSelection.instanceId,
        driverKind: targetInfo.driverKind,
        ...(targetInfo.displayName ? { providerDisplayName: targetInfo.displayName } : {}),
        ...(targetInfo.accentColor ? { providerAccentColor: targetInfo.accentColor } : {}),
        modelSlug: record.targetSelection.model,
        ...(targetModelDisplayName ? { modelDisplayName: targetModelDisplayName } : {}),
      },
    } satisfies HandoffPresentation;
  });

  const appendTerminalActivity = Effect.fn("ContextHandoffCoordinator.appendTerminalActivity")(
    function* (input: TerminalProjectionInput) {
      const providers = yield* providerRegistry.getProviders;
      const sources = input.sources.map((endpoint) =>
        refreshEndpointPresentation(providers, endpoint),
      );
      const target = refreshEndpointPresentation(providers, input.target);
      const common = {
        schemaVersion: CONTEXT_HANDOFF_SCHEMA_VERSION as 1,
        handoffId: input.record.handoffId,
        mode: "full-context-fresh-session" as const,
        targetMessageId: input.record.firstMessageId,
        ...(input.targetTurnId ? { targetTurnId: input.targetTurnId } : {}),
        sourceSelection: input.record.sourceSelection,
        targetSelection: input.record.targetSelection,
        ...(input.record.sourceRuntimeSessionId
          ? { sourceRuntimeSessionId: input.record.sourceRuntimeSessionId }
          : {}),
        ...(input.targetRuntimeSessionId
          ? { targetRuntimeSessionId: input.targetRuntimeSessionId }
          : {}),
        sources,
        target,
        ...(input.inspection ? { inspection: input.inspection } : {}),
      };
      const payload: typeof ContextHandoffActivityPayload.Type =
        input.status === "consumed"
          ? {
              ...common,
              status: "consumed",
              contextVersion: CONTEXT_HANDOFF_CONTEXT_VERSION,
              contextDigest: input.contextDigest!,
            }
          : input.status === "delivery-uncertain"
            ? {
                ...common,
                status: "delivery-uncertain",
                contextVersion: CONTEXT_HANDOFF_CONTEXT_VERSION,
                contextDigest: input.contextDigest!,
                error: input.error!,
              }
            : {
                ...common,
                status: "failed",
                ...(input.contextDigest
                  ? {
                      contextVersion: CONTEXT_HANDOFF_CONTEXT_VERSION,
                      contextDigest: input.contextDigest,
                    }
                  : {}),
                error: input.error!,
              };
      return yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: serverCommandId(`context-handoff-${input.status}`),
        threadId: input.record.threadId,
        activity: {
          id: input.activityId,
          tone: input.status === "consumed" ? "info" : "error",
          kind: CONTEXT_HANDOFF_ACTIVITY_KIND,
          summary:
            input.status === "consumed"
              ? "Context handoff completed"
              : input.status === "failed"
                ? "Context handoff failed"
                : "Context handoff delivery uncertain",
          payload,
          turnId: null,
          createdAt: input.record.createdAt,
        },
        createdAt: nowIso(),
      });
    },
  );

  const commitTargetSelection = (record: ContextHandoffRecord) =>
    orchestrationEngine.dispatch({
      type: "thread.meta.update",
      commandId: serverCommandId("context-handoff-commit-target"),
      threadId: record.threadId,
      modelSelection: record.targetSelection,
    });

  const restoreSource = Effect.fn("ContextHandoffCoordinator.restoreSource")(function* (input: {
    readonly thread: OrchestrationThread;
    readonly record: ContextHandoffRecord;
    readonly source: ContextHandoffEndpointSnapshot;
    readonly sourceBinding?: ProviderRuntimeBinding;
    readonly error: string;
  }) {
    const restored = input.sourceBinding
      ? yield* providerService
          .restoreSessionBinding(input.sourceBinding)
          .pipe(Effect.catch(() => Effect.succeed(false)))
      : false;
    const runtimeSessionId =
      input.sourceBinding?.runtimeSessionId ?? input.record.sourceRuntimeSessionId ?? undefined;
    if (runtimeSessionId === undefined) {
      return;
    }
    yield* setThreadSession({
      threadId: input.thread.id,
      session: sessionProjection({
        thread: input.thread,
        endpoint: input.source,
        runtimeSessionId,
        status: restored ? "ready" : "error",
        lastError: restored ? null : input.error,
        createdAt: nowIso(),
      }),
      createdAt: nowIso(),
    }).pipe(Effect.catch(() => Effect.void));
  });

  const finalizeFailure = Effect.fn("ContextHandoffCoordinator.finalizeFailure")(function* (input: {
    readonly thread: OrchestrationThread;
    readonly record: ContextHandoffRecord;
    readonly activityId: EventId;
    readonly presentation: HandoffPresentation;
    readonly sourceBinding?: ProviderRuntimeBinding;
    readonly artifact?: PreparedContextHandoffArtifact;
    readonly cause: Cause.Cause<unknown>;
  }) {
    if (Cause.hasInterruptsOnly(input.cause)) {
      return yield* Effect.interrupt;
    }
    const error = boundedFailureDetail(input.cause);
    const current = Option.getOrUndefined(
      yield* repository.getById({ handoffId: input.record.handoffId }),
    );
    if (
      !current ||
      current.status === "consumed" ||
      current.status === "failed" ||
      current.status === "delivery-uncertain"
    ) {
      return;
    }
    // Acceptance is durable at this point. Never downgrade an accepted turn
    // to failed because a later activity/meta projection temporarily failed;
    // startup reconciliation will finish it idempotently.
    if (current.status === "dispatching" && current.acceptedProviderTurnId !== null) {
      return;
    }
    const storedArtifact =
      input.artifact ??
      Option.getOrUndefined(
        yield* contextService
          .loadStoredContext({ handoffId: current.handoffId })
          .pipe(Effect.option),
      );
    const deliveryArtifact = deliveryArtifactFromRecord(current);
    const targetBinding = targetRuntimeBinding({
      record: current,
      target: input.presentation.target,
      runtimeMode: input.thread.runtimeMode,
    });
    if (targetBinding) {
      yield* providerService
        .stopSessionBinding(targetBinding)
        .pipe(Effect.catch(() => Effect.void));
      yield* providerService
        .retireSessionBinding(targetBinding)
        .pipe(Effect.catch(() => Effect.void));
    }
    yield* restoreSource({
      thread: input.thread,
      record: current,
      source: input.presentation.source,
      ...(input.sourceBinding ? { sourceBinding: input.sourceBinding } : {}),
      error,
    });
    yield* repository.compareAndSetStatus({
      handoffId: current.handoffId,
      expectedStatus: current.status,
      nextStatus: current.status,
      targetRuntimeSessionId: current.targetRuntimeSessionId,
      acceptedProviderTurnId: current.acceptedProviderTurnId,
      error,
      updatedAt: nowIso(),
    });
    yield* appendTerminalActivity({
      record: current,
      activityId: input.activityId,
      source: input.presentation.source,
      target: input.presentation.target,
      sources: storedArtifact?.document.provenance.sources ?? [input.presentation.source],
      ...(current.targetRuntimeSessionId
        ? { targetRuntimeSessionId: current.targetRuntimeSessionId }
        : {}),
      ...(storedArtifact?.digest ? { contextDigest: storedArtifact.digest } : {}),
      ...(storedArtifact
        ? {
            inspection: inspectionSummary({
              artifact: storedArtifact,
              ...(deliveryArtifact ? { deliveryArtifact } : {}),
            }),
          }
        : {}),
      error,
      status: "failed",
    });
    const transitioned = yield* repository.compareAndSetStatus({
      handoffId: current.handoffId,
      expectedStatus: current.status,
      nextStatus: "failed",
      targetRuntimeSessionId: current.targetRuntimeSessionId,
      acceptedProviderTurnId: current.acceptedProviderTurnId,
      error,
      updatedAt: nowIso(),
    });
    if (transitioned) {
      yield* increment(contextHandoffsTotal, { status: "failed" });
    }
  });

  const finalizeConsumed = Effect.fn("ContextHandoffCoordinator.finalizeConsumed")(
    function* (input: {
      readonly thread: OrchestrationThread;
      readonly record: ContextHandoffRecord;
      readonly activityId: EventId;
      readonly artifact: PreparedContextHandoffArtifact;
      readonly deliveryArtifact?: ContextHandoffDeliveryArtifactType;
      readonly targetTurnId: TurnId;
      readonly acceptedAt?: string;
      readonly sourceBinding?: ProviderRuntimeBinding;
    }) {
      if (input.record.targetRuntimeSessionId === null) {
        return yield* Effect.die("Consumed context handoff is missing its target runtime epoch.");
      }
      yield* appendTerminalActivity({
        record: input.record,
        activityId: input.activityId,
        source: input.artifact.document.provenance.sources.at(-1)!,
        target: input.artifact.document.provenance.target,
        sources: input.artifact.document.provenance.sources,
        targetRuntimeSessionId: input.record.targetRuntimeSessionId,
        targetTurnId: input.targetTurnId,
        contextDigest: input.artifact.digest,
        inspection: inspectionSummary({
          artifact: input.artifact,
          ...(input.deliveryArtifact ? { deliveryArtifact: input.deliveryArtifact } : {}),
          ...(input.acceptedAt ? { acceptedAt: input.acceptedAt } : {}),
        }),
        status: "consumed",
      });
      yield* commitTargetSelection(input.record);
      const transitioned = yield* repository.compareAndSetStatus({
        handoffId: input.record.handoffId,
        expectedStatus: "dispatching",
        nextStatus: "consumed",
        targetRuntimeSessionId: input.record.targetRuntimeSessionId,
        acceptedProviderTurnId: input.targetTurnId,
        error: null,
        updatedAt: nowIso(),
      });
      if (transitioned) {
        yield* increment(contextHandoffsTotal, { status: "consumed" });
      }
      if (input.sourceBinding) {
        yield* providerService
          .stopSessionBinding(input.sourceBinding)
          .pipe(Effect.catch(() => Effect.void));
      }
    },
  );

  const prepareAndDispatch = Effect.fn("ContextHandoffCoordinator.prepareAndDispatch")(
    function* (input: {
      readonly thread: OrchestrationThread;
      readonly record: ContextHandoffRecord;
      readonly activityId: EventId;
      readonly rememberSourceBinding: (binding: ProviderRuntimeBinding | undefined) => void;
    }) {
      if (hasRetiredProjectMemory(decodeRequestedActivity(input.thread, input.activityId))) {
        return yield* Effect.fail(new Error(REMOVED_PROJECT_MEMORY_MESSAGE));
      }
      const presentation = yield* resolvePresentation(input.thread, input.record);
      const sourceSession = Option.getOrUndefined(
        yield* providerService.getSession(input.thread.id),
      );
      const sourceBinding = sourceSession
        ? runtimeBindingFromSession(sourceSession, input.record.sourceSelection)
        : undefined;
      const artifact = yield* contextService.buildAndStore({
        handoffId: input.record.handoffId,
        thread: input.thread,
        targetMessageId: input.record.firstMessageId,
        source: presentation.source,
        target: presentation.target,
        updatedAt: nowIso(),
      });
      const message = input.thread.messages.find(
        (entry) => entry.id === input.record.firstMessageId && entry.role === "user",
      );
      if (!message) {
        return yield* Effect.die("Context handoff target message is unavailable.");
      }
      const budget = yield* Effect.gen(function* () {
        const manifest = Option.isSome(manifestService)
          ? yield* manifestService.value.current
          : BUNDLED_MODEL_MANIFEST;
        return resolveHandoffBudgetFromManifest(
          manifest,
          presentation.target.driverKind,
          input.record.targetSelection,
        );
      }).pipe(Effect.catchCause(() => Effect.succeed(DEFAULT_CONTEXT_HANDOFF_INPUT_BUDGET)));
      const deliveryArtifact = yield* contextService.prepareDeliveryArtifact({
        ...budget,
        handoffId: input.record.handoffId,
        triggeringMessageId: input.record.firstMessageId,
        currentMessage: message.text,
        preparedAt: nowIso(),
      });
      const contextBytes = new TextEncoder().encode(
        JSON.stringify(deliveryArtifact.renderedContext),
      ).byteLength;
      yield* increment(
        contextHandoffContextBytesTotal,
        { truncated: deliveryArtifact.truncated },
        contextBytes,
      );
      yield* increment(
        contextHandoffContextEntriesTotal,
        { truncated: deliveryArtifact.truncated },
        deliveryArtifact.includedEntryCount,
      );
      let targetRuntimeSessionId = input.record.targetRuntimeSessionId;
      if (targetRuntimeSessionId === null) {
        targetRuntimeSessionId = RuntimeSessionId.make(crypto.randomUUID());
        const reserved = yield* repository.compareAndSetStatus({
          handoffId: input.record.handoffId,
          expectedStatus: "preparing",
          nextStatus: "preparing",
          targetRuntimeSessionId,
          acceptedProviderTurnId: null,
          error: null,
          updatedAt: nowIso(),
        });
        if (!reserved) {
          return yield* Effect.die("Context handoff target runtime reservation was lost.");
        }
      }
      const record = { ...input.record, targetRuntimeSessionId };
      const projectedAt = nowIso();
      yield* setThreadSession({
        threadId: record.threadId,
        session: sessionProjection({
          thread: input.thread,
          endpoint: presentation.target,
          runtimeSessionId: targetRuntimeSessionId,
          status: "starting",
          lastError: null,
          createdAt: projectedAt,
        }),
        createdAt: projectedAt,
      });
      const project = Option.getOrUndefined(
        yield* projectionSnapshotQuery.getProjectShellById(input.thread.projectId),
      );
      const cwd = resolveThreadWorkspaceCwd({
        thread: input.thread,
        projects: project ? [project] : [],
      });
      const fresh = yield* providerService.startFreshSession(record.threadId, {
        threadId: record.threadId,
        provider: presentation.target.driverKind,
        providerInstanceId: record.targetSelection.instanceId,
        runtimeSessionId: targetRuntimeSessionId,
        ...(cwd ? { cwd } : {}),
        modelSelection: record.targetSelection,
        runtimeMode: input.thread.runtimeMode,
        tokenMode: input.thread.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE,
        ...(project?.customSystemPrompt ? { customSystemPrompt: project.customSystemPrompt } : {}),
      });
      const replacementSourceBinding = fresh.previousBinding ?? sourceBinding;
      input.rememberSourceBinding(replacementSourceBinding);
      const readyAt = nowIso();
      yield* setThreadSession({
        threadId: record.threadId,
        session: sessionProjection({
          thread: input.thread,
          endpoint: presentation.target,
          runtimeSessionId: targetRuntimeSessionId,
          status: fresh.session.status === "running" ? "running" : "ready",
          lastError: fresh.session.lastError ?? null,
          createdAt: readyAt,
        }),
        createdAt: readyAt,
      });
      const dispatching = yield* repository.compareAndSetStatus({
        handoffId: record.handoffId,
        expectedStatus: "preparing",
        nextStatus: "dispatching",
        targetRuntimeSessionId,
        acceptedProviderTurnId: null,
        error: null,
        updatedAt: nowIso(),
      });
      if (!dispatching) {
        return yield* Effect.die("Context handoff dispatch reservation was lost.");
      }
      const turn = yield* providerService
        .sendTurn({
          threadId: record.threadId,
          input: deliveryArtifact.providerInput,
          ...(message.attachments && message.attachments.length > 0
            ? { attachments: message.attachments }
            : {}),
          modelSelection: record.targetSelection,
          interactionMode: input.thread.interactionMode,
          tokenMode: input.thread.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE,
          ...(project?.customSystemPrompt
            ? { customSystemPrompt: project.customSystemPrompt }
            : {}),
        })
        .pipe(withMetrics({ timer: contextHandoffDispatchDuration }));
      const acceptedAt = nowIso();
      const accepted = yield* repository.compareAndSetStatus({
        handoffId: record.handoffId,
        expectedStatus: "dispatching",
        nextStatus: "dispatching",
        targetRuntimeSessionId,
        acceptedProviderTurnId: turn.turnId,
        error: null,
        updatedAt: acceptedAt,
      });
      if (!accepted) {
        return yield* Effect.die("Context handoff acceptance could not be persisted.");
      }
      yield* finalizeConsumed({
        thread: input.thread,
        record: {
          ...record,
          status: "dispatching",
          acceptedProviderTurnId: turn.turnId,
        },
        activityId: input.activityId,
        artifact,
        deliveryArtifact,
        targetTurnId: turn.turnId,
        acceptedAt,
        ...(replacementSourceBinding ? { sourceBinding: replacementSourceBinding } : {}),
      });
    },
  );

  const runPreparing = Effect.fn("ContextHandoffCoordinator.runPreparing")(function* (input: {
    readonly thread: OrchestrationThread;
    readonly record: ContextHandoffRecord;
    readonly activityId: EventId;
  }) {
    let record = input.record;
    if (record.status === "requested") {
      const preparing = yield* repository.compareAndSetStatus({
        handoffId: record.handoffId,
        expectedStatus: "requested",
        nextStatus: "preparing",
        targetRuntimeSessionId: null,
        acceptedProviderTurnId: null,
        error: null,
        updatedAt: nowIso(),
      });
      if (!preparing) return;
      record = { ...record, status: "preparing", updatedAt: nowIso() };
    }
    if (record.status !== "preparing") return;
    const presentation = yield* resolvePresentation(input.thread, record);
    const sourceSession = Option.getOrUndefined(yield* providerService.getSession(input.thread.id));
    const sourceBinding = sourceSession
      ? runtimeBindingFromSession(sourceSession, record.sourceSelection)
      : undefined;
    let rollbackBinding = sourceBinding;
    yield* prepareAndDispatch({
      ...input,
      record,
      rememberSourceBinding: (binding) => {
        rollbackBinding = binding;
      },
    }).pipe(
      withMetrics({ timer: contextHandoffPreparationDuration }),
      Effect.catchCause((cause) =>
        finalizeFailure({
          thread: input.thread,
          record,
          activityId: input.activityId,
          presentation,
          ...(rollbackBinding ? { sourceBinding: rollbackBinding } : {}),
          cause,
        }),
      ),
    );
  });

  const markDeliveryUncertain = Effect.fn("ContextHandoffCoordinator.markDeliveryUncertain")(
    function* (input: {
      readonly thread: OrchestrationThread;
      readonly record: ContextHandoffRecord;
      readonly activityId: EventId;
      readonly presentation: HandoffPresentation;
      readonly artifact: PreparedContextHandoffArtifact;
      readonly sourceBinding?: ProviderRuntimeBinding;
    }) {
      const error =
        "Target turn delivery could not be proven after server recovery; Ryco did not resend it.";
      const targetBinding = targetRuntimeBinding({
        record: input.record,
        target: input.presentation.target,
        runtimeMode: input.thread.runtimeMode,
      });
      if (targetBinding) {
        yield* providerService
          .stopSessionBinding(targetBinding)
          .pipe(Effect.catch(() => Effect.void));
        yield* providerService
          .retireSessionBinding(targetBinding)
          .pipe(Effect.catch(() => Effect.void));
      }
      yield* restoreSource({
        thread: input.thread,
        record: input.record,
        source: input.presentation.source,
        ...(input.sourceBinding ? { sourceBinding: input.sourceBinding } : {}),
        error,
      });
      yield* repository.compareAndSetStatus({
        handoffId: input.record.handoffId,
        expectedStatus: "dispatching",
        nextStatus: "dispatching",
        targetRuntimeSessionId: input.record.targetRuntimeSessionId,
        acceptedProviderTurnId: input.record.acceptedProviderTurnId,
        error,
        updatedAt: nowIso(),
      });
      const deliveryArtifact = deliveryArtifactFromRecord(input.record);
      yield* appendTerminalActivity({
        record: input.record,
        activityId: input.activityId,
        source: input.presentation.source,
        target: input.presentation.target,
        sources: input.artifact.document.provenance.sources,
        ...(input.record.targetRuntimeSessionId
          ? { targetRuntimeSessionId: input.record.targetRuntimeSessionId }
          : {}),
        contextDigest: input.artifact.digest,
        inspection: inspectionSummary({
          artifact: input.artifact,
          ...(deliveryArtifact ? { deliveryArtifact } : {}),
        }),
        error,
        status: "delivery-uncertain",
      });
      const transitioned = yield* repository.compareAndSetStatus({
        handoffId: input.record.handoffId,
        expectedStatus: "dispatching",
        nextStatus: "delivery-uncertain",
        targetRuntimeSessionId: input.record.targetRuntimeSessionId,
        acceptedProviderTurnId: input.record.acceptedProviderTurnId,
        error,
        updatedAt: nowIso(),
      });
      if (transitioned) {
        yield* increment(contextHandoffsTotal, { status: "delivery-uncertain" });
      }
    },
  );

  const reconcileDispatching = Effect.fn("ContextHandoffCoordinator.reconcileDispatching")(
    function* (input: {
      readonly thread: OrchestrationThread;
      readonly record: ContextHandoffRecord;
      readonly activityId: EventId;
    }) {
      const presentation = yield* resolvePresentation(input.thread, input.record);
      const artifact = yield* contextService.loadStoredContext({
        handoffId: input.record.handoffId,
      });
      const sourceBinding: ProviderRuntimeBinding | undefined =
        input.record.sourceRuntimeSessionId === null
          ? undefined
          : {
              threadId: input.record.threadId,
              provider: presentation.source.driverKind,
              providerInstanceId: input.record.sourceSelection.instanceId,
              runtimeSessionId: input.record.sourceRuntimeSessionId,
              runtimeMode: input.thread.runtimeMode,
              runtimePayload: { modelSelection: input.record.sourceSelection },
            };
      const projectedAcceptedTurn =
        input.thread.session?.providerInstanceId === input.record.targetSelection.instanceId &&
        input.thread.session.runtimeSessionId === input.record.targetRuntimeSessionId
          ? (input.thread.session.activeTurnId ??
            (input.thread.latestTurn?.startedAt &&
            input.thread.latestTurn.startedAt >= input.record.updatedAt
              ? input.thread.latestTurn.turnId
              : undefined))
          : undefined;
      const acceptedTurnId = input.record.acceptedProviderTurnId ?? projectedAcceptedTurn;
      if (acceptedTurnId) {
        const deliveryArtifact = deliveryArtifactFromRecord(input.record);
        yield* finalizeConsumed({
          thread: input.thread,
          record: input.record,
          activityId: input.activityId,
          artifact,
          ...(deliveryArtifact ? { deliveryArtifact } : {}),
          targetTurnId: acceptedTurnId,
          acceptedAt: input.record.updatedAt,
          ...(sourceBinding ? { sourceBinding } : {}),
        });
        return;
      }
      yield* markDeliveryUncertain({
        ...input,
        presentation,
        artifact,
        ...(sourceBinding ? { sourceBinding } : {}),
      });
    },
  );

  const acquire = (handoffId: ContextHandoffId) =>
    Ref.modify(inFlight, (current) => {
      if (current.has(handoffId)) return [false, current] as const;
      const next = new Set(current);
      next.add(handoffId);
      return [true, next] as const;
    });
  const release = (handoffId: ContextHandoffId) =>
    Ref.update(inFlight, (current) => {
      const next = new Set(current);
      next.delete(handoffId);
      return next;
    });

  const processTurnStart: ContextHandoffCoordinatorShape["processTurnStart"] = (event) => {
    const reference = event.payload.contextHandoff;
    if (!reference) return Effect.void;
    return Effect.gen(function* () {
      if (!(yield* acquire(reference.handoffId))) return;
      yield* Effect.gen(function* () {
        const thread = yield* resolveThread(event.payload.threadId);
        if (!thread) return;
        const requested = decodeRequestedActivity(thread, reference.activityId);
        if (
          !requested ||
          requested.handoffId !== reference.handoffId ||
          requested.targetMessageId !== reference.targetMessageId
        ) {
          return;
        }
        const created = yield* repository.create(
          makeRequestedContextHandoffRecord({
            handoffId: reference.handoffId,
            threadId: thread.id,
            sourceSelection: requested.sourceSelection,
            targetSelection: requested.targetSelection,
            sourceRuntimeSessionId: requested.sourceRuntimeSessionId ?? null,
            firstMessageId: reference.targetMessageId,
            createdAt: event.payload.createdAt,
            updatedAt: event.payload.createdAt,
          }),
        );
        if (created) {
          yield* increment(contextHandoffsTotal, { status: "requested" });
        }
        const record = Option.getOrUndefined(
          yield* repository.getById({ handoffId: reference.handoffId }),
        );
        if (!record) return;
        yield* runPreparing({
          thread,
          record,
          activityId: reference.activityId,
        });
      }).pipe(Effect.ensuring(release(reference.handoffId)));
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("context handoff processing failed", {
              operation: "context-handoff-processing",
            }),
      ),
    );
  };

  const recover: ContextHandoffCoordinatorShape["recover"] = () =>
    Effect.gen(function* () {
      const records = yield* repository.listRecoverable();
      for (const record of records) {
        const thread = yield* resolveThread(record.threadId);
        if (!thread) continue;
        const activityId = findActivityId(thread, record.handoffId);
        if (!activityId) continue;
        if (record.status === "preparing") {
          yield* runPreparing({ thread, record, activityId });
        } else if (record.status === "dispatching") {
          yield* reconcileDispatching({ thread, record, activityId });
        }
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("context handoff recovery failed", {
              operation: "context-handoff-recovery",
            }),
      ),
    );

  return { processTurnStart, recover } satisfies ContextHandoffCoordinatorShape;
});

export const ContextHandoffCoordinatorLive = Layer.effect(
  ContextHandoffCoordinator,
  makeContextHandoffCoordinator,
);
