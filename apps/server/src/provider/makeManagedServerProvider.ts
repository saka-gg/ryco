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
  /** Set when a fingerprint-matched persisted snapshot was adopted instead of probing. */
  readonly persistedFreshUntilMs: number | null;
  /**
   * While an adopted snapshot's usage limits are re-read on their own (`refreshUsage`): until
   * when the last read stays current. Cleared by a probe, which reads usage itself.
   */
  readonly usageFreshUntilMs: number | null;
}

const DEFAULT_SNAPSHOT_FRESHNESS = Duration.minutes(5);
/**
 * How long a persisted snapshot whose probe fingerprint still matches stands in for a probe.
 * Models, slash commands and account data change rarely; an explicit refresh always re-probes.
 * Usage limits keep the regular `snapshotFreshness` window: a driver with `refreshUsage`
 * re-reads only them, and without it a snapshot carrying them gets only that window.
 */
const DEFAULT_PERSISTED_SNAPSHOT_FRESHNESS = Duration.hours(6);

export const isProviderSnapshotFresh = (input: {
  readonly lastRefreshAttemptAtMs: number | null;
  readonly nowMs: number;
  readonly freshnessMs: number;
}): boolean =>
  input.lastRefreshAttemptAtMs !== null &&
  input.nowMs - input.lastRefreshAttemptAtMs < input.freshnessMs;

/**
 * Managed provider snapshot: single-flight probes, settings-driven re-checks, enrichment and
 * freshness bookkeeping. Construction never probes — `ProviderRegistry` decides when a probe is
 * worth running (client demand, explicit refresh, settings rebuild), so building every configured
 * instance at boot spawns nothing.
 */
export const makeManagedServerProvider = Effect.fn("makeManagedServerProvider")(function* <
  Settings,
>(input: {
  readonly maintenanceCapabilities: ServerProviderShape["maintenanceCapabilities"];
  readonly probeFingerprint?: ServerProviderShape["probeFingerprint"];
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
  /**
   * Re-reads only the usage limits of `snapshot`, without a CLI run or SDK session: the
   * snapshot with its new limits, or without any when none could be read. Lets an adopted
   * persisted snapshot stay fresh for `persistedSnapshotFreshness` while its usage keeps the
   * `snapshotFreshness` window. Must not fail.
   */
  readonly refreshUsage?: (snapshot: ServerProvider) => Effect.Effect<ServerProvider>;
  readonly refreshInterval?: Duration.Input | null;
  readonly snapshotFreshness?: Duration.Input;
  readonly persistedSnapshotFreshness?: Duration.Input;
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
    persistedFreshUntilMs: null,
    usageFreshUntilMs: null,
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
  const persistedSnapshotFreshnessMs = Duration.toMillis(
    Duration.fromInputUnsafe(
      input.persistedSnapshotFreshness ?? DEFAULT_PERSISTED_SNAPSHOT_FRESHNESS,
    ),
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
              persistedFreshUntilMs: null,
              usageFreshUntilMs: null,
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
              ...state,
              snapshot: nextSnapshot,
              enrichmentGeneration: generation,
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

  const isProbedSnapshotFresh = (state: ProviderSnapshotState, nowMs: number) =>
    isProviderSnapshotFresh({
      lastRefreshAttemptAtMs: state.lastRefreshAttemptAtMs,
      nowMs,
      freshnessMs: snapshotFreshnessMs,
    });

  const isAdoptedSnapshotFresh = (state: ProviderSnapshotState, nowMs: number) =>
    state.persistedFreshUntilMs !== null && nowMs < state.persistedFreshUntilMs;

  /** Whether `revalidate` needs no full probe; it may still re-read usage limits. */
  const isSnapshotProbeFresh = (state: ProviderSnapshotState, nowMs: number) =>
    isProbedSnapshotFresh(state, nowMs) || isAdoptedSnapshotFresh(state, nowMs);

  const isSnapshotFresh = (state: ProviderSnapshotState, nowMs: number) =>
    isProbedSnapshotFresh(state, nowMs) ||
    (isAdoptedSnapshotFresh(state, nowMs) &&
      (state.usageFreshUntilMs === null || nowMs < state.usageFreshUntilMs));

  const isFresh = Effect.all([Ref.get(snapshotStateRef), Clock.currentTimeMillis]).pipe(
    Effect.map(([state, nowMs]) => isSnapshotFresh(state, nowMs)),
  );

  const isProbeFresh = Effect.all([Ref.get(snapshotStateRef), Clock.currentTimeMillis]).pipe(
    Effect.map(([state, nowMs]) => isSnapshotProbeFresh(state, nowMs)),
  );

  // Serialized with probes and adoption, so concurrent callers re-read usage once: the later ones
  // find it current. Undefined when the adopted window ended meanwhile and a probe is due.
  const revalidateUsage = (refreshUsage: NonNullable<typeof input.refreshUsage>) =>
    refreshSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        const state = yield* Ref.get(snapshotStateRef);
        if (isSnapshotFresh(state, nowMs)) {
          return state.snapshot;
        }
        if (!isAdoptedSnapshotFresh(state, nowMs)) {
          return undefined;
        }
        const refreshed = yield* refreshUsage(state.snapshot);
        const readAtMs = yield* Clock.currentTimeMillis;
        return yield* publicationSemaphore.withPermits(1)(
          Effect.gen(function* () {
            const previous = yield* Ref.getAndUpdate(snapshotStateRef, (current) => ({
              ...current,
              snapshot: refreshed,
              usageFreshUntilMs: readAtMs + snapshotFreshnessMs,
            }));
            if (!Equal.equals(previous.snapshot, refreshed)) {
              yield* PubSub.publish(changesPubSub, refreshed);
            }
            return refreshed;
          }),
        );
      }),
    );

  const revalidateSnapshot = Effect.fn("revalidateSnapshot")(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const state = yield* Ref.get(snapshotStateRef);
    if (isSnapshotFresh(state, nowMs)) {
      return state.snapshot;
    }
    if (input.refreshUsage && isAdoptedSnapshotFresh(state, nowMs)) {
      const refreshed = yield* revalidateUsage(input.refreshUsage);
      if (refreshed !== undefined) {
        return refreshed;
      }
    }
    return yield* refreshSnapshot();
  });

  // Serialized with probes: a source that already probed (or is probing) keeps its own result.
  // Usage limits are live account state the UI renders as current (they carry no timestamp), so
  // they stay current only as long as a probed snapshot's would: re-read on their own with
  // `refreshUsage`, otherwise by a probe once the snapshot falls back to that window.
  const adoptPersistedSnapshot = (adopted: {
    readonly snapshot: ServerProvider;
    readonly checkedAtMs: number;
  }) =>
    refreshSemaphore.withPermits(1)(
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((nowMs) =>
          Ref.modify(snapshotStateRef, (state) => {
            if (state.lastRefreshAttemptAtMs !== null) {
              return [false, state] as const;
            }
            // A `checkedAt` from the future (clock change) never extends the window.
            const checkedAtMs = Math.min(adopted.checkedAtMs, nowMs);
            const carriesUsage = adopted.snapshot.rateLimits !== undefined;
            const freshnessMs =
              carriesUsage && input.refreshUsage === undefined
                ? snapshotFreshnessMs
                : persistedSnapshotFreshnessMs;
            return [
              true,
              {
                ...state,
                snapshot: adopted.snapshot,
                persistedFreshUntilMs: checkedAtMs + freshnessMs,
                usageFreshUntilMs:
                  carriesUsage && input.refreshUsage !== undefined
                    ? checkedAtMs + snapshotFreshnessMs
                    : null,
              },
            ] as const;
          }),
        ),
      ),
    );

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

  return {
    maintenanceCapabilities: input.maintenanceCapabilities,
    ...(input.probeFingerprint ? { probeFingerprint: input.probeFingerprint } : {}),
    adoptPersistedSnapshot,
    getSnapshot: Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot)),
    revalidate: revalidateSnapshot().pipe(Effect.tapError(Effect.logError), Effect.orDie),
    isFresh,
    isProbeFresh,
    refresh: refreshSnapshot().pipe(Effect.tapError(Effect.logError), Effect.orDie),
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
  } satisfies ServerProviderShape;
});
