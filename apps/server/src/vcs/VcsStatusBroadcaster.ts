import { realpathSync } from "node:fs";

import {
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  PubSub,
  Ref,
  Schedule,
  Scope,
  Stream,
  SynchronizedRef,
} from "effect";
import type {
  GitManagerServiceError,
  VcsStatusInput,
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
  VcsStatusResult,
  VcsStatusStreamEvent,
} from "@ryco/contracts";
import { mergeGitStatusParts } from "@ryco/shared/git";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";

const DEFAULT_VCS_STATUS_REFRESH_INTERVAL = Duration.seconds(30);
const VCS_STATUS_REFRESH_FAILURE_BASE_DELAY = Duration.seconds(30);
const VCS_STATUS_REFRESH_FAILURE_MAX_DELAY = Duration.minutes(15);
const MAX_REMOTE_REFRESH_CONSECUTIVE_FAILURES = 64;
const LOCAL_STATUS_CACHE_TTL_MS = Duration.toMillis(Duration.seconds(5));
const REMOTE_STATUS_CACHE_TTL_MS = Duration.toMillis(Duration.seconds(30));

interface VcsStatusChange {
  readonly cwd: string;
  readonly event: VcsStatusStreamEvent;
}

interface CachedValue<T> {
  readonly cachedAtMs: number;
  readonly fingerprint: string;
  readonly value: T;
}

interface CachedVcsStatus {
  readonly local: CachedValue<VcsStatusLocalResult> | null;
  readonly remote: CachedValue<VcsStatusRemoteResult | null> | null;
}

interface ActiveRemotePoller {
  readonly fiber: Fiber.Fiber<void, never>;
  readonly subscriberCount: number;
}

type StatusFlightKind = "load" | "refresh";

interface ActiveStatusFlight<A> {
  readonly deferred: Deferred.Deferred<A, GitManagerServiceError>;
  readonly kind: StatusFlightKind;
  readonly version: number;
}

type StatusFlightSelection<A> =
  | { readonly _tag: "owner"; readonly deferred: Deferred.Deferred<A, GitManagerServiceError> }
  | { readonly _tag: "await"; readonly deferred: Deferred.Deferred<A, GitManagerServiceError> }
  | {
      readonly _tag: "retryAfter";
      readonly deferred: Deferred.Deferred<A, GitManagerServiceError>;
    };

interface StreamStatusOptions {
  readonly automaticRemoteRefreshInterval?: Effect.Effect<Duration.Duration, never>;
  readonly afterRemotePollerRetained?: Effect.Effect<void>;
}

export interface VcsStatusBroadcasterShape {
  readonly getStatus: (
    input: VcsStatusInput,
  ) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
  readonly refreshLocalStatus: (
    cwd: string,
  ) => Effect.Effect<VcsStatusLocalResult, GitManagerServiceError>;
  readonly refreshStatus: (cwd: string) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
  readonly streamStatus: (
    input: VcsStatusInput,
    options?: StreamStatusOptions,
  ) => Stream.Stream<VcsStatusStreamEvent, GitManagerServiceError>;
}

export class VcsStatusBroadcaster extends Context.Service<
  VcsStatusBroadcaster,
  VcsStatusBroadcasterShape
>()("ryco/vcs/VcsStatusBroadcaster") {}

function fingerprintStatusPart(status: unknown): string {
  return JSON.stringify(status);
}

function isCachedValueFresh<T>(cached: CachedValue<T>, nowMs: number, ttlMs: number): boolean {
  return nowMs - cached.cachedAtMs < ttlMs;
}

function normalizeCwd(cwd: string): string {
  try {
    return realpathSync.native(cwd);
  } catch {
    return cwd;
  }
}

export function remoteRefreshFailureDelay(
  consecutiveFailures: number,
  configuredInterval: Duration.Duration,
): Duration.Duration {
  const clampedFailures = Math.min(consecutiveFailures, MAX_REMOTE_REFRESH_CONSECUTIVE_FAILURES);
  const exponent = Math.max(0, clampedFailures - 1);
  const backoffMs =
    Duration.toMillis(VCS_STATUS_REFRESH_FAILURE_BASE_DELAY) * Math.pow(2, exponent);
  const cappedBackoff = Duration.min(
    Duration.millis(backoffMs),
    VCS_STATUS_REFRESH_FAILURE_MAX_DELAY,
  );
  return Duration.max(configuredInterval, cappedBackoff);
}

export const layer = Layer.effect(
  VcsStatusBroadcaster,
  Effect.gen(function* () {
    const workflow = yield* GitWorkflowService.GitWorkflowService;
    const changesPubSub = yield* Effect.acquireRelease(
      PubSub.sliding<VcsStatusChange>(64),
      (pubsub) => PubSub.shutdown(pubsub),
    );
    const broadcasterScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
      Scope.close(scope, Exit.void),
    );
    const cacheRef = yield* Ref.make(new Map<string, CachedVcsStatus>());
    const pollersRef = yield* SynchronizedRef.make(new Map<string, ActiveRemotePoller>());

    const makeStatusSingleFlight = <A>() =>
      Effect.gen(function* () {
        const flightsRef = yield* SynchronizedRef.make(new Map<string, ActiveStatusFlight<A>>());
        let requestedVersion = 0;

        const run = (
          cwd: string,
          kind: StatusFlightKind,
          operation: Effect.Effect<A, GitManagerServiceError>,
          retryVersion?: number,
        ): Effect.Effect<A, GitManagerServiceError> =>
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const version = retryVersion ?? ++requestedVersion;
              const candidate = yield* Deferred.make<A, GitManagerServiceError>();
              const selection = yield* SynchronizedRef.modify(
                flightsRef,
                (
                  flights,
                ): readonly [StatusFlightSelection<A>, Map<string, ActiveStatusFlight<A>>] => {
                  const current = flights.get(cwd);
                  if (current) {
                    // A refresh must observe mutations that completed before its caller.
                    // Callers arriving during a read share one trailing refresh.
                    if (
                      kind === "refresh" &&
                      (current.kind === "load" || current.version < version)
                    ) {
                      return [{ _tag: "retryAfter", deferred: current.deferred }, flights];
                    }
                    return [{ _tag: "await", deferred: current.deferred }, flights];
                  }

                  const nextFlights = new Map(flights);
                  nextFlights.set(cwd, { deferred: candidate, kind, version: requestedVersion });
                  return [{ _tag: "owner", deferred: candidate }, nextFlights];
                },
              );

              if (selection._tag === "retryAfter") {
                yield* restore(Deferred.await(selection.deferred)).pipe(Effect.exit);
                return yield* restore(run(cwd, kind, operation, version));
              }

              if (selection._tag === "owner") {
                yield* operation.pipe(
                  Effect.onExit((exit) =>
                    SynchronizedRef.update(flightsRef, (flights) => {
                      if (flights.get(cwd)?.deferred !== candidate) {
                        return flights;
                      }
                      const nextFlights = new Map(flights);
                      nextFlights.delete(cwd);
                      return nextFlights;
                    }).pipe(Effect.andThen(Deferred.done(candidate, exit))),
                  ),
                  Effect.ignore,
                  Effect.forkIn(broadcasterScope),
                );
              }

              return yield* restore(Deferred.await(selection.deferred));
            }),
          );

        return run;
      });

    const coalesceLocalStatus = yield* makeStatusSingleFlight<VcsStatusLocalResult>();
    const coalesceRemoteStatus = yield* makeStatusSingleFlight<VcsStatusRemoteResult | null>();

    const getCachedStatus = Effect.fn("VcsStatusBroadcaster.getCachedStatus")(function* (
      cwd: string,
    ) {
      return yield* Ref.get(cacheRef).pipe(Effect.map((cache) => cache.get(cwd) ?? null));
    });

    const updateCachedLocalStatus = Effect.fn("VcsStatusBroadcaster.updateCachedLocalStatus")(
      function* (cwd: string, local: VcsStatusLocalResult, options?: { publish?: boolean }) {
        const cachedAtMs = yield* Clock.currentTimeMillis;
        const nextLocal = {
          cachedAtMs,
          fingerprint: fingerprintStatusPart(local),
          value: local,
        } satisfies CachedValue<VcsStatusLocalResult>;
        const publication = yield* Ref.modify(cacheRef, (cache) => {
          const previous = cache.get(cwd) ?? { local: null, remote: null };
          const next = {
            ...previous,
            local: nextLocal,
          };
          const nextCache = new Map(cache);
          nextCache.set(cwd, next);
          return [
            {
              changed: previous.local?.fingerprint !== nextLocal.fingerprint,
              event: {
                _tag: "snapshot" as const,
                local,
                remote: next.remote?.value ?? null,
              },
            },
            nextCache,
          ] as const;
        });

        if (options?.publish && publication.changed) {
          yield* PubSub.publish(changesPubSub, {
            cwd,
            event: publication.event,
          });
        }

        return local;
      },
    );

    const updateCachedRemoteStatus = Effect.fn("VcsStatusBroadcaster.updateCachedRemoteStatus")(
      function* (
        cwd: string,
        remote: VcsStatusRemoteResult | null,
        options?: { publish?: boolean },
      ) {
        const cachedAtMs = yield* Clock.currentTimeMillis;
        const nextRemote = {
          cachedAtMs,
          fingerprint: fingerprintStatusPart(remote),
          value: remote,
        } satisfies CachedValue<VcsStatusRemoteResult | null>;
        const publication = yield* Ref.modify(cacheRef, (cache) => {
          const previous = cache.get(cwd) ?? { local: null, remote: null };
          const next = {
            ...previous,
            remote: nextRemote,
          };
          const currentLocal =
            next.local && isCachedValueFresh(next.local, cachedAtMs, LOCAL_STATUS_CACHE_TTL_MS)
              ? next.local.value
              : null;
          const nextCache = new Map(cache);
          nextCache.set(cwd, next);
          return [
            {
              changed:
                previous.remote?.fingerprint !== nextRemote.fingerprint ||
                !previous.remote ||
                !isCachedValueFresh(previous.remote, cachedAtMs, REMOTE_STATUS_CACHE_TTL_MS),
              event: currentLocal
                ? ({
                    _tag: "snapshot" as const,
                    local: currentLocal,
                    remote,
                  } satisfies VcsStatusStreamEvent)
                : ({ _tag: "remoteUpdated" as const, remote } satisfies VcsStatusStreamEvent),
            },
            nextCache,
          ] as const;
        });

        if (options?.publish && publication.changed) {
          yield* PubSub.publish(changesPubSub, {
            cwd,
            event: publication.event,
          });
        }

        return remote;
      },
    );

    const loadLocalStatus = Effect.fn("VcsStatusBroadcaster.loadLocalStatus")(function* (
      cwd: string,
    ) {
      return yield* coalesceLocalStatus(
        cwd,
        "load",
        Effect.gen(function* () {
          const local = yield* workflow.localStatus({ cwd });
          return yield* updateCachedLocalStatus(cwd, local);
        }),
      );
    });

    const loadRemoteStatus = Effect.fn("VcsStatusBroadcaster.loadRemoteStatus")(function* (
      cwd: string,
    ) {
      return yield* coalesceRemoteStatus(
        cwd,
        "load",
        Effect.gen(function* () {
          const remote = yield* workflow.remoteStatus({ cwd });
          return yield* updateCachedRemoteStatus(cwd, remote);
        }),
      );
    });

    const getOrLoadLocalStatus = Effect.fn("VcsStatusBroadcaster.getOrLoadLocalStatus")(function* (
      cwd: string,
    ) {
      const cached = yield* getCachedStatus(cwd);
      const nowMs = yield* Clock.currentTimeMillis;
      if (cached?.local && isCachedValueFresh(cached.local, nowMs, LOCAL_STATUS_CACHE_TTL_MS)) {
        return cached.local.value;
      }
      return yield* loadLocalStatus(cwd);
    });

    const getOrLoadRemoteStatus = Effect.fn("VcsStatusBroadcaster.getOrLoadRemoteStatus")(
      function* (cwd: string) {
        const cached = yield* getCachedStatus(cwd);
        const nowMs = yield* Clock.currentTimeMillis;
        if (
          cached?.remote &&
          isCachedValueFresh(cached.remote, nowMs, REMOTE_STATUS_CACHE_TTL_MS)
        ) {
          return cached.remote.value;
        }
        return yield* loadRemoteStatus(cwd);
      },
    );

    const getStatus: VcsStatusBroadcasterShape["getStatus"] = Effect.fn(
      "VcsStatusBroadcaster.getStatus",
    )(function* (input) {
      const cwd = normalizeCwd(input.cwd);
      const [local, remote] = yield* Effect.all([
        getOrLoadLocalStatus(cwd),
        getOrLoadRemoteStatus(cwd),
      ]);
      return mergeGitStatusParts(local, remote);
    });

    const refreshLocalStatus: VcsStatusBroadcasterShape["refreshLocalStatus"] = Effect.fn(
      "VcsStatusBroadcaster.refreshLocalStatus",
    )(function* (rawCwd) {
      const cwd = normalizeCwd(rawCwd);
      return yield* coalesceLocalStatus(
        cwd,
        "refresh",
        Effect.gen(function* () {
          yield* workflow.invalidateLocalStatus(cwd);
          const local = yield* workflow.localStatus({ cwd });
          return yield* updateCachedLocalStatus(cwd, local, { publish: true });
        }),
      );
    });

    const refreshRemoteStatus = Effect.fn("VcsStatusBroadcaster.refreshRemoteStatus")(function* (
      rawCwd: string,
    ) {
      const cwd = normalizeCwd(rawCwd);
      return yield* coalesceRemoteStatus(
        cwd,
        "refresh",
        Effect.gen(function* () {
          yield* workflow.invalidateRemoteStatus(cwd);
          const remote = yield* workflow.remoteStatus({ cwd });
          return yield* updateCachedRemoteStatus(cwd, remote, { publish: true });
        }),
      );
    });

    const refreshStatus: VcsStatusBroadcasterShape["refreshStatus"] = Effect.fn(
      "VcsStatusBroadcaster.refreshStatus",
    )(function* (rawCwd) {
      const cwd = normalizeCwd(rawCwd);
      const [local, remote] = yield* Effect.all([
        refreshLocalStatus(cwd),
        refreshRemoteStatus(cwd),
      ]);
      return mergeGitStatusParts(local, remote);
    });

    const makeRemoteRefreshLoop = (
      cwd: string,
      automaticRemoteRefreshInterval: Effect.Effect<Duration.Duration, never>,
    ) =>
      Effect.gen(function* () {
        const consecutiveFailuresRef = yield* Ref.make(0);
        const refreshRemoteStatusIfEnabled = Effect.gen(function* () {
          const configuredInterval = yield* automaticRemoteRefreshInterval;
          if (Duration.isZero(configuredInterval)) {
            return DEFAULT_VCS_STATUS_REFRESH_INTERVAL;
          }

          const exit = yield* refreshRemoteStatus(cwd).pipe(Effect.exit);
          if (Exit.isSuccess(exit)) {
            yield* Ref.set(consecutiveFailuresRef, 0);
            return configuredInterval;
          }

          const consecutiveFailures = yield* Ref.updateAndGet(consecutiveFailuresRef, (count) =>
            Math.min(count + 1, MAX_REMOTE_REFRESH_CONSECUTIVE_FAILURES),
          );
          const nextDelay = remoteRefreshFailureDelay(consecutiveFailures, configuredInterval);
          yield* Effect.logWarning("VCS remote status refresh failed", {
            cwd,
            detail: exit.cause.toString(),
            consecutiveFailures,
            nextDelayMs: Duration.toMillis(nextDelay),
          });
          return nextDelay;
        });

        yield* Ref.set(consecutiveFailuresRef, 0);

        return yield* refreshRemoteStatusIfEnabled.pipe(
          Effect.repeat(
            Schedule.identity<Duration.Duration>().pipe(
              Schedule.addDelay(({ output: delay }) => Effect.succeed(delay)),
            ),
          ),
          Effect.asVoid,
        );
      });

    const retainRemotePoller = Effect.fn("VcsStatusBroadcaster.retainRemotePoller")(function* (
      cwd: string,
      automaticRemoteRefreshInterval: Effect.Effect<Duration.Duration, never>,
    ) {
      yield* SynchronizedRef.modifyEffect(pollersRef, (activePollers) => {
        const existing = activePollers.get(cwd);
        if (existing) {
          const nextPollers = new Map(activePollers);
          nextPollers.set(cwd, {
            ...existing,
            subscriberCount: existing.subscriberCount + 1,
          });
          return Effect.succeed([undefined, nextPollers] as const);
        }

        return makeRemoteRefreshLoop(cwd, automaticRemoteRefreshInterval).pipe(
          Effect.forkIn(broadcasterScope),
          Effect.map((fiber) => {
            const nextPollers = new Map(activePollers);
            nextPollers.set(cwd, {
              fiber,
              subscriberCount: 1,
            });
            return [undefined, nextPollers] as const;
          }),
        );
      });
    });

    const releaseRemotePoller = Effect.fn("VcsStatusBroadcaster.releaseRemotePoller")(function* (
      cwd: string,
    ) {
      const pollerToInterrupt = yield* SynchronizedRef.modify(pollersRef, (activePollers) => {
        const existing = activePollers.get(cwd);
        if (!existing) {
          return [null, activePollers] as const;
        }

        if (existing.subscriberCount > 1) {
          const nextPollers = new Map(activePollers);
          nextPollers.set(cwd, {
            ...existing,
            subscriberCount: existing.subscriberCount - 1,
          });
          return [null, nextPollers] as const;
        }

        const nextPollers = new Map(activePollers);
        nextPollers.delete(cwd);
        return [existing.fiber, nextPollers] as const;
      });

      if (pollerToInterrupt) {
        yield* Fiber.interrupt(pollerToInterrupt).pipe(Effect.ignore);
      }
    });

    const streamStatus: VcsStatusBroadcasterShape["streamStatus"] = (input, options) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const cwd = normalizeCwd(input.cwd);
          const subscription = yield* PubSub.subscribe(changesPubSub);
          const initialLocal = yield* getOrLoadLocalStatus(cwd);
          const cachedRemote = (yield* getCachedStatus(cwd))?.remote ?? null;
          const nowMs = yield* Clock.currentTimeMillis;
          const initialRemote =
            cachedRemote && isCachedValueFresh(cachedRemote, nowMs, REMOTE_STATUS_CACHE_TTL_MS)
              ? cachedRemote.value
              : null;
          const automaticRemoteRefreshInterval =
            options?.automaticRemoteRefreshInterval ?? Effect.succeed(Duration.zero);
          const initialRemoteRefreshInterval = yield* automaticRemoteRefreshInterval;
          const retainedRemotePoller = !Duration.isZero(initialRemoteRefreshInterval);
          if (retainedRemotePoller) {
            yield* Effect.acquireRelease(
              retainRemotePoller(cwd, automaticRemoteRefreshInterval),
              () => releaseRemotePoller(cwd).pipe(Effect.ignore, Effect.asVoid),
            );
            yield* options?.afterRemotePollerRetained ?? Effect.void;
          }

          return Stream.concat(
            Stream.make({
              _tag: "snapshot" as const,
              local: initialLocal,
              remote: initialRemote,
            }),
            Stream.merge(
              retainedRemotePoller || initialRemote !== null
                ? Stream.empty
                : Stream.fromEffect(getOrLoadRemoteStatus(cwd)).pipe(
                    Stream.map((remote) => ({ _tag: "remoteUpdated" as const, remote })),
                    Stream.catchCause(() => Stream.empty),
                  ),
              Stream.fromSubscription(subscription).pipe(
                Stream.filter((event) => event.cwd === cwd),
                Stream.map((event) => event.event),
              ),
            ),
          );
        }),
      );

    return VcsStatusBroadcaster.of({
      getStatus,
      refreshLocalStatus,
      refreshStatus,
      streamStatus,
    });
  }),
);
