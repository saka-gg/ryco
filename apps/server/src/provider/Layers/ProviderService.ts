import { readPersistedCwd } from "../runtimeCwd.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { acquireStoragePathUseLease } from "../../storage/lifecycle.ts";
/**
 * ProviderServiceLive - Cross-provider orchestration layer.
 *
 * Routes validated transport/API calls to provider adapters through
 * `ProviderAdapterRegistry` and `ProviderSessionDirectory`, and exposes a
 * unified provider event stream for subscribers.
 *
 * It does not implement provider protocol details (adapter concern).
 *
 * @module ProviderServiceLive
 */
import { ASSISTANT_ATTACHMENT_INSTRUCTIONS } from "../../assistantAttachments.ts";
import {
  ModelSelection,
  NonNegativeInt,
  PROVIDER_DISPLAY_NAMES,
  ThreadId,
  ProviderInterruptTurnInput,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
  ProviderSteerTurnInput,
  ProviderStopBackgroundTaskInput,
  ProviderStopSessionInput,
  RuntimeSessionId,
  TurnId,
  type ProviderInstanceId,
  type ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
} from "@ryco/contracts";
import {
  Cause,
  Clock,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Metric,
  Option,
  PubSub,
  Ref,
  Schema,
  SchemaIssue,
  Stream,
  SynchronizedRef,
} from "effect";
import * as Semaphore from "effect/Semaphore";

import {
  increment,
  metricAttributes,
  providerMetricAttributes,
  providerRuntimeEventsTotal,
  providerSessionsTotal,
  providerStaleStopTimeoutsTotal,
  providerStartupAdmissionTotal,
  providerStartupQueueDepth,
  providerStartupQueueHighWater,
  providerStartupQueueWaitDuration,
  providerTurnDuration,
  providerTurnsTotal,
  providerTurnMetricAttributes,
  withMetrics,
} from "../../observability/Metrics.ts";
import {
  type ProviderAdapterError,
  type ProviderServiceError,
  ProviderOperationTimeoutError,
  ProviderOperationUnsupportedError,
  ProviderSessionNotFoundError,
  ProviderTurnNotSteerableError,
  ProviderUnsupportedError,
  ProviderValidationError,
} from "../Errors.ts";
import { runDetachedWithDeadline, runDetachedWithDeadlineOption } from "../detachedDeadline.ts";
import {
  providerOperationTimeoutDetail,
  resolveProviderOperationTimeouts,
  type ProviderOperationTimeoutOverrides,
  type ProviderStartPhase,
  type ProviderTimedOperation,
} from "../providerOperationPolicy.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import {
  ProviderService,
  type ProviderFreshSessionStartInput,
  type ProviderRuntimeActivity,
  type ProviderServiceShape,
  type ProviderRuntimeEventSummary,
  type ProviderSessionBindingStopResult,
} from "../Services/ProviderService.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
} from "../Services/ProviderSessionDirectory.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { ProviderEventLoggers } from "./ProviderEventLoggers.ts";
import { AnalyticsService } from "../../telemetry/Services/AnalyticsService.ts";

/**
 * Hook for tests that want to override the canonical event logger pulled
 * from `ProviderEventLoggers`. Production wiring leaves this undefined and
 * reads the logger off the tag.
 */
export interface ProviderServiceLiveOptions {
  readonly canonicalEventLogger?: EventNdjsonLogger;
  readonly providerStartupAdmission?: {
    readonly maxConcurrentStartsPerInstance?: number;
    readonly maxPendingStartsPerInstance?: number;
  };
  readonly staleSessionStopTimeoutMs?: number;
  /** Deadline overrides; otherwise the operator environment, then the defaults. */
  readonly operationTimeouts?: ProviderOperationTimeoutOverrides;
}

const DEFAULT_MAX_CONCURRENT_PROVIDER_STARTS_PER_INSTANCE = 4;
const DEFAULT_MAX_PENDING_PROVIDER_STARTS_PER_INSTANCE = 64;
const DEFAULT_STALE_SESSION_STOP_TIMEOUT_MS = 2_000;

function bindingKey(binding: ProviderRuntimeBinding): string {
  return `${binding.threadId}:${binding.providerInstanceId ?? "legacy"}:${binding.runtimeSessionId ?? "legacy"}`;
}

function sessionMatchesBinding(
  session: ProviderSession,
  instanceId: ProviderInstanceId,
  binding: ProviderRuntimeBinding,
): boolean {
  return (
    session.threadId === binding.threadId &&
    session.provider === binding.provider &&
    instanceId === binding.providerInstanceId &&
    session.runtimeSessionId === binding.runtimeSessionId
  );
}

function bindingIdentityMatches(
  current: ProviderRuntimeBinding,
  expected: ProviderRuntimeBinding,
): boolean {
  return (
    expected.providerInstanceId !== undefined &&
    expected.runtimeSessionId !== undefined &&
    current.threadId === expected.threadId &&
    current.provider === expected.provider &&
    current.providerInstanceId === expected.providerInstanceId &&
    current.runtimeSessionId === expected.runtimeSessionId
  );
}

interface ProviderStartupAdmissionState {
  readonly semaphores: Map<ProviderInstanceId, Semaphore.Semaphore>;
  readonly pendingByInstance: Map<ProviderInstanceId, number>;
  readonly highWaterByInstance: Map<ProviderInstanceId, number>;
}

const ProviderRollbackConversationInput = Schema.Struct({
  threadId: ThreadId,
  numTurns: NonNegativeInt,
  targetTurnId: Schema.NullOr(TurnId),
  droppedTurnIds: Schema.Array(TurnId),
});

function toValidationError(
  operation: string,
  issue: string,
  cause?: unknown,
): ProviderValidationError {
  return new ProviderValidationError({
    operation,
    issue,
    ...(cause !== undefined ? { cause } : {}),
  });
}

const decodeInputOrValidationError = <S extends Schema.Top>(input: {
  readonly operation: string;
  readonly schema: S;
  readonly payload: unknown;
}) =>
  Schema.decodeUnknownEffect(input.schema)(input.payload).pipe(
    Effect.mapError(
      (schemaError) =>
        new ProviderValidationError({
          operation: input.operation,
          issue: SchemaIssue.makeFormatterDefault()(schemaError.issue),
          cause: schemaError,
        }),
    ),
  );

const normalizePositiveInt = (value: number | undefined, fallback: number): number =>
  value === undefined || !Number.isFinite(value) ? fallback : Math.max(1, Math.floor(value));

function toRuntimeStatus(session: ProviderSession): "starting" | "running" | "stopped" | "error" {
  switch (session.status) {
    case "connecting":
      return "starting";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    case "running":
    default:
      return "running";
  }
}

function toRuntimePayloadFromSession(
  session: ProviderSession,
  extra?: {
    readonly modelSelection?: unknown;
    readonly lastRuntimeEvent?: string;
    readonly lastRuntimeEventAt?: string;
  },
): Record<string, unknown> {
  return {
    cwd: session.cwd ?? null,
    model: session.model ?? null,
    activeTurnId: session.activeTurnId ?? null,
    lastError: session.lastError ?? null,
    ...(extra?.modelSelection !== undefined ? { modelSelection: extra.modelSelection } : {}),
    ...(extra?.lastRuntimeEvent !== undefined ? { lastRuntimeEvent: extra.lastRuntimeEvent } : {}),
    ...(extra?.lastRuntimeEventAt !== undefined
      ? { lastRuntimeEventAt: extra.lastRuntimeEventAt }
      : {}),
  };
}

function readPersistedModelSelection(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): ModelSelection | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const raw = "modelSelection" in runtimePayload ? runtimePayload.modelSelection : undefined;
  return Schema.is(ModelSelection)(raw) ? raw : undefined;
}

const dieOnMissingBindingInstanceId = (
  operation: string,
  payload: {
    readonly providerInstanceId?: ProviderInstanceId | undefined;
    readonly provider?: ProviderDriverKind | undefined;
  },
): ProviderInstanceId => {
  if (payload.providerInstanceId !== undefined) {
    return payload.providerInstanceId;
  }
  throw new Error(
    payload.provider
      ? `${operation}: provider instance id is required for provider '${payload.provider}'.`
      : `${operation}: provider instance id is required.`,
  );
};

const correlateRuntimeEventWithInstance = (
  source: {
    readonly instanceId: ProviderInstanceId;
    readonly provider: ProviderDriverKind;
  },
  event: ProviderRuntimeEvent,
): ProviderRuntimeEvent => {
  if (event.provider !== source.provider) {
    throw new Error(
      `ProviderService.streamEvents: provider instance '${source.instanceId}' is backed by driver '${source.provider}' but emitted driver '${event.provider}'.`,
    );
  }
  if (event.providerInstanceId !== undefined && event.providerInstanceId !== source.instanceId) {
    throw new Error(
      `ProviderService.streamEvents: provider instance '${source.instanceId}' emitted event for instance '${event.providerInstanceId}'.`,
    );
  }
  return { ...event, providerInstanceId: source.instanceId };
};

const makeProviderService = Effect.fn("makeProviderService")(function* (
  options?: ProviderServiceLiveOptions,
) {
  const storageSql = yield* Effect.serviceOption(SqlClient.SqlClient);
  const analytics = yield* Effect.service(AnalyticsService);
  const eventLoggers = yield* ProviderEventLoggers;
  // Options-provided logger wins (test overrides); otherwise we take whatever
  // the `ProviderEventLoggers` tag exposes — `undefined` means "no canonical
  // log writer is attached", which downstream code already handles as a
  // no-op.
  const canonicalEventLogger = options?.canonicalEventLogger ?? eventLoggers.canonical;

  const registry = yield* ProviderAdapterRegistry;
  const directory = yield* ProviderSessionDirectory;
  const runtimeEventPubSub = yield* PubSub.bounded<ProviderRuntimeEvent>(4_096);
  const recentRuntimeEvents = yield* Ref.make<ReadonlyArray<ProviderRuntimeEventSummary>>([]);
  const staleSessionBindings = yield* Ref.make(new Map<string, ProviderRuntimeBinding>());
  const staleSessionStopTimeoutMs = normalizePositiveInt(
    options?.staleSessionStopTimeoutMs,
    DEFAULT_STALE_SESSION_STOP_TIMEOUT_MS,
  );
  const maxConcurrentProviderStartsPerInstance = normalizePositiveInt(
    options?.providerStartupAdmission?.maxConcurrentStartsPerInstance,
    DEFAULT_MAX_CONCURRENT_PROVIDER_STARTS_PER_INSTANCE,
  );
  const maxPendingProviderStartsPerInstance = Math.max(
    maxConcurrentProviderStartsPerInstance,
    normalizePositiveInt(
      options?.providerStartupAdmission?.maxPendingStartsPerInstance,
      DEFAULT_MAX_PENDING_PROVIDER_STARTS_PER_INSTANCE,
    ),
  );
  const startupAdmissionState = yield* SynchronizedRef.make<ProviderStartupAdmissionState>({
    semaphores: new Map(),
    pendingByInstance: new Map(),
    highWaterByInstance: new Map(),
  });
  const sessionStartLocks = yield* SynchronizedRef.make(new Map<ThreadId, Semaphore.Semaphore>());

  const getSessionStartLock = (threadId: ThreadId) =>
    SynchronizedRef.modifyEffect(sessionStartLocks, (current) => {
      const existing = current.get(threadId);
      if (existing) {
        return Effect.succeed([existing, current] as const);
      }
      return Semaphore.make(1).pipe(
        Effect.map((semaphore) => {
          const next = new Map(current);
          next.set(threadId, semaphore);
          return [semaphore, next] as const;
        }),
      );
    });

  const withSessionStartLock = <A, E, R>(threadId: ThreadId, effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(getSessionStartLock(threadId), (semaphore) => semaphore.withPermit(effect));

  const serviceScope = yield* Effect.scope;

  // Every provider call below is bounded through runDetachedWithDeadline, which
  // forks the call into this layer scope so a deadline holds even when the
  // adapter cannot be interrupted.
  const timeouts = resolveProviderOperationTimeouts({
    env: process.env,
    overrides: options?.operationTimeouts,
  });
  if (timeouts.invalidEnv.length > 0) {
    yield* Effect.logWarning("provider.operation-timeouts.invalid-env", {
      ignored: timeouts.invalidEnv,
    });
  }

  const operationLabel = (instanceId: ProviderInstanceId) =>
    registry.getInstanceInfo(instanceId).pipe(
      Effect.map((info) => info.displayName ?? String(instanceId)),
      Effect.orElseSucceed(() => String(instanceId)),
    );

  const operationTimeoutError = (input: {
    readonly provider: string;
    readonly label: string;
    readonly operation: ProviderTimedOperation;
    readonly timeoutMs: number;
    readonly startPhase?: ProviderStartPhase;
  }) =>
    new ProviderOperationTimeoutError({
      provider: input.provider,
      operation: input.operation,
      timeoutMs: input.timeoutMs,
      detail: providerOperationTimeoutDetail(input),
    });

  /** Bounds one adapter control call (interrupt, stop, respond, goal sync). */
  const boundedControl = <A, E>(
    effect: Effect.Effect<A, E>,
    input: {
      readonly provider: string;
      readonly instanceId: ProviderInstanceId;
      readonly operation: ProviderTimedOperation;
    },
  ): Effect.Effect<A, E | ProviderOperationTimeoutError> =>
    Effect.gen(function* () {
      const label = yield* operationLabel(input.instanceId);
      return yield* runDetachedWithDeadline(effect, {
        scope: serviceScope,
        timeoutMs: timeouts.controlRequestMs,
        onTimeout: () =>
          operationTimeoutError({
            provider: input.provider,
            label,
            operation: input.operation,
            timeoutMs: timeouts.controlRequestMs,
          }),
      });
    });

  /**
   * Runs `effect` under the thread's start lock with the lock wait and the body
   * bounded together by the control deadline, detached. A start that never
   * releases the lock (an adapter start that cannot be interrupted) then makes a
   * binding update fail at its deadline instead of pinning its caller forever.
   */
  const withBoundedSessionStartLock = <A, E>(
    binding: ProviderRuntimeBinding,
    effect: Effect.Effect<A, E>,
  ): Effect.Effect<A, E | ProviderOperationTimeoutError> =>
    Effect.gen(function* () {
      const label =
        binding.providerInstanceId === undefined
          ? String(binding.provider)
          : yield* operationLabel(binding.providerInstanceId);
      return yield* runDetachedWithDeadline(withSessionStartLock(binding.threadId, effect), {
        scope: serviceScope,
        timeoutMs: timeouts.controlRequestMs,
        onTimeout: () =>
          operationTimeoutError({
            provider: binding.provider,
            label,
            operation: "session.lock",
            timeoutMs: timeouts.controlRequestMs,
          }),
      });
    });

  // The last provider activity per thread, for turn liveness. Process-local and
  // written on every runtime event (streaming deltas included), so it is a plain
  // map mutated in place inside Effect.sync; readers get a snapshot.
  const runtimeActivity = new Map<ThreadId, ProviderRuntimeActivity>();
  const recordRuntimeActivity = (threadId: ThreadId, runtimeSessionId: RuntimeSessionId) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((lastActivityAtMs) =>
        Effect.sync(() => {
          runtimeActivity.set(threadId, { threadId, runtimeSessionId, lastActivityAtMs });
        }),
      ),
    );
  const forgetRuntimeActivity = (threadId: ThreadId, runtimeSessionId?: RuntimeSessionId) =>
    Effect.sync(() => {
      const entry = runtimeActivity.get(threadId);
      if (!entry || (runtimeSessionId !== undefined && entry.runtimeSessionId !== runtimeSessionId))
        return;
      runtimeActivity.delete(threadId);
    });

  // `turn.started` waiters for "completion" adapters, keyed `threadId:runtimeSessionId`.
  // Mutated only inside Effect.sync.
  const acceptanceWaiters = new Map<string, Set<Deferred.Deferred<TurnId>>>();
  const acceptanceKey = (threadId: ThreadId, runtimeSessionId: RuntimeSessionId | undefined) =>
    `${threadId}:${runtimeSessionId ?? "legacy"}`;
  const registerAcceptanceWaiter = (
    threadId: ThreadId,
    runtimeSessionId: RuntimeSessionId | undefined,
  ) =>
    Deferred.make<TurnId>().pipe(
      Effect.tap((waiter) =>
        Effect.sync(() => {
          const key = acceptanceKey(threadId, runtimeSessionId);
          const waiters = acceptanceWaiters.get(key) ?? new Set();
          waiters.add(waiter);
          acceptanceWaiters.set(key, waiters);
        }),
      ),
    );
  const unregisterAcceptanceWaiter = (
    threadId: ThreadId,
    runtimeSessionId: RuntimeSessionId | undefined,
    waiter: Deferred.Deferred<TurnId>,
  ) =>
    Effect.sync(() => {
      const key = acceptanceKey(threadId, runtimeSessionId);
      const waiters = acceptanceWaiters.get(key);
      if (!waiters) return;
      waiters.delete(waiter);
      if (waiters.size === 0) acceptanceWaiters.delete(key);
    });
  const resolveAcceptanceWaiters = (event: ProviderRuntimeEvent) =>
    Effect.suspend(() => {
      if (event.type !== "turn.started" || event.turnId === undefined) return Effect.void;
      const turnId = event.turnId;
      const waiters = acceptanceWaiters.get(acceptanceKey(event.threadId, event.runtimeSessionId));
      if (!waiters || waiters.size === 0) return Effect.void;
      return Effect.forEach([...waiters], (waiter) => Deferred.succeed(waiter, turnId), {
        discard: true,
      });
    });

  // A completed turn can change the live resume cursor; Claude, for one, drops
  // its rewind marker on the first completed turn after a revert. Persist it
  // so a stop, idle reap, crash, or CLI exit resumes the conversation the agent
  // actually has. Forked under the session lock: it never stalls event
  // delivery and never interleaves with a rollback's own cursor write.
  const persistLiveResumeCursor = (instanceId: ProviderInstanceId, threadId: ThreadId) =>
    withSessionStartLock(
      threadId,
      Effect.gen(function* () {
        const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
        if (!binding || binding.providerInstanceId !== instanceId) return;
        const adapter = yield* registry.getByInstance(instanceId);
        const session = (yield* adapter.listSessions()).find((candidate) =>
          sessionMatchesBinding(
            { ...candidate, providerInstanceId: instanceId },
            instanceId,
            binding,
          ),
        );
        if (
          session?.resumeCursor === undefined ||
          JSON.stringify(session.resumeCursor) === JSON.stringify(binding.resumeCursor ?? null)
        ) {
          return;
        }
        yield* directory.upsert({
          threadId,
          provider: binding.provider,
          providerInstanceId: instanceId,
          resumeCursor: session.resumeCursor,
        });
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logWarning("provider.resume-cursor.persist-failed", {
              threadId,
              cause: Cause.pretty(cause),
            }),
      ),
      Effect.forkIn(serviceScope),
      Effect.asVoid,
    );

  const publishRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Effect.succeed(event).pipe(
      Effect.tap((canonicalEvent) =>
        canonicalEvent.providerInstanceId === undefined
          ? Effect.void
          : Ref.update(recentRuntimeEvents, (current) =>
              [
                {
                  eventId: canonicalEvent.eventId,
                  type: canonicalEvent.type,
                  threadId: canonicalEvent.threadId,
                  providerInstanceId: canonicalEvent.providerInstanceId!,
                  turnId: canonicalEvent.turnId ?? null,
                  occurredAt: canonicalEvent.createdAt,
                },
                ...current,
              ].slice(0, 500),
            ),
      ),
      Effect.tap((canonicalEvent) =>
        canonicalEventLogger
          ? canonicalEventLogger.write(canonicalEvent, canonicalEvent.threadId)
          : Effect.void,
      ),
      Effect.flatMap((canonicalEvent) => PubSub.publish(runtimeEventPubSub, canonicalEvent)),
      Effect.asVoid,
    );

  const providerStartupMetricAttrs = (input: {
    readonly provider: ProviderDriverKind | string;
    readonly providerInstanceId: ProviderInstanceId;
  }) =>
    metricAttributes({
      provider: input.provider,
      providerInstanceId: input.providerInstanceId,
      maxConcurrentStartsPerInstance: maxConcurrentProviderStartsPerInstance,
      maxPendingStartsPerInstance: maxPendingProviderStartsPerInstance,
    });

  const recordProviderStartupDepth = (input: {
    readonly provider: ProviderDriverKind | string;
    readonly providerInstanceId: ProviderInstanceId;
    readonly depth: number;
    readonly highWater: number;
  }) =>
    Effect.gen(function* () {
      const attributes = providerStartupMetricAttrs(input);
      yield* Metric.update(
        Metric.withAttributes(providerStartupQueueDepth, attributes),
        input.depth,
      );
      yield* Metric.update(
        Metric.withAttributes(providerStartupQueueHighWater, attributes),
        input.highWater,
      );
    });

  const withProviderStartupAdmission = <A, E, R>(input: {
    readonly operation: string;
    readonly provider: ProviderDriverKind | string;
    readonly providerInstanceId: ProviderInstanceId;
    readonly run: () => Effect.Effect<A, E, R>;
  }): Effect.Effect<A, E | ProviderValidationError, R> =>
    Effect.gen(function* () {
      const reservation = yield* SynchronizedRef.modifyEffect(startupAdmissionState, (state) => {
        const pending = state.pendingByInstance.get(input.providerInstanceId) ?? 0;
        if (pending >= maxPendingProviderStartsPerInstance) {
          return Effect.succeed([
            Option.none<{
              readonly semaphore: Semaphore.Semaphore;
              readonly depth: number;
              readonly highWater: number;
            }>(),
            state,
          ] as const);
        }

        const semaphoreEffect = state.semaphores.get(input.providerInstanceId)
          ? Effect.succeed(state.semaphores.get(input.providerInstanceId) as Semaphore.Semaphore)
          : Semaphore.make(maxConcurrentProviderStartsPerInstance);

        return semaphoreEffect.pipe(
          Effect.map((semaphore) => {
            const nextDepth = pending + 1;
            const nextHighWater = Math.max(
              state.highWaterByInstance.get(input.providerInstanceId) ?? 0,
              nextDepth,
            );
            const semaphores = new Map(state.semaphores);
            semaphores.set(input.providerInstanceId, semaphore);
            const pendingByInstance = new Map(state.pendingByInstance);
            pendingByInstance.set(input.providerInstanceId, nextDepth);
            const highWaterByInstance = new Map(state.highWaterByInstance);
            highWaterByInstance.set(input.providerInstanceId, nextHighWater);
            return [
              Option.some({
                semaphore,
                depth: nextDepth,
                highWater: nextHighWater,
              }),
              {
                semaphores,
                pendingByInstance,
                highWaterByInstance,
              },
            ] as const;
          }),
        );
      });

      if (Option.isNone(reservation)) {
        yield* increment(providerStartupAdmissionTotal, {
          provider: input.provider,
          providerInstanceId: input.providerInstanceId,
          operation: input.operation,
          outcome: "busy",
          maxConcurrentStartsPerInstance: maxConcurrentProviderStartsPerInstance,
          maxPendingStartsPerInstance: maxPendingProviderStartsPerInstance,
        });
        return yield* toValidationError(
          input.operation,
          `Provider startup admission is busy for instance '${input.providerInstanceId}' (${maxPendingProviderStartsPerInstance} pending starts).`,
        );
      }

      yield* recordProviderStartupDepth({
        provider: input.provider,
        providerInstanceId: input.providerInstanceId,
        depth: reservation.value.depth,
        highWater: reservation.value.highWater,
      });
      yield* increment(providerStartupAdmissionTotal, {
        provider: input.provider,
        providerInstanceId: input.providerInstanceId,
        operation: input.operation,
        outcome: "accepted",
        maxConcurrentStartsPerInstance: maxConcurrentProviderStartsPerInstance,
        maxPendingStartsPerInstance: maxPendingProviderStartsPerInstance,
      });

      const queuedAtMs = Date.now();
      const releaseReservation = SynchronizedRef.modify(startupAdmissionState, (state) => {
        const currentDepth = state.pendingByInstance.get(input.providerInstanceId) ?? 0;
        const nextDepth = Math.max(0, currentDepth - 1);
        const pendingByInstance = new Map(state.pendingByInstance);
        if (nextDepth === 0) {
          pendingByInstance.delete(input.providerInstanceId);
        } else {
          pendingByInstance.set(input.providerInstanceId, nextDepth);
        }
        return [
          {
            depth: nextDepth,
            highWater: state.highWaterByInstance.get(input.providerInstanceId) ?? 0,
          },
          {
            ...state,
            pendingByInstance,
          },
        ] as const;
      }).pipe(
        Effect.flatMap((snapshot) =>
          recordProviderStartupDepth({
            provider: input.provider,
            providerInstanceId: input.providerInstanceId,
            depth: snapshot.depth,
            highWater: snapshot.highWater,
          }),
        ),
      );

      return yield* reservation.value.semaphore
        .withPermits(1)(
          Effect.gen(function* () {
            yield* Metric.update(
              Metric.withAttributes(
                providerStartupQueueWaitDuration,
                metricAttributes({
                  ...Object.fromEntries(providerStartupMetricAttrs(input)),
                  operation: input.operation,
                }),
              ),
              Duration.millis(Math.max(0, Date.now() - queuedAtMs)),
            );
            return yield* input.run();
          }),
        )
        .pipe(Effect.ensuring(releaseReservation));
    });

  const requireBindingInstanceId = (
    operation: string,
    payload: {
      readonly providerInstanceId?: ProviderInstanceId | undefined;
      readonly provider?: ProviderDriverKind | undefined;
    },
  ): Effect.Effect<ProviderInstanceId, ProviderValidationError> =>
    payload.providerInstanceId !== undefined
      ? Effect.succeed(payload.providerInstanceId)
      : Effect.fail(
          toValidationError(
            operation,
            payload.provider
              ? `Provider instance id is required for provider '${payload.provider}'.`
              : "Provider instance id is required.",
          ),
        );

  const upsertSessionBinding = (
    session: ProviderSession,
    threadId: ThreadId,
    extra?: {
      readonly modelSelection?: unknown;
      readonly lastRuntimeEvent?: string;
      readonly lastRuntimeEventAt?: string;
    },
  ) =>
    Effect.gen(function* () {
      const providerInstanceId = yield* requireBindingInstanceId(
        "ProviderService.upsertSessionBinding",
        session,
      );
      yield* directory.upsert({
        threadId,
        provider: session.provider,
        providerInstanceId,
        ...(session.runtimeSessionId ? { runtimeSessionId: session.runtimeSessionId } : {}),
        runtimeMode: session.runtimeMode,
        status: toRuntimeStatus(session),
        ...(session.resumeCursor !== undefined ? { resumeCursor: session.resumeCursor } : {}),
        runtimePayload: toRuntimePayloadFromSession(session, extra),
      });
    });

  const processRuntimeEvent = (
    source: {
      readonly instanceId: ProviderInstanceId;
      readonly provider: ProviderDriverKind;
    },
    event: ProviderRuntimeEvent,
  ): Effect.Effect<void> =>
    Effect.sync(() => correlateRuntimeEventWithInstance(source, event)).pipe(
      Effect.flatMap((canonicalEvent) =>
        canonicalEvent.runtimeSessionId !== undefined
          ? Effect.succeed(canonicalEvent)
          : Effect.die(
              new Error(
                `ProviderService.streamEvents: provider instance '${source.instanceId}' emitted '${event.type}' without a runtime session id.`,
              ),
            ),
      ),
      Effect.flatMap((canonicalEvent) =>
        increment(providerRuntimeEventsTotal, {
          provider: canonicalEvent.provider,
          eventType: canonicalEvent.type,
        }).pipe(
          Effect.andThen(
            recordRuntimeActivity(canonicalEvent.threadId, canonicalEvent.runtimeSessionId!),
          ),
          Effect.andThen(resolveAcceptanceWaiters(canonicalEvent)),
          Effect.andThen(publishRuntimeEvent(canonicalEvent)),
          Effect.andThen(
            canonicalEvent.type === "turn.completed"
              ? persistLiveResumeCursor(source.instanceId, canonicalEvent.threadId)
              : Effect.void,
          ),
        ),
      ),
    );

  // `subscribedAdapters` is our source-of-truth for "which instance adapters
  // are currently wired into the runtime event bus". It both tracks the set
  // of live subscriptions (so `reconcileInstanceSubscriptions` can diff and
  // fork only the *new* or *rebuilt* ones) and serves as the dynamic adapter
  // list consumed by `listSessions` and `runStopAll` — replacing the
  // pre-Slice-D startup snapshot so hot-added
  // instances become visible to those call sites as soon as settings edits
  // land.
  const subscribedAdapters = yield* Ref.make(
    new Map<ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>>(),
  );

  const getAdapterEntries = Ref.get(subscribedAdapters).pipe(
    Effect.map((map) => Array.from(map.entries())),
  );

  const findExactAdapterSession = Effect.fn("findExactAdapterSession")(function* (
    binding: ProviderRuntimeBinding,
  ) {
    const instanceId = yield* requireBindingInstanceId(
      "ProviderService.findExactAdapterSession",
      binding,
    );
    const adapter = yield* registry.getByInstance(instanceId);
    const sessions = yield* adapter.listSessions();
    const session = sessions.find((candidate) =>
      sessionMatchesBinding({ ...candidate, providerInstanceId: instanceId }, instanceId, binding),
    );
    return { adapter, instanceId, session } as const;
  });

  const rememberStaleBinding = (binding: ProviderRuntimeBinding) =>
    Ref.update(staleSessionBindings, (current) => {
      const next = new Map(current);
      next.set(bindingKey(binding), binding);
      return next;
    });

  const forgetStaleBinding = (binding: ProviderRuntimeBinding) =>
    Ref.update(staleSessionBindings, (current) => {
      const next = new Map(current);
      next.delete(bindingKey(binding));
      return next;
    });

  const stopExactBinding = Effect.fn("stopExactBinding")(function* (
    binding: ProviderRuntimeBinding,
    queueOnTimeout: boolean,
  ) {
    const exact = yield* findExactAdapterSession(binding);
    if (!exact.session) {
      yield* forgetStaleBinding(binding);
      yield* forgetRuntimeActivity(binding.threadId, binding.runtimeSessionId);
      return "not-found" as ProviderSessionBindingStopResult;
    }

    // Detached: the deadline holds even when the adapter stop cannot be interrupted.
    const stopped = yield* runDetachedWithDeadlineOption(
      exact.adapter.stopSession(binding.threadId),
      { scope: serviceScope, timeoutMs: staleSessionStopTimeoutMs },
    ).pipe(Effect.onError(() => (queueOnTimeout ? rememberStaleBinding(binding) : Effect.void)));
    if (Option.isNone(stopped)) {
      if (queueOnTimeout) {
        yield* rememberStaleBinding(binding);
      }
      yield* Effect.logWarning("provider.session.stop-stale-timeout", {
        provider: binding.provider,
        staleSessionStopTimeoutMs,
      });
      yield* increment(providerStaleStopTimeoutsTotal, {
        provider: binding.provider,
      });
      return "timed-out" as ProviderSessionBindingStopResult;
    }

    yield* forgetStaleBinding(binding);
    yield* forgetRuntimeActivity(binding.threadId, binding.runtimeSessionId);
    return "stopped" as ProviderSessionBindingStopResult;
  });

  // A lock held past the control deadline counts as a stop that timed out: the
  // binding stays queued for the reaper's stale retry.
  const stopSessionBinding: ProviderServiceShape["stopSessionBinding"] = (binding) =>
    withBoundedSessionStartLock(binding, stopExactBinding(binding, true)).pipe(
      Effect.catchIf(Schema.is(ProviderOperationTimeoutError), () =>
        rememberStaleBinding(binding).pipe(
          Effect.as("timed-out" as ProviderSessionBindingStopResult),
        ),
      ),
    );

  const listStaleSessionBindings: ProviderServiceShape["listStaleSessionBindings"] = () =>
    Ref.get(staleSessionBindings).pipe(Effect.map((bindings) => [...bindings.values()]));

  // Rebuild the map of id → adapter from the registry and fork a new event
  // subscription for every instance that is either brand new or whose adapter
  // identity changed (indicating the underlying `ProviderInstance` was torn
  // down and rebuilt by `ProviderInstanceRegistry.reconcile`). Orphaned
  // fibers for removed/replaced instances exit on their own because their
  // adapter's `streamEvents` source terminates when the old scope closes.
  const reconcileInstanceSubscriptions = Effect.gen(function* () {
    const previous = yield* Ref.get(subscribedAdapters);
    const currentIds = yield* registry.listInstances();
    const next = new Map<ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>>();
    for (const id of currentIds) {
      const adapterOption = yield* registry
        .getByInstance(id)
        .pipe(Effect.tapError(Effect.logWarning), Effect.option);
      if (Option.isNone(adapterOption)) continue;
      const adapter = adapterOption.value;
      next.set(id, adapter);
      if (previous.get(id) !== adapter) {
        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          processRuntimeEvent(
            {
              instanceId: id,
              provider: adapter.provider,
            },
            event,
          ),
        ).pipe(Effect.forkScoped);
      }
    }
    yield* Ref.set(subscribedAdapters, next);
  });

  const instanceChanges = yield* registry.subscribeChanges;
  yield* reconcileInstanceSubscriptions;
  yield* Stream.runForEach(
    Stream.fromSubscription(instanceChanges),
    () => reconcileInstanceSubscriptions,
  ).pipe(Effect.forkScoped);

  const recoverSessionForThread = Effect.fn("recoverSessionForThread")(function* (input: {
    readonly binding: ProviderRuntimeBinding;
    readonly operation: string;
  }) {
    const bindingInstanceId = yield* requireBindingInstanceId(input.operation, input.binding);
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "recover-session",
      "provider.kind": input.binding.provider,
      "provider.instance_id": bindingInstanceId,
      "provider.thread_id": input.binding.threadId,
    });
    return yield* Effect.gen(function* () {
      const adapter = yield* registry.getByInstance(bindingInstanceId);
      const runtimeSessionId =
        input.binding.runtimeSessionId ??
        RuntimeSessionId.make(yield* Effect.sync(() => crypto.randomUUID()));
      const hasResumeCursor =
        input.binding.resumeCursor !== null && input.binding.resumeCursor !== undefined;
      const activeSessions = yield* adapter.listSessions();
      const existing = activeSessions.find((session) =>
        sessionMatchesBinding(
          { ...session, providerInstanceId: bindingInstanceId },
          bindingInstanceId,
          { ...input.binding, runtimeSessionId },
        ),
      );
      if (existing) {
        yield* upsertSessionBinding(
          { ...existing, providerInstanceId: bindingInstanceId, runtimeSessionId },
          input.binding.threadId,
        );
        yield* analytics.record("provider.session.recovered", {
          provider: existing.provider,
          strategy: "adopt-existing",
          hasResumeCursor: existing.resumeCursor !== undefined,
        });
        return { adapter, session: existing } as const;
      }

      if (!hasResumeCursor) {
        return yield* toValidationError(
          input.operation,
          `Cannot recover thread '${input.binding.threadId}' because no provider resume state is persisted.`,
        );
      }

      const persistedCwd = readPersistedCwd(input.binding.runtimePayload);
      const persistedModelSelection = readPersistedModelSelection(input.binding.runtimePayload);
      const recoveredBinding: ProviderRuntimeBinding = {
        threadId: input.binding.threadId,
        provider: input.binding.provider,
        providerInstanceId: bindingInstanceId,
        runtimeSessionId,
      };

      // A recovery abandoned at its deadline must not leave the resumed runtime behind.
      const resumed = yield* Effect.gen(function* () {
        const resumedSession = yield* withProviderStartupAdmission({
          operation: input.operation,
          provider: input.binding.provider,
          providerInstanceId: bindingInstanceId,
          run: () =>
            adapter.startSession({
              threadId: input.binding.threadId,
              provider: input.binding.provider,
              providerInstanceId: bindingInstanceId,
              runtimeSessionId,
              resumePolicy: "compatible",
              ...(persistedCwd ? { cwd: persistedCwd } : {}),
              ...(persistedModelSelection ? { modelSelection: persistedModelSelection } : {}),
              ...(hasResumeCursor ? { resumeCursor: input.binding.resumeCursor } : {}),
              runtimeMode: input.binding.runtimeMode ?? "full-access",
            }),
        });
        if (resumedSession.provider !== adapter.provider) {
          return yield* toValidationError(
            input.operation,
            `Adapter/provider mismatch while recovering thread '${input.binding.threadId}'. Expected '${adapter.provider}', received '${resumedSession.provider}'.`,
          );
        }
        if (resumedSession.runtimeSessionId !== runtimeSessionId) {
          return yield* toValidationError(
            input.operation,
            `Adapter runtime mismatch while recovering thread '${input.binding.threadId}'. Expected '${runtimeSessionId}', received '${resumedSession.runtimeSessionId ?? "missing"}'.`,
          );
        }

        yield* upsertSessionBinding(
          { ...resumedSession, providerInstanceId: bindingInstanceId, runtimeSessionId },
          input.binding.threadId,
        );
        return resumedSession;
      }).pipe(
        Effect.onInterrupt(() => stopExactBinding(recoveredBinding, true).pipe(Effect.ignore)),
      );
      yield* recordRuntimeActivity(input.binding.threadId, runtimeSessionId);
      yield* analytics.record("provider.session.recovered", {
        provider: resumed.provider,
        strategy: "resume-thread",
        hasResumeCursor: resumed.resumeCursor !== undefined,
      });
      return { adapter, session: resumed } as const;
    }).pipe(
      withMetrics({
        counter: providerSessionsTotal,
        attributes: providerMetricAttributes(input.binding.provider, {
          operation: "recover",
        }),
      }),
    );
  });

  const resolveRoutableSessionUnlocked = Effect.fn("resolveRoutableSession")(function* (input: {
    readonly threadId: ThreadId;
    readonly operation: string;
    readonly allowRecovery: boolean;
  }) {
    const bindingOption = yield* directory.getBinding(input.threadId);
    const binding = Option.getOrUndefined(bindingOption);
    if (!binding) {
      return yield* toValidationError(
        input.operation,
        `Cannot route thread '${input.threadId}' because no persisted provider binding exists.`,
      );
    }
    const instanceId = yield* requireBindingInstanceId(input.operation, binding);
    const adapter = yield* registry.getByInstance(instanceId);

    const activeSessions = yield* adapter.listSessions();
    const requestedSession = activeSessions.find((session) =>
      sessionMatchesBinding({ ...session, providerInstanceId: instanceId }, instanceId, binding),
    );
    if (requestedSession) {
      return {
        adapter,
        instanceId,
        threadId: input.threadId,
        session: { ...requestedSession, providerInstanceId: instanceId },
        isActive: true,
      } as const;
    }

    if (!input.allowRecovery) {
      return {
        adapter,
        instanceId,
        threadId: input.threadId,
        session: undefined,
        isActive: false,
      } as const;
    }

    const recovered = yield* recoverSessionForThread({
      binding,
      operation: input.operation,
    });
    return {
      adapter: recovered.adapter,
      instanceId,
      threadId: input.threadId,
      session: recovered.session,
      isActive: true,
    } as const;
  });

  // Recovery shares the session-start exclusion boundary. Lock wait plus recovery
  // start are bounded together by the driver's start deadline, detached so the
  // deadline holds even when the adapter start cannot be interrupted.
  const resolveRoutableSession = (input: Parameters<typeof resolveRoutableSessionUnlocked>[0]) =>
    input.allowRecovery
      ? Effect.gen(function* () {
          const binding = Option.getOrUndefined(yield* directory.getBinding(input.threadId));
          if (!binding?.providerInstanceId) {
            return yield* resolveRoutableSessionUnlocked(input);
          }
          const instanceId = binding.providerInstanceId;
          const label = yield* operationLabel(instanceId);
          const timeoutMs = timeouts.sessionStartMs(binding.provider);
          return yield* runDetachedWithDeadline(
            withSessionStartLock(input.threadId, resolveRoutableSessionUnlocked(input)),
            {
              scope: serviceScope,
              timeoutMs,
              onTimeout: () =>
                operationTimeoutError({
                  provider: binding.provider,
                  label,
                  operation: "session.recover",
                  timeoutMs,
                }),
            },
          );
        })
      : resolveRoutableSessionUnlocked(input);

  const getSession: ProviderServiceShape["getSession"] = Effect.fn("getSession")(
    function* (threadId) {
      const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      if (!binding) {
        return Option.none<ProviderSession>();
      }
      const exact = yield* findExactAdapterSession(binding);
      return exact.session
        ? Option.some({ ...exact.session, providerInstanceId: exact.instanceId })
        : Option.none<ProviderSession>();
    },
  );

  const restoreSessionBinding: ProviderServiceShape["restoreSessionBinding"] = Effect.fn(
    "restoreSessionBinding",
  )((binding) =>
    withBoundedSessionStartLock(
      binding,
      Effect.gen(function* () {
        const exact = yield* findExactAdapterSession(binding);
        if (!exact.session) {
          return false;
        }
        yield* directory.upsert(binding);
        return true;
      }),
    ),
  );

  const retireSessionBinding: ProviderServiceShape["retireSessionBinding"] = Effect.fn(
    "retireSessionBinding",
  )(function* (binding) {
    if (binding.providerInstanceId === undefined || binding.runtimeSessionId === undefined) {
      return false;
    }
    return yield* withBoundedSessionStartLock(
      binding,
      Effect.gen(function* () {
        const current = Option.getOrUndefined(yield* directory.getBinding(binding.threadId));
        if (!current || !bindingIdentityMatches(current, binding)) {
          return false;
        }
        yield* directory.upsert({
          ...current,
          status: "stopped",
          resumeCursor: null,
          runtimePayload: null,
        });
        return true;
      }),
    );
  });

  /**
   * Stops the exact runtime of a start nobody waits for any more, and marks its
   * binding stopped if the directory still points at it. Never fails. Callers
   * hold the thread's start lock.
   */
  const stopAbandonedStart = (binding: ProviderRuntimeBinding): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* stopExactBinding(binding, true);
      const current = Option.getOrUndefined(yield* directory.getBinding(binding.threadId));
      if (current && bindingIdentityMatches(current, binding)) {
        yield* directory.upsert({
          threadId: binding.threadId,
          provider: binding.provider,
          providerInstanceId: binding.providerInstanceId!,
          runtimeSessionId: binding.runtimeSessionId!,
          status: "stopped",
          runtimePayload: { activeTurnId: null },
        });
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider.session.abandoned-start-cleanup-failed", {
          threadId: binding.threadId,
          provider: binding.provider,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const startSession: ProviderServiceShape["startSession"] = Effect.fn("startSession")(
    function* (threadId, rawInput) {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderService.startSession",
        schema: ProviderSessionStartInput,
        payload: rawInput,
      });
      const resolvedInstanceId = yield* requireBindingInstanceId(
        "ProviderService.startSession",
        parsed,
      );
      let metricProvider = parsed.provider ?? String(resolvedInstanceId);
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "start-session",
        "provider.instance_id": resolvedInstanceId,
        "provider.thread_id": threadId,
        "provider.runtime_mode": parsed.runtimeMode,
      });
      // Hoisted out of the lock: the driver kind picks the start deadline, and the
      // runtime id identifies a runtime this start must undo if it is abandoned.
      const instanceInfo = yield* registry.getInstanceInfo(resolvedInstanceId);
      const runtimeSessionId =
        parsed.runtimeSessionId ??
        RuntimeSessionId.make(yield* Effect.sync(() => crypto.randomUUID()));
      const startedBinding: ProviderRuntimeBinding = {
        threadId,
        provider: instanceInfo.driverKind,
        providerInstanceId: resolvedInstanceId,
        runtimeSessionId,
      };
      const timeoutMs = timeouts.sessionStartMs(instanceInfo.driverKind);
      // Where the start is waiting, for the timeout text.
      const progress: { phase: ProviderStartPhase } = { phase: "lock" };
      const startLocked = Effect.gen(function* () {
        progress.phase = "admission";
        const resolvedProvider = instanceInfo.driverKind;
        metricProvider = resolvedProvider;
        if (parsed.provider !== undefined && parsed.provider !== resolvedProvider) {
          return yield* toValidationError(
            "ProviderService.startSession",
            `Provider instance '${resolvedInstanceId}' belongs to driver '${resolvedProvider}', not '${parsed.provider}'.`,
          );
        }
        const input = {
          ...parsed,
          threadId,
          provider: resolvedProvider,
          runtimeSessionId,
        };
        if (!instanceInfo.enabled) {
          return yield* toValidationError(
            "ProviderService.startSession",
            `Provider instance '${resolvedInstanceId}' is disabled in Ryco settings.`,
          );
        }
        const persistedBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
        if (
          persistedBinding?.providerInstanceId === resolvedInstanceId &&
          persistedBinding.runtimeSessionId !== undefined &&
          persistedBinding.runtimeSessionId !== input.runtimeSessionId
        ) {
          const stopped = yield* stopExactBinding(persistedBinding, false);
          if (stopped === "timed-out") {
            return yield* toValidationError(
              "ProviderService.startSession",
              `Cannot replace runtime '${persistedBinding.runtimeSessionId}' on provider instance '${resolvedInstanceId}' because it did not stop within ${staleSessionStopTimeoutMs}ms.`,
            );
          }
          // The replaced runtime is gone even if this start fails or is cancelled.
          // Same identity, so the directory keeps its resume cursor.
          yield* directory.upsert({
            threadId,
            provider: persistedBinding.provider,
            providerInstanceId: resolvedInstanceId,
            runtimeSessionId: persistedBinding.runtimeSessionId,
            status: "stopped",
            runtimePayload: { activeTurnId: null },
          });
        }
        const freshStart = input.resumePolicy === "fresh";
        const effectiveResumeCursor = freshStart
          ? undefined
          : (input.resumeCursor ??
            (persistedBinding?.providerInstanceId === resolvedInstanceId
              ? (persistedBinding.resumeCursor ?? undefined)
              : undefined));
        const effectiveCwd =
          input.cwd ??
          (persistedBinding?.providerInstanceId === resolvedInstanceId
            ? readPersistedCwd(persistedBinding.runtimePayload)
            : undefined);
        if (effectiveCwd && Option.isSome(storageSql)) {
          const release = yield* acquireStoragePathUseLease(storageSql.value, effectiveCwd).pipe(
            Effect.mapError((cause) =>
              toValidationError(
                "ProviderService.startSession",
                cause instanceof Error ? cause.message : "Cannot establish checkout readiness.",
              ),
            ),
          );
          yield* Effect.addFinalizer(() => release);
        }
        yield* Effect.annotateCurrentSpan({
          "provider.kind": resolvedProvider,
          "provider.resume_cursor.source":
            input.resumeCursor !== undefined
              ? "request"
              : effectiveResumeCursor !== undefined &&
                  persistedBinding?.providerInstanceId === resolvedInstanceId
                ? "persisted"
                : "none",
          "provider.resume_cursor.present": effectiveResumeCursor !== undefined,
          "provider.cwd.source":
            input.cwd !== undefined
              ? "request"
              : effectiveCwd !== undefined &&
                  persistedBinding?.providerInstanceId === resolvedInstanceId
                ? "persisted"
                : "none",
          "provider.cwd.effective": effectiveCwd ?? "",
        });
        const adapter = yield* registry.getByInstance(resolvedInstanceId);
        const { resumeCursor: _ignoredResumeCursor, ...inputWithoutResumeCursor } = input;
        const startInput = {
          ...inputWithoutResumeCursor,
          providerInstanceId: resolvedInstanceId,
          ...(effectiveCwd !== undefined ? { cwd: effectiveCwd } : {}),
          ...(effectiveResumeCursor !== undefined ? { resumeCursor: effectiveResumeCursor } : {}),
        };
        // An interrupt from here to the end of the start (a deadline or a Stop)
        // must not leave the new runtime behind: stop exactly that runtime. An
        // interrupted fiber exits Interrupted, never Success, so onAbandon below
        // cannot undo it; this region must reach the last step.
        return yield* Effect.gen(function* () {
          const session = yield* withProviderStartupAdmission({
            operation: "ProviderService.startSession",
            provider: resolvedProvider,
            providerInstanceId: resolvedInstanceId,
            run: () =>
              Effect.suspend(() => {
                progress.phase = "adapter";
                return adapter.startSession(startInput);
              }),
          });

          if (session.provider !== adapter.provider) {
            return yield* toValidationError(
              "ProviderService.startSession",
              `Adapter/provider mismatch: requested '${adapter.provider}', received '${session.provider}'.`,
            );
          }
          if (session.runtimeSessionId !== input.runtimeSessionId) {
            return yield* toValidationError(
              "ProviderService.startSession",
              `Adapter runtime mismatch: requested '${input.runtimeSessionId}', received '${session.runtimeSessionId ?? "missing"}'.`,
            );
          }
          const started = {
            ...session,
            providerInstanceId: resolvedInstanceId,
            runtimeSessionId: input.runtimeSessionId,
          };

          yield* upsertSessionBinding(started, threadId, {
            modelSelection: input.modelSelection,
          });
          yield* recordRuntimeActivity(threadId, runtimeSessionId);
          if (
            !freshStart &&
            persistedBinding !== undefined &&
            (persistedBinding.providerInstanceId !== resolvedInstanceId ||
              persistedBinding.runtimeSessionId !== input.runtimeSessionId)
          ) {
            // Compatible starts retain replacement cleanup, but it is bounded and
            // retryable. Fresh handoffs defer cleanup until target acceptance so
            // the exact source binding remains available for rollback. Cut short,
            // the reaper's stale retry finishes it.
            yield* stopExactBinding(persistedBinding, true).pipe(
              Effect.onInterrupt(() => rememberStaleBinding(persistedBinding)),
            );
          }
          yield* analytics.record("provider.session.started", {
            provider: started.provider,
            runtimeMode: input.runtimeMode,
            hasResumeCursor: started.resumeCursor !== undefined,
            hasCwd: typeof effectiveCwd === "string" && effectiveCwd.trim().length > 0,
            hasModel:
              typeof input.modelSelection?.model === "string" &&
              input.modelSelection.model.trim().length > 0,
          });
          return started;
        }).pipe(Effect.onInterrupt(() => stopAbandonedStart(startedBinding)));
      }).pipe(
        Effect.scoped,
        withMetrics({
          counter: providerSessionsTotal,
          attributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "start",
            }),
        }),
      );
      const label = instanceInfo.displayName ?? String(resolvedInstanceId);
      // The lock wait, admission and adapter start share one deadline. The lock and
      // the admission permit are taken inside the detached fiber and released only
      // when it exits, so "one adapter start per thread at a time" still holds.
      return yield* runDetachedWithDeadline(withSessionStartLock(threadId, startLocked), {
        scope: serviceScope,
        timeoutMs,
        onTimeout: () =>
          operationTimeoutError({
            provider: instanceInfo.driverKind,
            label,
            operation: "session.start",
            timeoutMs,
            startPhase: progress.phase,
          }),
        // A start that completed after the caller stopped waiting is undone.
        onAbandon: (exit) =>
          Exit.isSuccess(exit)
            ? withSessionStartLock(threadId, stopAbandonedStart(startedBinding))
            : Effect.void,
      });
    },
  );

  const startFreshSession: ProviderServiceShape["startFreshSession"] = Effect.fn(
    "startFreshSession",
  )(function* (threadId, input: ProviderFreshSessionStartInput) {
    const previousBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
    const session = yield* startSession(threadId, {
      ...input,
      threadId,
      resumePolicy: "fresh",
    });
    return {
      session,
      ...(previousBinding ? { previousBinding } : {}),
    };
  });

  type RoutedSession = Effect.Success<ReturnType<typeof resolveRoutableSessionUnlocked>>;

  /** Interrupts one exact late turn, bounded; errors are logged. */
  const interruptLateTurn = (routed: RoutedSession, turnId: TurnId): Effect.Effect<void> =>
    boundedControl(routed.adapter.interruptTurn(routed.threadId, turnId), {
      provider: routed.adapter.provider,
      instanceId: routed.instanceId,
      operation: "turn.interrupt",
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider.turn.late-acceptance-interrupt-failed", {
          threadId: routed.threadId,
          turnId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  /**
   * Submits a turn with the acceptance deadline. "acceptance" adapters are bounded
   * as a whole; "completion" adapters only until their `turn.started` for the
   * routed runtime is observed (or the call exits), then awaited without deadline.
   * Both races only observe the adapter fiber, so they never wait on it.
   */
  const submitTurn = (
    routed: RoutedSession,
    input: ProviderSendTurnInput,
  ): Effect.Effect<ProviderTurnStartResult, ProviderServiceError> =>
    Effect.gen(function* () {
      const label = yield* operationLabel(routed.instanceId);
      const timeoutMs = timeouts.turnAcceptanceMs;
      const turnTimeout = () =>
        operationTimeoutError({
          provider: routed.adapter.provider,
          label,
          operation: "turn.start",
          timeoutMs,
        });
      const mode = routed.adapter.capabilities.turnSubmission ?? "acceptance";
      if (mode === "acceptance") {
        return yield* runDetachedWithDeadline(routed.adapter.sendTurn(input), {
          scope: serviceScope,
          timeoutMs,
          onTimeout: turnTimeout,
          // The request may already have reached the provider: give it one more
          // acceptance window to answer, so a late acceptance is seen and its
          // turn interrupted ("Ryco cancelled the request" stays true), instead
          // of cutting the call and leaving a turn nobody waits for.
          abandonGraceMs: timeoutMs,
          onAbandon: (exit) =>
            Exit.isSuccess(exit) ? interruptLateTurn(routed, exit.value.turnId) : Effect.void,
        });
      }
      const runtimeSessionId = routed.session?.runtimeSessionId;
      // Registered before the adapter call, so its turn.started cannot be missed.
      return yield* Effect.acquireUseRelease(
        registerAcceptanceWaiter(routed.threadId, runtimeSessionId),
        (accepted) =>
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const fiber = yield* Effect.forkIn(routed.adapter.sendTurn(input), serviceScope, {
                startImmediately: true,
              });
              const abandon = Effect.forkIn(Fiber.interrupt(fiber), serviceScope).pipe(
                Effect.asVoid,
              );
              const first = yield* restore(
                Effect.raceFirst(
                  Deferred.await(accepted).pipe(Effect.as("accepted" as const)),
                  Fiber.await(fiber).pipe(Effect.as("exited" as const)),
                ).pipe(Effect.timeoutOption(Duration.millis(timeoutMs))),
              ).pipe(Effect.onInterrupt(() => abandon));
              if (Option.isNone(first)) {
                yield* abandon;
                return yield* Effect.fail(turnTimeout());
              }
              if (first.value === "accepted" && runtimeSessionId !== undefined) {
                yield* recordRuntimeActivity(routed.threadId, runtimeSessionId);
              }
              return yield* restore(Fiber.join(fiber)).pipe(Effect.onInterrupt(() => abandon));
            }),
          ),
        (accepted) => unregisterAcceptanceWaiter(routed.threadId, runtimeSessionId, accepted),
      );
    });

  const sendTurn: ProviderServiceShape["sendTurn"] = Effect.fn("sendTurn")(function* (rawInput) {
    const parsed = yield* decodeInputOrValidationError({
      operation: "ProviderService.sendTurn",
      schema: ProviderSendTurnInput,
      payload: rawInput,
    });

    const input = {
      ...parsed,
      attachments: parsed.attachments ?? [],
    };
    if (!input.input && input.attachments.length === 0) {
      return yield* toValidationError(
        "ProviderService.sendTurn",
        "Either input text or at least one attachment is required",
      );
    }
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "send-turn",
      "provider.thread_id": input.threadId,
      "provider.interaction_mode": input.interactionMode,
      "provider.attachment_count": input.attachments.length,
    });
    let metricProvider = "unknown";
    let metricModel = input.modelSelection?.model;
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.sendTurn",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      metricModel = input.modelSelection?.model;
      yield* Effect.annotateCurrentSpan({
        "provider.kind": routed.adapter.provider,
        ...(input.modelSelection?.model ? { "provider.model": input.modelSelection.model } : {}),
      });
      const turn = yield* submitTurn(routed, {
        ...input,
        input: `${ASSISTANT_ATTACHMENT_INSTRUCTIONS}\n\n${input.input ?? ""}`,
      });
      if (routed.session?.runtimeSessionId) {
        yield* recordRuntimeActivity(input.threadId, routed.session.runtimeSessionId);
      }
      yield* directory.upsert({
        threadId: input.threadId,
        provider: routed.adapter.provider,
        providerInstanceId: routed.instanceId,
        ...(routed.session?.runtimeSessionId
          ? { runtimeSessionId: routed.session.runtimeSessionId }
          : {}),
        status: "running",
        ...(turn.resumeCursor !== undefined ? { resumeCursor: turn.resumeCursor } : {}),
        runtimePayload: {
          ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
          activeTurnId: turn.turnId,
          lastRuntimeEvent: "provider.sendTurn",
          lastRuntimeEventAt: new Date().toISOString(),
        },
      });
      yield* analytics.record("provider.turn.sent", {
        provider: routed.adapter.provider,
        model: input.modelSelection?.model,
        interactionMode: input.interactionMode,
        attachmentCount: input.attachments.length,
        hasInput: typeof input.input === "string" && input.input.trim().length > 0,
      });
      return turn;
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        timer: providerTurnDuration,
        attributes: () =>
          providerTurnMetricAttributes({
            provider: metricProvider,
            model: metricModel,
            extra: {
              operation: "send",
            },
          }),
      }),
    );
  });

  const setThreadGoal: NonNullable<ProviderServiceShape["setThreadGoal"]> = Effect.fn(
    "setThreadGoal",
  )(function* (threadId, goal) {
    const routed = yield* resolveRoutableSession({
      threadId,
      operation: "ProviderService.setThreadGoal",
      allowRecovery: false,
    });
    if (!routed.isActive) return yield* new ProviderSessionNotFoundError({ threadId });
    if (routed.adapter.setThreadGoal === undefined) {
      return false;
    }
    return yield* boundedControl(routed.adapter.setThreadGoal(threadId, goal), {
      provider: routed.adapter.provider,
      instanceId: routed.instanceId,
      operation: "goal.sync",
    });
  });

  const getThreadGoal: NonNullable<ProviderServiceShape["getThreadGoal"]> = Effect.fn(
    "getThreadGoal",
  )(function* (threadId) {
    const routed = yield* resolveRoutableSession({
      threadId,
      operation: "ProviderService.getThreadGoal",
      allowRecovery: false,
    });
    if (!routed.isActive) return yield* new ProviderSessionNotFoundError({ threadId });
    if (routed.adapter.getThreadGoal === undefined) return false;
    return yield* boundedControl(routed.adapter.getThreadGoal(threadId), {
      provider: routed.adapter.provider,
      instanceId: routed.instanceId,
      operation: "goal.sync",
    });
  });

  const clearThreadGoal: NonNullable<ProviderServiceShape["clearThreadGoal"]> = Effect.fn(
    "clearThreadGoal",
  )(function* (threadId) {
    const routed = yield* resolveRoutableSession({
      threadId,
      operation: "ProviderService.clearThreadGoal",
      allowRecovery: false,
    });
    if (!routed.isActive) return yield* new ProviderSessionNotFoundError({ threadId });
    if (routed.adapter.clearThreadGoal === undefined) {
      return false;
    }
    yield* boundedControl(routed.adapter.clearThreadGoal(threadId), {
      provider: routed.adapter.provider,
      instanceId: routed.instanceId,
      operation: "goal.sync",
    });
    return true;
  });

  const steerTurn: ProviderServiceShape["steerTurn"] = Effect.fn("steerTurn")(function* (rawInput) {
    const parsed = yield* decodeInputOrValidationError({
      operation: "ProviderService.steerTurn",
      schema: ProviderSteerTurnInput,
      payload: rawInput,
    });
    const input = { ...parsed, attachments: parsed.attachments ?? [] };
    if (!input.input && input.attachments.length === 0) {
      return yield* toValidationError(
        "ProviderService.steerTurn",
        "Either input text or at least one attachment is required",
      );
    }
    const routed = yield* resolveRoutableSession({
      threadId: input.threadId,
      operation: "ProviderService.steerTurn",
      allowRecovery: false,
    });
    if (!routed.isActive || routed.session === undefined) {
      return yield* new ProviderSessionNotFoundError({ threadId: input.threadId });
    }
    // Both refusals defer: the message stays queued and is sent as the next turn.
    if (routed.session.activeTurnId !== input.expectedTurnId) {
      return yield* new ProviderTurnNotSteerableError({
        provider: routed.adapter.provider,
        threadId: input.threadId,
        turnId: input.expectedTurnId,
        reason: "turn-ended",
        detail:
          "The turn finished before this message could be steered. It stays queued and is sent next.",
      });
    }
    const steer = routed.adapter.steerTurn;
    if (routed.adapter.capabilities.turnSteering !== "native" || steer === undefined) {
      const displayName =
        PROVIDER_DISPLAY_NAMES[routed.adapter.provider] ?? routed.adapter.provider;
      return yield* new ProviderTurnNotSteerableError({
        provider: routed.adapter.provider,
        threadId: input.threadId,
        turnId: input.expectedTurnId,
        reason: "unsupported",
        detail: `${displayName} can't steer a running turn. The message stays queued.`,
      });
    }
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "steer-turn",
      "provider.kind": routed.adapter.provider,
      "provider.thread_id": input.threadId,
      "provider.turn_id": input.expectedTurnId,
      "provider.attachment_count": input.attachments.length,
    });
    const result = yield* steer(input);
    if (result.turnId !== input.expectedTurnId) {
      return yield* toValidationError(
        "ProviderService.steerTurn",
        `Provider returned turn '${result.turnId}' for expected turn '${input.expectedTurnId}'.`,
      );
    }
    yield* directory.upsert({
      threadId: input.threadId,
      provider: routed.adapter.provider,
      providerInstanceId: routed.instanceId,
      ...(routed.session.runtimeSessionId
        ? { runtimeSessionId: routed.session.runtimeSessionId }
        : {}),
      status: "running",
      runtimePayload: {
        activeTurnId: input.expectedTurnId,
        lastRuntimeEvent: "provider.steerTurn",
        lastRuntimeEventAt: new Date().toISOString(),
      },
    });
    if (routed.session.runtimeSessionId) {
      yield* recordRuntimeActivity(input.threadId, routed.session.runtimeSessionId);
    }
    yield* analytics.record("provider.turn.steered", {
      provider: routed.adapter.provider,
      attachmentCount: input.attachments.length,
      hasInput: typeof input.input === "string" && input.input.trim().length > 0,
    });
    return result;
  });

  const interruptTurn: ProviderServiceShape["interruptTurn"] = Effect.fn("interruptTurn")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.interruptTurn",
        schema: ProviderInterruptTurnInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        // Never recovers and takes no start lock: an interrupt must not resurrect a
        // dead runtime just to interrupt it, nor wait behind a start in progress.
        if (Option.isNone(yield* directory.getBinding(input.threadId))) {
          return yield* new ProviderSessionNotFoundError({ threadId: input.threadId });
        }
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.interruptTurn",
          allowRecovery: false,
        });
        metricProvider = routed.adapter.provider;
        if (!routed.isActive) {
          return yield* new ProviderSessionNotFoundError({ threadId: input.threadId });
        }
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "interrupt-turn",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
          "provider.turn_id": input.turnId,
        });
        yield* boundedControl(routed.adapter.interruptTurn(routed.threadId, input.turnId), {
          provider: routed.adapter.provider,
          instanceId: routed.instanceId,
          operation: "turn.interrupt",
        });
        yield* analytics.record("provider.turn.interrupted", {
          provider: routed.adapter.provider,
        });
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "interrupt",
            }),
        }),
      );
    },
  );

  const stopBackgroundTask: ProviderServiceShape["stopBackgroundTask"] = Effect.fn(
    "stopBackgroundTask",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.stopBackgroundTask",
      schema: ProviderStopBackgroundTaskInput,
      payload: rawInput,
    });
    // No recovery: a stop against a dormant thread must not resurrect a
    // provider process just to tell it to stop nothing. Background tasks
    // die with their session, so no live session means nothing to stop.
    const routed = yield* resolveRoutableSession({
      threadId: input.threadId,
      operation: "ProviderService.stopBackgroundTask",
      allowRecovery: false,
    });
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "stop-background-task",
      "provider.kind": routed.adapter.provider,
      "provider.thread_id": input.threadId,
      "provider.task_id": input.taskId,
    });
    if (!routed.isActive) {
      return yield* new ProviderSessionNotFoundError({ threadId: input.threadId });
    }
    if (input.expected && input.expected.runtimeSessionId !== routed.session?.runtimeSessionId) {
      return yield* new ProviderValidationError({
        operation: "ProviderService.stopBackgroundTask",
        issue: "The displayed background task belongs to a replaced runtime session.",
      });
    }
    const stop = routed.adapter.stopBackgroundTask;
    if (stop === undefined) {
      return yield* new ProviderUnsupportedError({ provider: routed.adapter.provider });
    }
    yield* stop(routed.threadId, input.taskId, input.expected);
    yield* analytics.record("provider.background_task.stopped", {
      provider: routed.adapter.provider,
    });
  });

  const respondToRequest: ProviderServiceShape["respondToRequest"] = Effect.fn("respondToRequest")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.respondToRequest",
        schema: ProviderRespondToRequestInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.respondToRequest",
          allowRecovery: false,
        });
        if (
          !routed.isActive ||
          (input.expectedRuntimeSessionId !== undefined &&
            routed.session?.runtimeSessionId !== input.expectedRuntimeSessionId)
        ) {
          return yield* new ProviderSessionNotFoundError({ threadId: input.threadId });
        }
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "respond-to-request",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
          "provider.request_id": input.requestId,
        });
        yield* boundedControl(
          routed.adapter.respondToRequest(routed.threadId, input.requestId, input.decision),
          {
            provider: routed.adapter.provider,
            instanceId: routed.instanceId,
            operation: "request.respond",
          },
        );
        yield* analytics.record("provider.request.responded", {
          provider: routed.adapter.provider,
          decision: input.decision,
        });
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "approval-response",
            }),
        }),
      );
    },
  );

  const respondToUserInput: ProviderServiceShape["respondToUserInput"] = Effect.fn(
    "respondToUserInput",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.respondToUserInput",
      schema: ProviderRespondToUserInputInput,
      payload: rawInput,
    });
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.respondToUserInput",
        allowRecovery: false,
      });
      // Questions own process-local callbacks. Resuming a conversation cannot restore one.
      if (
        !routed.isActive ||
        (input.expectedRuntimeSessionId !== undefined &&
          routed.session?.runtimeSessionId !== input.expectedRuntimeSessionId)
      ) {
        return yield* new ProviderSessionNotFoundError({ threadId: input.threadId });
      }
      metricProvider = routed.adapter.provider;
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "respond-to-user-input",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
        "provider.request_id": input.requestId,
      });
      yield* boundedControl(
        routed.adapter.respondToUserInput(routed.threadId, input.requestId, input.answers),
        {
          provider: routed.adapter.provider,
          instanceId: routed.instanceId,
          operation: "user-input.respond",
        },
      );
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        outcomeAttributes: () =>
          providerMetricAttributes(metricProvider, {
            operation: "user-input-response",
          }),
      }),
    );
  });

  const stopSession: ProviderServiceShape["stopSession"] = Effect.fn("stopSession")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.stopSession",
        schema: ProviderStopSessionInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.stopSession",
          allowRecovery: false,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "stop-session",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
        });
        const stopExit = routed.isActive
          ? yield* Effect.exit(
              boundedControl(routed.adapter.stopSession(routed.threadId), {
                provider: routed.adapter.provider,
                instanceId: routed.instanceId,
                operation: "session.stop",
              }),
            )
          : Exit.void;
        if (Exit.isFailure(stopExit) && Cause.hasInterruptsOnly(stopExit.cause)) {
          return yield* stopExit;
        }
        // The live cursor is the newest one (a Claude rewind marker may have been
        // cleared since the last send); the next start resumes from it.
        const liveResumeCursor = routed.isActive ? routed.session?.resumeCursor : undefined;
        // Always recorded: the user asked for the stop, so nothing routes to the
        // runtime again even when the provider did not confirm it.
        yield* directory.upsert({
          threadId: input.threadId,
          provider: routed.adapter.provider,
          providerInstanceId: routed.instanceId,
          ...(routed.session?.runtimeSessionId
            ? { runtimeSessionId: routed.session.runtimeSessionId }
            : {}),
          ...(liveResumeCursor !== undefined ? { resumeCursor: liveResumeCursor } : {}),
          status: "stopped",
          runtimePayload: {
            activeTurnId: null,
          },
        });
        if (Exit.isFailure(stopExit)) {
          // Timed out or failed: the binding is now `stopped`, so the reaper's idle
          // sweep skips it; its stale-binding retry keeps trying to stop the exact
          // runtime instead (and forgets it once that runtime is gone).
          if (routed.session?.runtimeSessionId) {
            yield* rememberStaleBinding({
              threadId: input.threadId,
              provider: routed.adapter.provider,
              providerInstanceId: routed.instanceId,
              runtimeSessionId: routed.session.runtimeSessionId,
            });
          }
          return yield* stopExit;
        }
        yield* forgetRuntimeActivity(input.threadId);
        yield* analytics.record("provider.session.stopped", {
          provider: routed.adapter.provider,
        });
      }).pipe(
        withMetrics({
          counter: providerSessionsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "stop",
            }),
        }),
      );
    },
  );

  const listSessions: ProviderServiceShape["listSessions"] = Effect.fn("listSessions")(
    function* () {
      const currentAdapters = yield* getAdapterEntries;
      const sessionsByProvider = yield* Effect.forEach(currentAdapters, ([instanceId, adapter]) =>
        adapter.listSessions().pipe(
          Effect.map((sessions) =>
            sessions.map((session) => ({
              ...session,
              providerInstanceId: instanceId,
            })),
          ),
        ),
      );
      const activeSessions = sessionsByProvider.flatMap((sessions) => sessions);
      const persistedBindings = yield* directory.listThreadIds().pipe(
        Effect.flatMap((threadIds) =>
          Effect.forEach(
            threadIds,
            (threadId) =>
              directory
                .getBinding(threadId)
                .pipe(Effect.orElseSucceed(() => Option.none<ProviderRuntimeBinding>())),
            { concurrency: "unbounded" },
          ),
        ),
        Effect.orElseSucceed(() => [] as Array<Option.Option<ProviderRuntimeBinding>>),
      );
      const bindingsByThreadId = new Map<ThreadId, ProviderRuntimeBinding>();
      for (const bindingOption of persistedBindings) {
        const binding = Option.getOrUndefined(bindingOption);
        if (binding) {
          bindingsByThreadId.set(binding.threadId, binding);
        }
      }

      const sessions: ProviderSession[] = [];
      for (const session of activeSessions) {
        const binding = bindingsByThreadId.get(session.threadId);
        if (!binding) {
          continue;
        }

        const overrides: {
          resumeCursor?: ProviderSession["resumeCursor"];
          runtimeMode?: ProviderSession["runtimeMode"];
          providerInstanceId?: ProviderSession["providerInstanceId"];
          runtimeSessionId?: ProviderSession["runtimeSessionId"];
        } = {};
        overrides.providerInstanceId = dieOnMissingBindingInstanceId(
          "ProviderService.listSessions",
          binding,
        );
        if (!sessionMatchesBinding(session, overrides.providerInstanceId, binding)) {
          continue;
        }
        if (binding.runtimeSessionId !== undefined) {
          overrides.runtimeSessionId = binding.runtimeSessionId;
        }
        if (session.resumeCursor === undefined && binding.resumeCursor !== undefined) {
          overrides.resumeCursor = binding.resumeCursor;
        }
        if (binding.runtimeMode !== undefined) {
          overrides.runtimeMode = binding.runtimeMode;
        }
        sessions.push(Object.assign({}, session, overrides));
      }
      return sessions;
    },
  );

  const getCapabilities: ProviderServiceShape["getCapabilities"] = (instanceId) =>
    registry.getByInstance(instanceId).pipe(Effect.map((adapter) => adapter.capabilities));

  const getInstanceInfo: ProviderServiceShape["getInstanceInfo"] = (instanceId) =>
    registry.getInstanceInfo(instanceId);

  const rollbackConversation: ProviderServiceShape["rollbackConversation"] = Effect.fn(
    "rollbackConversation",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.rollbackConversation",
      schema: ProviderRollbackConversationInput,
      payload: rawInput,
    });
    if (input.numTurns === 0) {
      return;
    }
    const operation = "ProviderService.rollbackConversation";
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      // Refuse before any recovery: a provider that cannot forget turns must not
      // get a session (re)started just to learn that.
      const binding = Option.getOrUndefined(yield* directory.getBinding(input.threadId));
      if (!binding) {
        return yield* toValidationError(
          operation,
          `Cannot route thread '${input.threadId}' because no persisted provider binding exists.`,
        );
      }
      const instanceId = yield* requireBindingInstanceId(operation, binding);
      const boundAdapter = yield* registry.getByInstance(instanceId);
      metricProvider = boundAdapter.provider;
      if (boundAdapter.capabilities.conversationRollback !== "native") {
        const displayName = yield* registry.getInstanceInfo(instanceId).pipe(
          Effect.map((info) => info.displayName),
          Effect.orElseSucceed(() => undefined),
        );
        return yield* new ProviderOperationUnsupportedError({
          provider: boundAdapter.provider,
          operation: "rollbackConversation",
          detail: `${displayName ?? boundAdapter.provider} can't remove turns from its conversation, so this thread can't be reverted. Start a new thread to try a different approach.`,
        });
      }

      // The lock serializes the rollback with starts, stale-binding stops and
      // recovery. The semaphore is not reentrant: use the unlocked resolver
      // inside it. Lock wait, recovery and the rollback call share one deadline,
      // detached like a start: the caller stops waiting at the deadline, and the
      // abandoned work is interrupted in the background, which releases the lock.
      // Where it was waiting decides the text: before the rollback call nothing
      // was changed; during it the agent may or may not have forgotten the turns.
      const label = yield* operationLabel(instanceId);
      const timeoutMs = timeouts.sessionStartMs(binding.provider) + timeouts.controlRequestMs;
      const progress: { phase: "session.lock" | "session.recover" | "conversation.rollback" } = {
        phase: "session.lock",
      };
      const rollbackLocked = Effect.gen(function* () {
        progress.phase = "session.recover";
        const routed = yield* resolveRoutableSessionUnlocked({
          threadId: input.threadId,
          operation,
          allowRecovery: true,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "rollback-conversation",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
          "provider.rollback_turns": input.numTurns,
        });
        progress.phase = "conversation.rollback";
        yield* routed.adapter.rollbackThread(routed.threadId, {
          numTurns: input.numTurns,
          targetTurnId: input.targetTurnId,
          droppedTurnIds: input.droppedTurnIds,
        });
        // Persist the adapter's post-rollback cursor (Claude rewind marker,
        // OpenCode fork session id) so recovery resumes the rewound conversation.
        // Best-effort: the agent has already forgotten the turns, so failing
        // here would report "nothing was changed" when something was. The
        // next send or completed turn persists the live cursor again.
        yield* Effect.gen(function* () {
          const sessions = yield* routed.adapter.listSessions();
          const session = sessions.find((candidate) => candidate.threadId === routed.threadId);
          if (session) {
            yield* upsertSessionBinding(
              { ...session, providerInstanceId: routed.instanceId },
              input.threadId,
              {
                lastRuntimeEvent: "provider.rollback",
                lastRuntimeEventAt: new Date().toISOString(),
              },
            );
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logError("provider.rollback.persist-binding-failed", {
                  threadId: input.threadId,
                  cause: Cause.pretty(cause),
                }),
          ),
        );
        yield* analytics.record("provider.conversation.rolled_back", {
          provider: routed.adapter.provider,
          turns: input.numTurns,
        });
      });
      yield* runDetachedWithDeadline(withSessionStartLock(input.threadId, rollbackLocked), {
        scope: serviceScope,
        timeoutMs,
        onTimeout: () =>
          operationTimeoutError({
            provider: binding.provider,
            label,
            operation: progress.phase,
            timeoutMs,
          }),
      });
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        outcomeAttributes: () =>
          providerMetricAttributes(metricProvider, {
            operation: "rollback",
          }),
      }),
    );
  });

  const runStopAll = Effect.fn("runStopAll")(function* () {
    const threadIds = yield* directory.listThreadIds();
    const currentAdapters = yield* getAdapterEntries;
    const activeSessions = yield* Effect.forEach(currentAdapters, ([instanceId, adapter]) =>
      adapter.listSessions().pipe(
        Effect.map((sessions) =>
          sessions.map((session) => ({
            ...session,
            providerInstanceId: instanceId,
          })),
        ),
      ),
    ).pipe(Effect.map((sessionsByAdapter) => sessionsByAdapter.flatMap((sessions) => sessions)));
    yield* Effect.forEach(activeSessions, (session) =>
      upsertSessionBinding(session, session.threadId, {
        lastRuntimeEvent: "provider.stopAll",
        lastRuntimeEventAt: new Date().toISOString(),
      }),
    ).pipe(Effect.asVoid);
    yield* Effect.forEach(currentAdapters, ([, adapter]) => adapter.stopAll()).pipe(Effect.asVoid);
    yield* Effect.sync(() => runtimeActivity.clear());
    const bindings = yield* directory.listBindings().pipe(Effect.orElseSucceed(() => []));
    yield* Effect.forEach(bindings, (binding) => {
      const providerInstanceId = dieOnMissingBindingInstanceId("ProviderService.stopAll", binding);
      return directory.upsert({
        threadId: binding.threadId,
        provider: binding.provider,
        providerInstanceId,
        ...(binding.runtimeSessionId ? { runtimeSessionId: binding.runtimeSessionId } : {}),
        status: "stopped",
        runtimePayload: {
          activeTurnId: null,
          lastRuntimeEvent: "provider.stopAll",
          lastRuntimeEventAt: new Date().toISOString(),
        },
      });
    }).pipe(Effect.asVoid);
    yield* analytics.record("provider.sessions.stopped_all", {
      sessionCount: threadIds.length,
    });
    yield* analytics.flush;
  });

  yield* Effect.addFinalizer(() =>
    runStopAll().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to stop provider service", { cause: Cause.pretty(cause) }),
      ),
    ),
  );

  return {
    readThreadHistory: (threadId) =>
      Effect.gen(function* () {
        const binding = yield* directory.getBinding(threadId);
        if (Option.isNone(binding) || binding.value.resumeCursor == null) return Option.none();
        const instanceId = yield* requireBindingInstanceId("readThreadHistory", binding.value);
        const adapter = yield* registry.getByInstance(instanceId);
        if (!adapter.readThreadHistory) return Option.none();
        const cwd = readPersistedCwd(binding.value.runtimePayload);
        const history = yield* adapter.readThreadHistory({
          threadId,
          resumeCursor: binding.value.resumeCursor,
          ...(cwd ? { cwd } : {}),
        });
        return Option.some({ binding: binding.value, history });
      }),
    startSession,
    startFreshSession,
    getSession,
    restoreSessionBinding,
    retireSessionBinding,
    stopSessionBinding,
    listStaleSessionBindings,
    sendTurn,
    setThreadGoal,
    getThreadGoal,
    clearThreadGoal,
    steerTurn,
    interruptTurn,
    stopBackgroundTask,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    getCapabilities,
    getInstanceInfo,
    rollbackConversation,
    listRuntimeActivity: () => Effect.sync(() => [...runtimeActivity.values()]),
    readRecentEventSummaries: (input) =>
      Ref.get(recentRuntimeEvents).pipe(
        Effect.map((events) =>
          events
            .filter(
              (event) =>
                event.occurredAt >= input.since &&
                (input.threadId === undefined || event.threadId === input.threadId) &&
                (input.providerInstanceId === undefined ||
                  event.providerInstanceId === input.providerInstanceId),
            )
            .slice(0, Math.min(Math.max(1, Math.floor(input.limit)), 50)),
        ),
      ),
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (ProviderRuntimeIngestion, CheckpointReactor, etc.) each
    // independently receive all runtime events.
    get streamEvents(): ProviderServiceShape["streamEvents"] {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  } satisfies ProviderServiceShape;
});

export const ProviderServiceLive = Layer.effect(ProviderService, makeProviderService());

export function makeProviderServiceLive(options?: ProviderServiceLiveOptions) {
  return Layer.effect(ProviderService, makeProviderService(options));
}
