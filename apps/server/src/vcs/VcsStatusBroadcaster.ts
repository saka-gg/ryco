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

import type { VcsRefSummary } from "../git/GitManager.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import { logOnceEvery } from "../logOnceEvery.ts";
import { inBackgroundProcessLane } from "../processGovernor.ts";
import { readCheckoutHead } from "./gitCheckoutHead.ts";

const DEFAULT_VCS_STATUS_REFRESH_INTERVAL = Duration.seconds(30);
/** Folders whose last status stays cached; older ones reload on the next read. */
const STATUS_CACHE_MAX_FOLDERS = 256;
/**
 * Per-folder publication buffer. Events are snapshots or halves of one, so a
 * subscriber that falls behind only skips states superseded by newer ones,
 * and never because of other folders' traffic.
 */
const FOLDER_CHANNEL_CAPACITY = 16;
/** How often a ref summary rechecks the checkout's HEAD (a file read, no process). */
const REF_SUMMARY_HEAD_POLL_INTERVAL = Duration.seconds(5);
/** A polled ref summary re-reads change requests no more often than the shared index refreshes. */
const REF_SUMMARY_MIN_REMOTE_REFRESH_INTERVAL = Duration.seconds(60);
const REF_SUMMARY_TRIGGER_DEBOUNCE = Duration.millis(250);
const EMPTY_WORKING_TREE: VcsStatusLocalResult["workingTree"] = Object.freeze({
  files: [],
  insertions: 0,
  deletions: 0,
});
const VCS_STATUS_REFRESH_FAILURE_BASE_DELAY = Duration.seconds(30);
const VCS_STATUS_REFRESH_FAILURE_MAX_DELAY = Duration.minutes(15);
const MAX_REMOTE_REFRESH_CONSECUTIVE_FAILURES = 64;
const LOCAL_STATUS_CACHE_TTL_MS = Duration.toMillis(Duration.seconds(5));
const REMOTE_STATUS_CACHE_TTL_MS = Duration.toMillis(Duration.seconds(30));

interface FolderChannel {
  readonly pubsub: PubSub.PubSub<VcsStatusStreamEvent>;
  subscribers: number;
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
  /**
   * Full status, or with `view: "summary"` only a folder's ref, hosting
   * provider and change request as snapshots whose working tree and ahead /
   * behind are not computed — no git status, diff or fetch, for badges of
   * many folders at once.
   */
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

/** A ref summary as a status snapshot (the `summary` view of {@link VcsStatusBroadcasterShape.streamStatus}). */
export function refSummaryToStatusEvent(summary: VcsRefSummary): VcsStatusStreamEvent {
  return {
    _tag: "snapshot",
    local: {
      isRepo: summary.isRepo,
      ...(summary.sourceControlProvider
        ? { sourceControlProvider: summary.sourceControlProvider }
        : {}),
      hasPrimaryRemote: summary.hasPrimaryRemote,
      isDefaultRef: summary.isDefaultRef,
      refName: summary.refName,
      hasWorkingTreeChanges: false,
      workingTree: EMPTY_WORKING_TREE,
    },
    remote: summary.isRepo
      ? { hasUpstream: summary.hasUpstream, aheadCount: 0, behindCount: 0, pr: summary.pr }
      : null,
  };
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
    // One channel per watched folder: a publication reaches only that
    // folder's subscribers, and a burst elsewhere cannot push out its events.
    const folderChannels = new Map<string, FolderChannel>();
    yield* Effect.addFinalizer(() =>
      Effect.forEach(folderChannels.values(), (channel) => PubSub.shutdown(channel.pubsub), {
        discard: true,
      }).pipe(Effect.andThen(Effect.sync(() => folderChannels.clear()))),
    );
    const broadcasterScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
      Scope.close(scope, Exit.void),
    );
    const cacheRef = yield* Ref.make(new Map<string, CachedVcsStatus>());

    const subscribeFolder = (cwd: string) =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          let channel = folderChannels.get(cwd);
          if (!channel) {
            const pubsub = yield* PubSub.sliding<VcsStatusStreamEvent>(FOLDER_CHANNEL_CAPACITY);
            const raced = folderChannels.get(cwd);
            if (raced) {
              yield* PubSub.shutdown(pubsub);
              channel = raced;
            } else {
              channel = { pubsub, subscribers: 0 };
              folderChannels.set(cwd, channel);
            }
          }
          channel.subscribers += 1;
          return channel;
        }),
        (channel) =>
          Effect.suspend(() => {
            channel.subscribers -= 1;
            if (channel.subscribers > 0 || folderChannels.get(cwd) !== channel) {
              return Effect.void;
            }
            folderChannels.delete(cwd);
            return PubSub.shutdown(channel.pubsub);
          }),
      ).pipe(Effect.flatMap((channel) => PubSub.subscribe(channel.pubsub)));

    const publishFolderEvent = (cwd: string, event: VcsStatusStreamEvent) =>
      Effect.suspend(() => {
        const channel = folderChannels.get(cwd);
        return channel ? PubSub.publish(channel.pubsub, event).pipe(Effect.asVoid) : Effect.void;
      });

    /** Writes `next` as the most recently used entry and drops the least recent past the bound. */
    const withCachedFolder = (
      cache: Map<string, CachedVcsStatus>,
      cwd: string,
      next: CachedVcsStatus,
    ) => {
      const nextCache = new Map(cache);
      nextCache.delete(cwd);
      nextCache.set(cwd, next);
      for (const oldest of nextCache.keys()) {
        if (nextCache.size <= STATUS_CACHE_MAX_FOLDERS) break;
        nextCache.delete(oldest);
      }
      return nextCache;
    };
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
          const nextCache = withCachedFolder(cache, cwd, next);
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
          yield* publishFolderEvent(cwd, publication.event);
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
          const nextCache = withCachedFolder(cache, cwd, next);
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
          yield* publishFolderEvent(cwd, publication.event);
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
          // An explicit refresh or poll brings the remote-tracking refs up to date first.
          const remote = yield* workflow.remoteStatus({ cwd }, { fetch: true });
          return yield* updateCachedRemoteStatus(cwd, remote, { publish: true });
        }),
      );
    });

    /**
     * After a stream's first remote status (read from the current tracking
     * refs, no network), fetch in the background — at most once per
     * repository and remote every few seconds — and publish if refs moved.
     */
    const refreshRemoteStatusAfterFetch = (cwd: string): Effect.Effect<void> => {
      const republish = coalesceRemoteStatus(
        cwd,
        "refresh",
        Effect.gen(function* () {
          const remote = yield* workflow.remoteStatus({ cwd });
          return yield* updateCachedRemoteStatus(cwd, remote, { publish: true });
        }),
      );
      const refresh = Effect.gen(function* () {
        if (yield* workflow.refreshRemoteTrackingRefs(cwd)) {
          yield* republish;
        }
      }).pipe(Effect.catchCause(() => Effect.void));
      return inBackgroundProcessLane(refresh).pipe(Effect.forkIn(broadcasterScope), Effect.asVoid);
    };

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
          // Offline or signed out, every backoff step fails the same way.
          yield* logOnceEvery({
            key: `vcs.remoteStatusRefresh:${cwd}`,
            message: "VCS remote status refresh failed",
            fields: { cwd, consecutiveFailures, nextDelayMs: Duration.toMillis(nextDelay) },
            cause: exit.cause,
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

    const streamFullStatus: VcsStatusBroadcasterShape["streamStatus"] = (input, options) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const cwd = normalizeCwd(input.cwd);
          const subscription = yield* subscribeFolder(cwd);
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

          // Cache expiry triggers a shared publication so newly attached streams can
          // hydrate after their initial remote:null snapshot. Existing subscribers
          // must not receive that same value as an application change every poll.
          let deliveredLocal: string | undefined;
          let deliveredRemote: string | undefined;
          const isChanged = (event: VcsStatusStreamEvent): boolean => {
            const local =
              event._tag === "remoteUpdated" ? deliveredLocal : fingerprintStatusPart(event.local);
            const remote =
              event._tag === "localUpdated" ? deliveredRemote : fingerprintStatusPart(event.remote);
            const changed = local !== deliveredLocal || remote !== deliveredRemote;
            deliveredLocal = local;
            deliveredRemote = remote;
            return changed;
          };

          return Stream.concat(
            Stream.make({
              _tag: "snapshot" as const,
              local: initialLocal,
              remote: initialRemote,
            }),
            Stream.merge(
              // A fresh cached remote status needs nothing: whichever stream
              // loaded it already started that load's background fetch.
              retainedRemotePoller || initialRemote !== null
                ? Stream.empty
                : Stream.fromEffect(getOrLoadRemoteStatus(cwd)).pipe(
                    Stream.tap(() => refreshRemoteStatusAfterFetch(cwd)),
                    Stream.map((remote) => ({ _tag: "remoteUpdated" as const, remote })),
                    Stream.catchCause(() => Stream.empty),
                  ),
              Stream.fromSubscription(subscription),
            ),
          ).pipe(Stream.filter(isChanged));
        }),
      );

    const streamRefSummary = (
      input: VcsStatusInput,
    ): Stream.Stream<VcsStatusStreamEvent, GitManagerServiceError> =>
      Stream.unwrap(
        Effect.gen(function* () {
          const cwd = normalizeCwd(input.cwd);
          // Status work for many folders at once yields to interactive git.
          const readSummary = inBackgroundProcessLane(workflow.refSummary(cwd));
          const subscription = yield* subscribeFolder(cwd);
          const initial = yield* readSummary;
          const pollIntervalMs = input.automaticRemoteRefreshIntervalMs ?? 0;

          // Recompute on: a publication for this folder (a refresh after a git
          // action or agent turn), a checkout switch seen on disk, and — when
          // polling is enabled — a slow periodic re-read of change requests.
          const triggers = Stream.mergeAll(
            [
              Stream.fromSubscription(subscription).pipe(Stream.as("published")),
              Stream.tick(REF_SUMMARY_HEAD_POLL_INTERVAL).pipe(
                Stream.mapEffect(() => readCheckoutHead(cwd)),
                Stream.map((head) => head?.branch ?? null),
                Stream.changes,
                Stream.drop(1),
                Stream.as("head"),
              ),
              pollIntervalMs > 0
                ? Stream.tick(
                    Duration.max(
                      Duration.millis(pollIntervalMs),
                      REF_SUMMARY_MIN_REMOTE_REFRESH_INTERVAL,
                    ),
                  ).pipe(Stream.drop(1), Stream.as("poll"))
                : Stream.empty,
            ],
            { concurrency: "unbounded" },
          );
          const updates = triggers.pipe(
            Stream.debounce(REF_SUMMARY_TRIGGER_DEBOUNCE),
            Stream.mapEffect(() => readSummary.pipe(Effect.catchCause(() => Effect.succeed(null)))),
            Stream.filter((summary): summary is VcsRefSummary => summary !== null),
          );

          return Stream.concat(Stream.make(initial), updates).pipe(
            Stream.map(refSummaryToStatusEvent),
            Stream.changesWith(
              (left, right) => fingerprintStatusPart(left) === fingerprintStatusPart(right),
            ),
          );
        }),
      );

    return VcsStatusBroadcaster.of({
      getStatus,
      refreshLocalStatus,
      refreshStatus,
      streamStatus: (input, options) =>
        input.view === "summary" ? streamRefSummary(input) : streamFullStatus(input, options),
    });
  }),
);
