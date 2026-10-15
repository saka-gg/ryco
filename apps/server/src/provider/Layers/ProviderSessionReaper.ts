import type { ThreadId } from "@ryco/contracts";
import { Duration, Effect, Layer, Option, Schedule } from "effect";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadViewersService } from "../../orchestration/ThreadViewers.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import {
  ProviderSessionReaper,
  type ProviderSessionReaperShape,
} from "../Services/ProviderSessionReaper.ts";
import { ProviderService } from "../Services/ProviderService.ts";

// Keep provider processes around briefly for UX, while still reaping genuinely idle
// sessions without a frequent background sweep. Override through layer options in tests.
const DEFAULT_INACTIVITY_THRESHOLD_MS = 5 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 2 * 60 * 1000;
// A thread a client shows keeps its idle session, so going back to it is warm, but a
// forgotten open thread does not hold a provider process for ever, and only a few do.
const DEFAULT_VIEWED_INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000;
const DEFAULT_MAX_VIEWED_IDLE_SESSIONS = 4;

export interface ProviderSessionReaperLiveOptions {
  readonly inactivityThresholdMs?: number;
  readonly sweepIntervalMs?: number;
  /** Idle time after which a viewed thread's session is reaped anyway. */
  readonly viewedInactivityThresholdMs?: number;
  /** Viewed threads whose idle sessions are kept past the threshold (most recent first). */
  readonly maxViewedIdleSessions?: number;
}

const makeProviderSessionReaper = (options?: ProviderSessionReaperLiveOptions) =>
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const directory = yield* ProviderSessionDirectory;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    // Optional: without it no thread counts as viewed.
    const threadViewers = yield* Effect.serviceOption(ThreadViewersService);

    const inactivityThresholdMs = Math.max(
      1,
      options?.inactivityThresholdMs ?? DEFAULT_INACTIVITY_THRESHOLD_MS,
    );
    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    const viewedInactivityThresholdMs = Math.max(
      inactivityThresholdMs,
      options?.viewedInactivityThresholdMs ?? DEFAULT_VIEWED_INACTIVITY_THRESHOLD_MS,
    );
    const maxViewedIdleSessions = Math.max(
      0,
      options?.maxViewedIdleSessions ?? DEFAULT_MAX_VIEWED_IDLE_SESSIONS,
    );
    const isViewed = (threadId: ThreadId) =>
      Option.isSome(threadViewers) && threadViewers.value.isViewed(threadId);

    // Reads the thread shell now: whether the thread still has work the session must
    // keep running for.
    const isBusy = (threadId: ThreadId, idleDurationMs: number) =>
      Effect.gen(function* () {
        const thread = yield* projectionSnapshotQuery
          .getThreadShellById(threadId)
          .pipe(Effect.map(Option.getOrUndefined));
        if (thread?.session?.activeTurnId != null) {
          yield* Effect.logDebug("provider.session.reaper.skipped-active-turn", {
            threadId,
            activeTurnId: thread.session.activeTurnId,
            idleDurationMs,
          });
          return true;
        }

        // Parent turns can settle while fleets, workflows, or monitor loops
        // continue inside the provider process. Their liveness marker is
        // authoritative even when ordinary session activity is old.
        if (thread?.backgroundLiveness != null) {
          yield* Effect.logDebug("provider.session.reaper.skipped-background-work", {
            threadId,
            backgroundLiveness: thread.backgroundLiveness,
            idleDurationMs,
          });
          return true;
        }
        return false;
      });

    const sweep = Effect.gen(function* () {
      const pendingStaleBindings = yield* providerService.listStaleSessionBindings();
      yield* Effect.forEach(
        pendingStaleBindings,
        (binding) =>
          providerService.stopSessionBinding(binding).pipe(
            Effect.tap((result) =>
              Effect.logDebug("provider.session.reaper.stale-retry", {
                provider: binding.provider,
                result,
              }),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("provider.session.reaper.stale-retry-failed", {
                provider: binding.provider,
                cause,
              }),
            ),
          ),
        { concurrency: "unbounded", discard: true },
      );

      const bindings = yield* directory.listBindings();
      const now = Date.now();
      let reapedCount = 0;
      const idle: Array<{
        readonly binding: (typeof bindings)[number];
        readonly idleDurationMs: number;
      }> = [];

      for (const binding of bindings) {
        if (binding.status === "stopped") {
          continue;
        }

        const lastSeenMs = Date.parse(binding.lastSeenAt);
        if (Number.isNaN(lastSeenMs)) {
          yield* Effect.logWarning("provider.session.reaper.invalid-last-seen", {
            threadId: binding.threadId,
            provider: binding.provider,
            lastSeenAt: binding.lastSeenAt,
          });
          continue;
        }

        const idleDurationMs = now - lastSeenMs;
        if (idleDurationMs < inactivityThresholdMs) {
          continue;
        }

        if (yield* isBusy(binding.threadId, idleDurationMs)) {
          continue;
        }

        idle.push({ binding, idleDurationMs });
      }

      // Viewed threads keep their sessions, the most recently active first, up to the cap
      // and the viewed idle limit.
      const keptViewed = new Set(
        idle
          .filter(
            ({ binding, idleDurationMs }) =>
              idleDurationMs < viewedInactivityThresholdMs && isViewed(binding.threadId),
          )
          .toSorted((left, right) => left.idleDurationMs - right.idleDurationMs)
          .slice(0, maxViewedIdleSessions)
          .map(({ binding }) => binding.threadId),
      );

      for (const { binding, idleDurationMs } of idle) {
        if (keptViewed.has(binding.threadId)) {
          yield* Effect.logDebug("provider.session.reaper.skipped-viewed", {
            threadId: binding.threadId,
            idleDurationMs,
          });
          continue;
        }
        // Each stop can take a while, so a turn may have started on this thread since the
        // first pass: check again right before stopping it.
        if (yield* isBusy(binding.threadId, idleDurationMs)) {
          continue;
        }
        const viewed = isViewed(binding.threadId);
        const reaped = yield* providerService.stopSession({ threadId: binding.threadId }).pipe(
          Effect.tap(() =>
            Effect.logInfo("provider.session.reaped", {
              threadId: binding.threadId,
              provider: binding.provider,
              idleDurationMs,
              reason: viewed ? "viewed_idle_limit" : "inactivity_threshold",
            }),
          ),
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("provider.session.reaper.stop-failed", {
              threadId: binding.threadId,
              provider: binding.provider,
              idleDurationMs,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );

        if (reaped) {
          reapedCount += 1;
        }
      }

      if (reapedCount > 0) {
        yield* Effect.logInfo("provider.session.reaper.sweep-complete", {
          reapedCount,
          totalBindings: bindings.length,
        });
      }
    });

    const start: ProviderSessionReaperShape["start"] = () =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          sweep.pipe(
            Effect.catch((error: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-failed", {
                error,
              }),
            ),
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-defect", {
                defect,
              }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
          ),
        );

        yield* Effect.logInfo("provider.session.reaper.started", {
          inactivityThresholdMs,
          sweepIntervalMs,
        });
      });

    return {
      start,
    } satisfies ProviderSessionReaperShape;
  });

export const makeProviderSessionReaperLive = (options?: ProviderSessionReaperLiveOptions) =>
  Layer.effect(ProviderSessionReaper, makeProviderSessionReaper(options));

export const ProviderSessionReaperLive = makeProviderSessionReaperLive();
