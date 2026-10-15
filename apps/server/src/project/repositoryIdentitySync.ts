/**
 * RepositoryIdentitySync - keeps each project's persisted repository identity current.
 *
 * Shell snapshots and project lookups read the identity stored in `projection_projects` and never
 * wait on `git`. This background task resolves it instead: once after startup, again on a slow
 * interval, and whenever a project is created or its root moves. A cheap fingerprint of the
 * repository's git config (see `readRepositoryIdentityFingerprint`) decides when `git` has to run
 * at all, so a steady-state sweep is a few `stat` calls per project.
 *
 * When a stored identity changes, an empty `project.meta.update` is dispatched so every connected
 * client receives the project, with its new identity, through the ordinary event stream. An
 * update that changes nothing keeps the project's `updatedAt`, so this never reorders projects.
 *
 * Chat projects (Ryco-managed folders, never repositories) and roots that are currently missing
 * are skipped.
 *
 * A probe `git` could not answer (timeout, spawn failure) records nothing: the stored identity,
 * fingerprint and check time stay as they were, so the project is not shown as "no repository"
 * for a day. It is retried soon, backing off up to the sweep interval.
 *
 * @module RepositoryIdentitySync
 */
import {
  CommandId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type ProjectId,
} from "@ryco/contracts";
import { makeDrainableWorker } from "@ryco/shared/DrainableWorker";
import { isChatProject } from "@ryco/shared/projectKind";
import { losslessBackpressureQueuePolicy } from "@ryco/shared/QueuePolicy";
import { Cause, Duration, Effect, PubSub, Schedule, Scope, Semaphore, Stream } from "effect";

import type {
  ProjectionProjectRepositoryIdentityState,
  ProjectionProjectRepositoryShape,
} from "../persistence/Services/ProjectionProjects.ts";
import { inBackgroundProcessLane } from "../processGovernor.ts";
import type { RepositoryIdentityResolverShape } from "./Services/RepositoryIdentityResolver.ts";
import {
  encodePersistedRepositoryIdentity,
  readRepositoryIdentityFingerprint,
  samePersistedRepositoryIdentity,
} from "./repositoryIdentityPersistence.ts";

/** Steady-state revalidation: fingerprints only, `git` only for repositories that changed. */
export const REPOSITORY_IDENTITY_SWEEP_INTERVAL = Duration.minutes(30);
/** Resolve again even with an unchanged fingerprint (config includes, `insteadOf` rewrites). */
export const REPOSITORY_IDENTITY_MAX_AGE = Duration.hours(24);
/** First retry after a failed probe; doubles per consecutive failure, capped at the sweep. */
export const REPOSITORY_IDENTITY_RETRY_DELAY = Duration.minutes(1);

/** Delay before retry `attempt` (1-based) of a project whose probe failed. */
export const repositoryIdentityRetryDelay = (
  attempt: number,
  sweepInterval: Duration.Input = REPOSITORY_IDENTITY_SWEEP_INTERVAL,
): Duration.Duration =>
  Duration.millis(
    Math.min(
      Duration.toMillis(REPOSITORY_IDENTITY_RETRY_DELAY) * 2 ** Math.max(0, attempt - 1),
      Duration.toMillis(sweepInterval),
    ),
  );
const REPOSITORY_IDENTITY_SYNC_CONCURRENCY = 4;

export interface RepositoryIdentitySyncDependencies {
  readonly projects: Pick<
    ProjectionProjectRepositoryShape,
    "listRepositoryIdentityStates" | "recordRepositoryIdentity"
  >;
  readonly resolver: RepositoryIdentityResolverShape;
  /** Server-internal dispatch, used to announce a changed identity. */
  readonly dispatch: (
    command: OrchestrationCommand,
  ) => Effect.Effect<unknown, { readonly message: string }>;
  readonly readFingerprint?: (workspaceRoot: string) => Effect.Effect<string | null>;
  readonly now?: () => Date;
  readonly maxAge?: Duration.Input;
  /**
   * A project's probe failed `attempt` times in a row and nothing was recorded; schedule a retry.
   * Never called for a project whose last probe answered.
   */
  readonly onProbeFailed?: (projectId: ProjectId, attempt: number) => Effect.Effect<void>;
}

export interface RepositoryIdentitySyncResult {
  /** Active, non-chat projects whose root exists. */
  readonly checked: number;
  /** Of those, how many needed a `git` probe. */
  readonly resolved: number;
  /** Of those, how many stored a different identity (and were announced). */
  readonly changed: number;
  /** Of those checked, how many `git` could not answer (nothing recorded, retried). */
  readonly failed: number;
}

/** Whether a domain event can change which repository a project points at. */
export function repositoryIdentityTrigger(event: OrchestrationEvent): ProjectId | null {
  switch (event.type) {
    case "project.created":
      return event.payload.projectId;
    case "project.meta-updated":
      // Our own announcement carries neither field, so it never triggers another sync.
      return event.payload.workspaceRoot !== undefined || event.payload.kind !== undefined
        ? event.payload.projectId
        : null;
    default:
      return null;
  }
}

export const makeRepositoryIdentitySync = Effect.fn("makeRepositoryIdentitySync")(function* (
  deps: RepositoryIdentitySyncDependencies,
) {
  // One pass at a time: a sweep and an event-triggered sync never probe the same root twice.
  const lock = yield* Semaphore.make(1);
  const readFingerprint =
    deps.readFingerprint ??
    ((workspaceRoot: string) =>
      Effect.promise(() => readRepositoryIdentityFingerprint(workspaceRoot)));
  const now = deps.now ?? (() => new Date());
  const maxAgeMs = Duration.toMillis(deps.maxAge ?? REPOSITORY_IDENTITY_MAX_AGE);
  const resolveFresh = deps.resolver.refresh ?? deps.resolver.resolve;
  /** Consecutive failed probes per project, cleared once its probe answers. */
  const failedAttempts = new Map<ProjectId, number>();

  /** "skipped" | "fresh" | "resolved" | "changed" | "failed" */
  const syncProject = (state: ProjectionProjectRepositoryIdentityState) =>
    Effect.gen(function* () {
      if (isChatProject(state)) return "skipped" as const;
      const fingerprint = yield* readFingerprint(state.workspaceRoot);
      if (fingerprint === null) return "skipped" as const;
      const checkedAtMs = state.checkedAt === null ? Number.NaN : Date.parse(state.checkedAt);
      const startedAt = now();
      if (
        state.fingerprint === fingerprint &&
        Number.isFinite(checkedAtMs) &&
        startedAt.getTime() - checkedAtMs < maxAgeMs
      ) {
        return "fresh" as const;
      }
      // Never what a user waits on: its `git` yields to interactive work.
      const probed = yield* inBackgroundProcessLane(resolveFresh(state.workspaceRoot)).pipe(
        Effect.map((identity) => ({ ok: true as const, identity })),
        Effect.catchTag("RepositoryIdentityProbeError", (error) =>
          Effect.succeed({ ok: false as const, detail: error.message }),
        ),
      );
      if (!probed.ok) {
        // Keep what was known (and its check time, so the next sweep retries too).
        const attempt = (failedAttempts.get(state.projectId) ?? 0) + 1;
        failedAttempts.set(state.projectId, attempt);
        yield* Effect.logWarning("repository identity probe failed; keeping the stored identity", {
          projectId: state.projectId,
          attempt,
          detail: probed.detail,
        });
        if (deps.onProbeFailed !== undefined) {
          yield* deps.onProbeFailed(state.projectId, attempt);
        }
        return "failed" as const;
      }
      failedAttempts.delete(state.projectId);
      const identityJson = encodePersistedRepositoryIdentity(probed.identity);
      const recorded = yield* deps.projects.recordRepositoryIdentity({
        projectId: state.projectId,
        workspaceRoot: state.workspaceRoot,
        repositoryIdentityJson: identityJson,
        fingerprint,
        checkedAt: startedAt.toISOString(),
      });
      // A first resolution to "no repository" is not news; anything else that differs is.
      if (
        !recorded ||
        samePersistedRepositoryIdentity(state.repositoryIdentityJson, identityJson)
      ) {
        return "resolved" as const;
      }
      yield* deps
        .dispatch({
          type: "project.meta.update",
          commandId: CommandId.make(`server:repository-identity:${crypto.randomUUID()}`),
          projectId: state.projectId,
        })
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("could not announce a changed repository identity", {
              projectId: state.projectId,
              cause: cause.message,
            }),
          ),
        );
      return "changed" as const;
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("repository identity sync failed for a project", {
              projectId: state.projectId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as("skipped" as const)),
      ),
    );

  /** Sync one project, or every active project when `projectId` is absent. Never fails. */
  const sync = (projectId?: ProjectId) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const states = yield* deps.projects.listRepositoryIdentityStates(
            projectId === undefined ? {} : { projectId },
          );
          const outcomes = yield* Effect.forEach(states, syncProject, {
            concurrency: REPOSITORY_IDENTITY_SYNC_CONCURRENCY,
          });
          const result: RepositoryIdentitySyncResult = {
            checked: outcomes.filter((outcome) => outcome !== "skipped").length,
            resolved: outcomes.filter((outcome) => outcome === "resolved" || outcome === "changed")
              .length,
            changed: outcomes.filter((outcome) => outcome === "changed").length,
            failed: outcomes.filter((outcome) => outcome === "failed").length,
          };
          if (result.resolved > 0) {
            yield* Effect.logDebug("repository identities resolved", result);
          }
          return result;
        }),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("repository identity sync failed", {
                cause: Cause.pretty(cause),
              }).pipe(
                Effect.as<RepositoryIdentitySyncResult>({
                  checked: 0,
                  resolved: 0,
                  changed: 0,
                  failed: 0,
                }),
              ),
        ),
      );

  return { sync };
});

/**
 * Run the sync for the server's lifetime: projects created or moved are synced as their events
 * arrive, every project once now and then every {@link REPOSITORY_IDENTITY_SWEEP_INTERVAL}, and a
 * project whose probe failed again after {@link repositoryIdentityRetryDelay}.
 * `drain` waits until every triggered project handed off so far has been synced (tests).
 */
export const runRepositoryIdentitySync = (
  deps: RepositoryIdentitySyncDependencies & {
    /** Acquired before the first sweep, so no project created meanwhile is missed. */
    readonly subscribe: Effect.Effect<PubSub.Subscription<OrchestrationEvent>, never, Scope.Scope>;
    readonly sweepInterval?: Duration.Input;
  },
) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const sweepInterval = deps.sweepInterval ?? REPOSITORY_IDENTITY_SWEEP_INTERVAL;
    // One pending retry per project: a sweep failing meanwhile does not stack another.
    const pendingRetries = new Set<ProjectId>();
    const scheduleRetry = (projectId: ProjectId, attempt: number): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (pendingRetries.has(projectId)) return Effect.void;
        pendingRetries.add(projectId);
        return Effect.sleep(repositoryIdentityRetryDelay(attempt, sweepInterval)).pipe(
          Effect.andThen(Effect.sync(() => pendingRetries.delete(projectId))),
          Effect.andThen(worker.enqueue(projectId)),
          Effect.forkIn(scope),
          Effect.asVoid,
        );
      });
    const { sync } = yield* makeRepositoryIdentitySync({ ...deps, onProbeFailed: scheduleRetry });
    // The domain-event subscription is backpressured: a subscriber stuck behind a sweep (or a
    // slow `git`) would eventually stall the engine's publishing. Hand triggered projects to a
    // worker instead and keep the subscriber at the speed of the event stream.
    const worker = yield* makeDrainableWorker({
      policy: losslessBackpressureQueuePolicy({
        component: "RepositoryIdentitySync",
        capacity: 256,
      }),
      process: (projectId: ProjectId) => sync(projectId).pipe(Effect.asVoid),
    });
    const subscription = yield* deps.subscribe;
    yield* Effect.forkScoped(
      Stream.runForEach(Stream.fromSubscription(subscription), (event) => {
        const projectId = repositoryIdentityTrigger(event);
        return projectId === null ? Effect.void : worker.enqueue(projectId);
      }),
    );
    yield* Effect.forkScoped(sync().pipe(Effect.repeat(Schedule.spaced(sweepInterval))));
    return { drain: worker.drain };
  });
