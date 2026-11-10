/**
 * One ref summary source per folder and poll interval, shared by every summary stream of
 * `VcsStatusBroadcaster` (each sidebar and inbox row of each client): one HEAD check every few
 * seconds and one slow poll per folder, not one per stream. A source outlives its last stream
 * briefly, so rows scrolled out and back, remounts and resubscribing clients find it running.
 *
 * Loaded through `import()` with the first summary stream, off the boot path.
 *
 * @module refSummarySources
 */
import { Clock, Duration, Effect, Fiber, PubSub, Scope, Stream } from "effect";
import type { GitManagerServiceError, VcsStatusStreamEvent } from "@ryco/contracts";

import type { VcsRefSummary } from "../git/GitManager.ts";
import { readCheckoutHead } from "./gitCheckoutHead.ts";

/** A source outlives its last stream this long. */
export const REF_SUMMARY_SOURCE_LINGER = Duration.seconds(30);

interface RefSummarySource {
  readonly key: string;
  readonly pubsub: PubSub.PubSub<VcsRefSummary>;
  /** The last summary it read; streams that join start from it while it is recent. */
  latest: VcsRefSummary | null;
  latestAtMs: number;
  subscribers: number;
  fiber: Fiber.Fiber<void, never> | null;
  /** Ends the source when nobody joins within the linger. */
  linger: Fiber.Fiber<void, never> | null;
}

export interface RefSummarySources {
  /** The folder's summaries: the current one first, then each change. */
  readonly stream: (
    cwd: string,
    requestedPollIntervalMs: number,
  ) => Stream.Stream<VcsRefSummary, GitManagerServiceError>;
  readonly stopAll: Effect.Effect<void>;
}

export function makeRefSummarySources(deps: {
  /** The workflow's (cached) ref summary, in the background lane. */
  readonly refSummary: (cwd: string) => Effect.Effect<VcsRefSummary, GitManagerServiceError>;
  /** The folder's publications (refreshes after git actions and agent turns). */
  readonly subscribeFolder: (
    cwd: string,
  ) => Effect.Effect<PubSub.Subscription<VcsStatusStreamEvent>, never, Scope.Scope>;
  /** Where sources and lingers run: the broadcaster's scope. */
  readonly scope: Scope.Scope;
  readonly headPollInterval: Duration.Duration;
  /** Polls never come more often than the shared change request index refreshes. */
  readonly minPollInterval: Duration.Duration;
  readonly triggerDebounce: Duration.Duration;
  readonly channelCapacity: number;
}): RefSummarySources {
  const sources = new Map<string, RefSummarySource>();

  const stop = (source: RefSummarySource) =>
    Effect.suspend(() => {
      if (sources.get(source.key) === source) sources.delete(source.key);
      const fibers = [source.fiber, source.linger].filter(
        (fiber): fiber is Fiber.Fiber<void, never> => fiber !== null,
      );
      source.fiber = null;
      source.linger = null;
      return Effect.forEach(fibers, (fiber) => Fiber.interrupt(fiber), { discard: true }).pipe(
        Effect.andThen(PubSub.shutdown(source.pubsub)),
      );
    });

  const publish = (source: RefSummarySource, summary: VcsRefSummary) =>
    Effect.flatMap(Clock.currentTimeMillis, (nowMs) => {
      source.latest = summary;
      source.latestAtMs = nowMs;
      return PubSub.publish(source.pubsub, summary).pipe(Effect.asVoid);
    });

  const run = (source: RefSummarySource, cwd: string, pollIntervalMs: number) =>
    Effect.scoped(
      Effect.gen(function* () {
        const subscription = yield* deps.subscribeFolder(cwd);
        // Recompute on: a publication for this folder (a refresh after a git action or agent
        // turn), a checkout switch seen on disk, and, when polling, a slow periodic re-read of
        // change requests.
        const triggers = Stream.mergeAll(
          [
            Stream.fromSubscription(subscription).pipe(Stream.as("published")),
            Stream.tick(deps.headPollInterval).pipe(
              Stream.mapEffect(() => readCheckoutHead(cwd)),
              Stream.map((head) => head?.branch ?? null),
              Stream.changes,
              Stream.drop(1),
              Stream.as("head"),
            ),
            pollIntervalMs > 0
              ? Stream.tick(Duration.millis(pollIntervalMs)).pipe(Stream.drop(1), Stream.as("poll"))
              : Stream.empty,
          ],
          { concurrency: "unbounded" },
        );
        yield* triggers.pipe(
          Stream.debounce(deps.triggerDebounce),
          Stream.mapEffect(() =>
            deps.refSummary(cwd).pipe(Effect.catchCause(() => Effect.succeed(null))),
          ),
          Stream.runForEach((summary) =>
            summary === null ? Effect.void : publish(source, summary),
          ),
        );
      }),
    );

  const acquire = (cwd: string, pollIntervalMs: number) =>
    Effect.acquireRelease(
      Effect.gen(function* () {
        const key = `${pollIntervalMs}\u0000${cwd}`;
        let source = sources.get(key);
        if (source === undefined) {
          const pubsub = yield* PubSub.sliding<VcsRefSummary>(deps.channelCapacity);
          source = sources.get(key);
          if (source !== undefined) {
            yield* PubSub.shutdown(pubsub);
          } else {
            const created: RefSummarySource = {
              key,
              pubsub,
              latest: null,
              latestAtMs: 0,
              subscribers: 0,
              fiber: null,
              linger: null,
            };
            sources.set(key, created);
            created.fiber = yield* run(created, cwd, pollIntervalMs).pipe(
              Effect.catchCause(() => Effect.void),
              Effect.forkIn(deps.scope),
            );
            source = created;
          }
        }
        source.subscribers += 1;
        const linger = source.linger;
        source.linger = null;
        if (linger !== null) yield* Fiber.interrupt(linger);
        return source;
      }),
      (source) =>
        Effect.gen(function* () {
          source.subscribers -= 1;
          if (source.subscribers > 0 || sources.get(source.key) !== source) return;
          source.linger = yield* Effect.sleep(REF_SUMMARY_SOURCE_LINGER).pipe(
            Effect.andThen(
              Effect.suspend(() =>
                source.subscribers > 0
                  ? Effect.void
                  : // Clear the own handle first: stopping interrupts it.
                    Effect.sync(() => {
                      source.linger = null;
                    }).pipe(Effect.andThen(stop(source))),
              ),
            ),
            Effect.forkIn(deps.scope),
          );
        }),
    );

  return {
    stream: (cwd, requestedPollIntervalMs) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const pollIntervalMs =
            requestedPollIntervalMs > 0
              ? Math.max(requestedPollIntervalMs, Duration.toMillis(deps.minPollInterval))
              : 0;
          const source = yield* acquire(cwd, pollIntervalMs);
          // Subscribed before the first value is taken, so nothing published meanwhile is lost.
          const subscription = yield* PubSub.subscribe(source.pubsub);
          // A recent shared summary answers at once. An older one (a quiet folder whose source
          // has had nothing to re-read on) is read again, as a new stream always did, through
          // the workflow's own short cache.
          const nowMs = yield* Clock.currentTimeMillis;
          const recent =
            source.latest !== null &&
            nowMs - source.latestAtMs < Duration.toMillis(deps.minPollInterval)
              ? source.latest
              : null;
          const seenAtMs = source.latestAtMs;
          const initial = recent ?? (yield* deps.refSummary(cwd));
          // Shared only when the source published nothing newer while it was read.
          if (recent === null && source.latestAtMs === seenAtMs) yield* publish(source, initial);
          return Stream.concat(Stream.make(initial), Stream.fromSubscription(subscription));
        }),
      ),
    stopAll: Effect.suspend(() =>
      Effect.forEach([...sources.values()], (source) => stop(source), { discard: true }),
    ),
  };
}
