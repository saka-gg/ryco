import type { ServerProvider } from "@ryco/contracts";
import {
  Clock,
  Deferred,
  Duration,
  Effect,
  Equal,
  Fiber,
  PubSub,
  Ref,
  Scope,
  Stream,
  SynchronizedRef,
} from "effect";
import * as Semaphore from "effect/Semaphore";

import type { ServerProviderShape } from "./Services/ServerProvider.ts";
import { ServerSettingsError } from "@ryco/contracts";
import { ignoreProviderBackgroundCause } from "./ignoreProviderBackgroundCause.ts";

interface ProviderSnapshotState {
  readonly snapshot: ServerProvider;
  readonly enrichmentGeneration: number;
  readonly lastRefreshAttemptAtMs: number | null;
}

const DEFAULT_SNAPSHOT_FRESHNESS = Duration.minutes(5);

export const isProviderSnapshotFresh = (input: {
  readonly lastRefreshAttemptAtMs: number | null;
  readonly nowMs: number;
  readonly freshnessMs: number;
}): boolean =>
  input.lastRefreshAttemptAtMs !== null &&
  input.nowMs - input.lastRefreshAttemptAtMs < input.freshnessMs;

export const makeManagedServerProvider = Effect.fn("makeManagedServerProvider")(function* <
  Settings,
>(input: {
  readonly maintenanceCapabilities: ServerProviderShape["maintenanceCapabilities"];
  readonly getSettings: Effect.Effect<Settings>;
  readonly streamSettings: Stream.Stream<Settings>;
  readonly haveSettingsChanged: (previous: Settings, next: Settings) => boolean;
  readonly initialSnapshot: (settings: Settings) => ServerProvider;
  readonly checkProvider: Effect.Effect<ServerProvider, ServerSettingsError>;
  readonly enrichSnapshot?: (input: {
    readonly settings: Settings;
    readonly snapshot: ServerProvider;
    readonly getSnapshot: Effect.Effect<ServerProvider>;
    readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  }) => Effect.Effect<void>;
  readonly refreshInterval?: Duration.Input | null;
  readonly snapshotFreshness?: Duration.Input;
  readonly retainInventoryOnError?: boolean;
}): Effect.fn.Return<ServerProviderShape, ServerSettingsError, Scope.Scope> {
  const refreshSemaphore = yield* Semaphore.make(1);
  // Generation validation, snapshot mutation and stream publication are one commit.
  // Keep probes and enrichment teardown outside this short critical section.
  const publicationSemaphore = yield* Semaphore.make(1);
  const changesPubSub = yield* Effect.acquireRelease(
    PubSub.sliding<ServerProvider>(1),
    PubSub.shutdown,
  );
  const initialSettings = yield* input.getSettings;
  const initialSnapshot = input.initialSnapshot(initialSettings);
  const snapshotStateRef = yield* Ref.make<ProviderSnapshotState>({
    snapshot: initialSnapshot,
    enrichmentGeneration: 0,
    lastRefreshAttemptAtMs: null,
  });
  const settingsRef = yield* Ref.make(initialSettings);
  const enrichmentFiberRef = yield* Ref.make<Fiber.Fiber<void, unknown> | null>(null);
  const refreshFlightRef = yield* SynchronizedRef.make<Deferred.Deferred<
    ServerProvider,
    ServerSettingsError
  > | null>(null);
  const snapshotFreshnessMs = Duration.toMillis(
    Duration.fromInputUnsafe(input.snapshotFreshness ?? DEFAULT_SNAPSHOT_FRESHNESS),
  );
  const scope = yield* Effect.scope;

  const publishEnrichedSnapshot = Effect.fn("publishEnrichedSnapshot")(function* (
    generation: number,
    nextSnapshot: ServerProvider,
  ) {
    const snapshotToPublish = yield* Ref.modify(snapshotStateRef, (state) => {
      if (state.enrichmentGeneration !== generation || Equal.equals(state.snapshot, nextSnapshot)) {
        return [null, state] as const;
      }
      return [
        nextSnapshot,
        {
          ...state,
          snapshot: nextSnapshot,
        },
      ] as const;
    });
    if (snapshotToPublish === null) {
      return;
    }
    yield* PubSub.publish(changesPubSub, snapshotToPublish);
  }, publicationSemaphore.withPermits(1));

  const restartSnapshotEnrichment = Effect.fn("restartSnapshotEnrichment")(function* (
    settings: Settings,
    snapshot: ServerProvider,
    generation: number,
  ) {
    const previousFiber = yield* Ref.getAndSet(enrichmentFiberRef, null);
    if (previousFiber) {
      yield* Fiber.interrupt(previousFiber).pipe(Effect.ignore);
    }

    if (!input.enrichSnapshot) {
      return;
    }

    const fiber = yield* input
      .enrichSnapshot({
        settings,
        snapshot,
        getSnapshot: Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot)),
        publishSnapshot: (nextSnapshot) => publishEnrichedSnapshot(generation, nextSnapshot),
      })
      .pipe(
        ignoreProviderBackgroundCause("provider snapshot enrichment failed"),
        Effect.forkIn(scope),
      );

    yield* Ref.set(enrichmentFiberRef, fiber);
  });

  const applySnapshotBase = Effect.fn("applySnapshot")(function* (
    nextSettings: Settings,
    options?: { readonly forceRefresh?: boolean },
  ) {
    const forceRefresh = options?.forceRefresh === true;
    const previousSettings = yield* Ref.get(settingsRef);
    if (!forceRefresh && !input.haveSettingsChanged(previousSettings, nextSettings)) {
      yield* Ref.set(settingsRef, nextSettings);
      return yield* Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot));
    }

    const checkedSnapshot = yield* input.checkProvider.pipe(
      Effect.onExit(() =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((lastRefreshAttemptAtMs) =>
            Ref.update(snapshotStateRef, (state) => ({
              ...state,
              lastRefreshAttemptAtMs,
            })),
          ),
        ),
      ),
    );
    const [nextSnapshot, nextGeneration] = yield* publicationSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const previousSnapshot = yield* Ref.get(snapshotStateRef).pipe(
          Effect.map((state) => state.snapshot),
        );
        const nextSnapshot =
          input.retainInventoryOnError === true && checkedSnapshot.status === "error"
            ? {
                ...checkedSnapshot,
                models:
                  checkedSnapshot.models.length > 0
                    ? checkedSnapshot.models
                    : previousSnapshot.models,
                slashCommands:
                  checkedSnapshot.slashCommands.length > 0
                    ? checkedSnapshot.slashCommands
                    : previousSnapshot.slashCommands,
                skills:
                  checkedSnapshot.skills.length > 0
                    ? checkedSnapshot.skills
                    : previousSnapshot.skills,
              }
            : checkedSnapshot;
        const nextGeneration = yield* Ref.modify(snapshotStateRef, (state) => {
          const generation = input.enrichSnapshot
            ? state.enrichmentGeneration + 1
            : state.enrichmentGeneration;
          return [
            generation,
            {
              snapshot: nextSnapshot,
              enrichmentGeneration: generation,
              lastRefreshAttemptAtMs: state.lastRefreshAttemptAtMs,
            },
          ] as const;
        });
        yield* Ref.set(settingsRef, nextSettings);
        yield* PubSub.publish(changesPubSub, nextSnapshot);
        return [nextSnapshot, nextGeneration] as const;
      }),
    );
    yield* restartSnapshotEnrichment(nextSettings, nextSnapshot, nextGeneration);
    return nextSnapshot;
  });
  const applySnapshot = (nextSettings: Settings, options?: { readonly forceRefresh?: boolean }) =>
    refreshSemaphore.withPermits(1)(applySnapshotBase(nextSettings, options));

  const refreshSnapshot = Effect.fn("refreshSnapshot")(function* () {
    const candidate = yield* Deferred.make<ServerProvider, ServerSettingsError>();
    type RefreshSelection = {
      readonly deferred: Deferred.Deferred<ServerProvider, ServerSettingsError>;
      readonly owner: boolean;
    };
    const selection = yield* SynchronizedRef.modify(
      refreshFlightRef,
      (
        current,
      ): readonly [
        RefreshSelection,
        Deferred.Deferred<ServerProvider, ServerSettingsError> | null,
      ] => {
        if (current !== null) {
          return [{ deferred: current, owner: false }, current];
        }
        return [{ deferred: candidate, owner: true }, candidate];
      },
    );

    if (!selection.owner) {
      return yield* Deferred.await(selection.deferred);
    }

    const refresh = input.getSettings.pipe(
      Effect.flatMap((nextSettings) => applySnapshot(nextSettings, { forceRefresh: true })),
    );
    return yield* refresh.pipe(
      Effect.onExit((exit) =>
        Deferred.done(candidate, exit).pipe(
          Effect.andThen(
            SynchronizedRef.update(refreshFlightRef, (current) =>
              current === candidate ? null : current,
            ),
          ),
        ),
      ),
    );
  });

  const revalidateSnapshot = Effect.fn("revalidateSnapshot")(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const state = yield* Ref.get(snapshotStateRef);
    if (
      isProviderSnapshotFresh({
        lastRefreshAttemptAtMs: state.lastRefreshAttemptAtMs,
        nowMs,
        freshnessMs: snapshotFreshnessMs,
      })
    ) {
      return state.snapshot;
    }
    return yield* refreshSnapshot();
  });

  yield* Stream.runForEach(input.streamSettings, (nextSettings) =>
    Effect.asVoid(applySnapshot(nextSettings)),
  ).pipe(Effect.forkScoped);

  if (input.refreshInterval != null) {
    yield* Effect.forever(
      Effect.sleep(input.refreshInterval).pipe(
        Effect.flatMap(() => refreshSnapshot()),
        ignoreProviderBackgroundCause("provider automatic refresh failed"),
      ),
    ).pipe(Effect.forkScoped);
  }

  yield* refreshSnapshot().pipe(
    ignoreProviderBackgroundCause("provider initial refresh failed"),
    Effect.forkScoped,
  );

  return {
    maintenanceCapabilities: input.maintenanceCapabilities,
    getSnapshot: Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot)),
    revalidate: revalidateSnapshot().pipe(Effect.tapError(Effect.logError), Effect.orDie),
    refresh: refreshSnapshot().pipe(Effect.tapError(Effect.logError), Effect.orDie),
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
  } satisfies ServerProviderShape;
});
